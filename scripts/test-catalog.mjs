import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
export const catalogPath = join(rootDir, 'test', 'catalog.json');

const SCOPES = new Set(['unit', 'integration', 'system', 'e2e']);
const DEFAULT_SCOPE_PROHIBITIONS = new Set([
  'credentials',
  'fixed-production-port',
  'network',
  'production-data',
  'quota',
  'real-provider',
  'user-visible-os',
]);

function normalizedPath(path) {
  return path.split(sep).join('/');
}

function patternRegex(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replaceAll('*', '[^/]*')}$`);
}

export function matchesPattern(path, pattern) {
  return patternRegex(pattern).test(path);
}

function walk(directory, output = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute, output);
    else if (entry.isFile()) output.push(absolute);
  }
  return output;
}

function isStandardTestPath(path) {
  if (path.startsWith('e2e/specs/')) return path.endsWith('.spec.ts');
  if (path.startsWith('scripts/')) return path.endsWith('.test.mjs');
  return /\/test\/.*\.test\.(?:mjs|ts|tsx)$/.test(`/${path}`);
}

export function discoverStandardTests(catalog, baseDir = rootDir) {
  const paths = [];
  const optionalRoots = new Set(catalog.optionalDiscoveryRoots ?? []);
  for (const discoveryRoot of catalog.discoveryRoots ?? []) {
    const absolute = resolve(baseDir, discoveryRoot);
    if (!existsSync(absolute)) {
      if (optionalRoots.has(discoveryRoot)) continue;
      throw new Error(`test discovery root does not exist: ${discoveryRoot}`);
    }
    for (const file of walk(absolute)) {
      const path = normalizedPath(relative(baseDir, file));
      if (isStandardTestPath(path)) paths.push(path);
    }
  }
  return paths.sort();
}

function requireStringArray(value, field, groupId) {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string')) {
    throw new Error(`catalog group ${groupId} must provide non-empty string array ${field}`);
  }
}

export function validateCatalog(catalog, discoveredPaths, baseDir = rootDir) {
  if (catalog.version !== 1) throw new Error(`unsupported test catalog version: ${catalog.version}`);
  requireStringArray(catalog.defaultScopes, 'defaultScopes', '<root>');
  requireStringArray(catalog.fullScopes, 'fullScopes', '<root>');
  if (catalog.defaultScopes.some(scope => !SCOPES.has(scope) || scope === 'system' || scope === 'e2e')) {
    throw new Error('defaultScopes may only contain unit and integration');
  }
  if (!catalog.fullScopes.includes('system')) {
    throw new Error('fullScopes must include the explicit system layer');
  }

  const groupIds = new Set();
  for (const group of catalog.groups ?? []) {
    if (typeof group.id !== 'string' || !group.id) throw new Error('catalog group id is required');
    if (groupIds.has(group.id)) throw new Error(`duplicate catalog group id: ${group.id}`);
    groupIds.add(group.id);
    requireStringArray(group.patterns, 'patterns', group.id);
    requireStringArray(group.purposes, 'purposes', group.id);
    requireStringArray(group.sideEffects, 'sideEffects', group.id);
    requireStringArray(group.platforms, 'platforms', group.id);
    if (!SCOPES.has(group.scope)) throw new Error(`catalog group ${group.id} has invalid scope ${group.scope}`);
    if (typeof group.module !== 'string' || !group.module) throw new Error(`catalog group ${group.id} has no module`);
    if (typeof group.runner !== 'string' || !group.runner) throw new Error(`catalog group ${group.id} has no runner`);
    if (catalog.defaultScopes.includes(group.scope)) {
      const unsafe = group.sideEffects.filter(effect => DEFAULT_SCOPE_PROHIBITIONS.has(effect));
      if (unsafe.length > 0) {
        throw new Error(`default-scope group ${group.id} declares forbidden side effects: ${unsafe.join(', ')}`);
      }
    }
  }

  const duplicateDiscovered = discoveredPaths.filter((path, index) => discoveredPaths.indexOf(path) !== index);
  if (duplicateDiscovered.length > 0) {
    throw new Error(`duplicate discovered test paths: ${[...new Set(duplicateDiscovered)].join(', ')}`);
  }

  const entries = [];
  const unclassified = [];
  const multiplyClassified = [];
  for (const path of [...discoveredPaths].sort()) {
    const matches = catalog.groups.filter(group => {
      const included = group.patterns.some(pattern => matchesPattern(path, pattern));
      const excluded = (group.exclude ?? []).some(pattern => matchesPattern(path, pattern));
      return included && !excluded;
    });
    if (matches.length === 0) {
      unclassified.push(path);
      continue;
    }
    if (matches.length > 1) {
      multiplyClassified.push(`${path} (${matches.map(group => group.id).join(', ')})`);
      continue;
    }
    const group = matches[0];
    entries.push({
      path,
      module: group.module,
      scope: group.scope,
      purposes: [...group.purposes],
      sideEffects: [...group.sideEffects],
      platforms: [...group.platforms],
      runner: group.runner,
      group: group.id,
    });
  }
  if (unclassified.length > 0) throw new Error(`unclassified test paths:\n${unclassified.join('\n')}`);
  if (multiplyClassified.length > 0) {
    throw new Error(`multiply classified test paths:\n${multiplyClassified.join('\n')}`);
  }

  const matchedPatterns = new Set();
  for (const entry of entries) {
    const group = catalog.groups.find(candidate => candidate.id === entry.group);
    for (const pattern of group.patterns) {
      if (matchesPattern(entry.path, pattern)) matchedPatterns.add(`${group.id}:${pattern}`);
    }
  }
  const stalePatterns = [];
  const missingOptionalRoots = (catalog.optionalDiscoveryRoots ?? [])
    .filter(discoveryRoot => !existsSync(resolve(baseDir, discoveryRoot)));
  for (const group of catalog.groups) {
    for (const pattern of group.patterns) {
      const belongsToMissingOptionalRoot = missingOptionalRoots.some(discoveryRoot => (
        pattern === discoveryRoot || pattern.startsWith(`${discoveryRoot}/`)
      ));
      if (!matchedPatterns.has(`${group.id}:${pattern}`) && !belongsToMissingOptionalRoot) {
        stalePatterns.push(`${group.id}: ${pattern}`);
      }
    }
  }
  if (stalePatterns.length > 0) throw new Error(`catalog patterns match no tests:\n${stalePatterns.join('\n')}`);

  for (const entrypoint of catalog.specialEntrypoints ?? []) {
    if (typeof entrypoint.path !== 'string') throw new Error(`special entrypoint ${entrypoint.id} has no path`);
    const filePath = entrypoint.path.split('#', 1)[0];
    if (!existsSync(resolve(baseDir, filePath))) {
      throw new Error(`special entrypoint does not exist: ${entrypoint.path}`);
    }
  }
  return entries;
}

export function loadCatalog(path = catalogPath) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function loadValidatedCatalog(baseDir = rootDir) {
  const catalog = loadCatalog(join(baseDir, 'test', 'catalog.json'));
  const discovered = discoverStandardTests(catalog, baseDir);
  return { catalog, entries: validateCatalog(catalog, discovered, baseDir) };
}

function counts(entries) {
  const result = { unit: 0, integration: 0, system: 0, e2e: 0 };
  for (const entry of entries) result[entry.scope] += 1;
  return result;
}

export function main() {
  const { catalog, entries } = loadValidatedCatalog();
  const summary = counts(entries);
  console.log(`test-catalog: ${entries.length} standard test file(s) classified`);
  console.log(`unit=${summary.unit} integration=${summary.integration} system=${summary.system} e2e=${summary.e2e}`);
  console.log(`default=${catalog.defaultScopes.join(',')} full=${catalog.fullScopes.join(',')}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
