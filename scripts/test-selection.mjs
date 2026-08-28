import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadValidatedCatalog } from './test-catalog.mjs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const selectionMapPath = join(rootDir, 'test', 'selection-map.json');
const TEST_SCOPES = new Set(['unit', 'integration', 'system']);

function normalizePath(path) {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`invalid changed path: ${path}`);
  }
  return normalized;
}

function globRegex(pattern) {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
    } else if (char === '*') {
      source += '[^/]*';
    } else {
      source += /[.+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
    }
  }
  return new RegExp(`${source}$`);
}

export function matchesSelectionPattern(path, pattern) {
  return globRegex(pattern).test(path);
}

function isInternalDocsPattern(pattern) {
  return pattern === 'docs' || pattern.startsWith('docs/');
}

function walk(directory, baseDir, output = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute, baseDir, output);
    else if (entry.isFile()) output.push(relative(baseDir, absolute).replaceAll('\\', '/'));
  }
  return output;
}

function requireStringArray(value, field, owner, allowEmpty = false) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)
    || value.some(item => typeof item !== 'string' || !item)) {
    throw new Error(`${owner} must provide ${allowEmpty ? 'a' : 'a non-empty'} string array ${field}`);
  }
}

export function validateSelectionMap(map, {
  entries,
  packageScripts,
  specialEntrypoints,
  repositoryPaths,
}) {
  if (map.version !== 1) throw new Error(`unsupported selection map version: ${map.version}`);
  const knownModules = new Set(entries.filter(entry => TEST_SCOPES.has(entry.scope)).map(entry => entry.module));
  const knownSpecials = new Set(specialEntrypoints.map(entry => entry.id));
  const ruleIds = new Set();

  for (const [stage, config] of Object.entries(map.stages ?? {})) {
    requireStringArray(config.runScopes, 'runScopes', `stage ${stage}`);
    if (config.runScopes.some(scope => !TEST_SCOPES.has(scope))) {
      throw new Error(`stage ${stage} has an invalid run scope`);
    }
  }
  if (!map.stages?.quick || !map.stages?.merge) throw new Error('selection map requires quick and merge stages');

  for (const rule of map.rules ?? []) {
    if (typeof rule.id !== 'string' || !rule.id) throw new Error('selection rule id is required');
    if (ruleIds.has(rule.id)) throw new Error(`duplicate selection rule id: ${rule.id}`);
    ruleIds.add(rule.id);
    requireStringArray(rule.patterns, 'patterns', `selection rule ${rule.id}`);
    requireStringArray(rule.optionalPatterns ?? [], 'optionalPatterns', `selection rule ${rule.id}`, true);
    requireStringArray(rule.modules, 'modules', `selection rule ${rule.id}`, true);
    requireStringArray(rule.scopes, 'scopes', `selection rule ${rule.id}`, true);
    requireStringArray(rule.checks, 'checks', `selection rule ${rule.id}`, true);
    if (rule.modules.some(module => !knownModules.has(module))) {
      throw new Error(`selection rule ${rule.id} references an unknown module`);
    }
    if (rule.scopes.some(scope => !TEST_SCOPES.has(scope))) {
      throw new Error(`selection rule ${rule.id} references an invalid scope`);
    }
    if (rule.checks.some(check => typeof packageScripts[check] !== 'string')) {
      throw new Error(`selection rule ${rule.id} references an unknown package script`);
    }
    if ((rule.specialEntrypoints ?? []).some(id => !knownSpecials.has(id))) {
      throw new Error(`selection rule ${rule.id} references an unknown special entrypoint`);
    }
    if (typeof rule.reason !== 'string' || !rule.reason) {
      throw new Error(`selection rule ${rule.id} must provide a reason`);
    }
    const optionalPatterns = new Set(rule.optionalPatterns ?? []);
    const unknownOptionalPatterns = [...optionalPatterns].filter(pattern => !rule.patterns.includes(pattern));
    if (unknownOptionalPatterns.length > 0) {
      throw new Error(`selection rule ${rule.id} has optional patterns outside patterns: ${unknownOptionalPatterns.join(', ')}`);
    }
    const unmarkedDocsPatterns = rule.patterns.filter(pattern => (
      isInternalDocsPattern(pattern) && !optionalPatterns.has(pattern)
    ));
    if (unmarkedDocsPatterns.length > 0) {
      throw new Error(`selection rule ${rule.id} must mark docs patterns as optional: ${unmarkedDocsPatterns.join(', ')}`);
    }
    const stale = rule.patterns.filter(pattern => (
      !optionalPatterns.has(pattern)
      && !repositoryPaths.some(path => matchesSelectionPattern(path, pattern))
    ));
    if (stale.length > 0) throw new Error(`selection rule ${rule.id} has stale patterns: ${stale.join(', ')}`);
  }
  return map;
}

export function loadSelectionInputs(baseDir = rootDir) {
  const { catalog, entries } = loadValidatedCatalog(baseDir);
  const map = JSON.parse(readFileSync(join(baseDir, 'test', 'selection-map.json'), 'utf8'));
  const packageJson = JSON.parse(readFileSync(join(baseDir, 'package.json'), 'utf8'));
  const repositoryPaths = walk(baseDir, baseDir);
  validateSelectionMap(map, {
    entries,
    packageScripts: packageJson.scripts,
    specialEntrypoints: catalog.specialEntrypoints ?? [],
    repositoryPaths,
  });
  return { catalog, entries, map };
}

function addReason(reasonsByPath, path, reason) {
  const reasons = reasonsByPath.get(path) ?? new Set();
  reasons.add(reason);
  reasonsByPath.set(path, reasons);
}

export function buildAffectedPlan(changedFiles, stage = 'quick', inputs = loadSelectionInputs()) {
  const { catalog, entries, map } = inputs;
  const stageConfig = map.stages[stage];
  if (!stageConfig) throw new Error(`unsupported affected-test stage: ${stage}`);
  const paths = [...new Set(changedFiles.map(normalizePath))].sort();
  if (paths.length === 0) throw new Error('affected-test selection requires at least one changed file');

  const entriesByPath = new Map(entries.map(entry => [entry.path, entry]));
  const reasonsByPath = new Map();
  const matchedRules = [];
  const checks = new Map();
  const specials = new Map();
  let fallbackFull = false;

  for (const path of paths) {
    const direct = entriesByPath.get(path);
    if (direct) {
      if (direct.scope === 'e2e') {
        specials.set('test:e2e', {
          id: 'test:e2e',
          path: direct.path,
          reason: `Changed E2E spec: ${path}`,
        });
      } else {
        addReason(reasonsByPath, direct.path, `Directly changed test: ${path}`);
      }
      continue;
    }

    const rules = map.rules.filter(rule => rule.patterns.some(pattern => matchesSelectionPattern(path, pattern)));
    if (rules.length === 0) {
      fallbackFull = true;
      matchedRules.push({ file: path, rule: 'unknown-path-fallback', reason: 'No maintained mapping matched; selected the full deterministic suite.' });
      for (const entry of entries) {
        if (TEST_SCOPES.has(entry.scope)) addReason(reasonsByPath, entry.path, `Unknown changed path fallback: ${path}`);
      }
      for (const check of ['typecheck', 'quality:test-catalog', 'quality:traceability', 'quality:docs']) {
        addReason(checks, check, `Unknown changed path fallback: ${path}`);
      }
      continue;
    }

    for (const rule of rules) {
      matchedRules.push({ file: path, rule: rule.id, reason: rule.reason });
      for (const entry of entries) {
        if (rule.modules.includes(entry.module) && rule.scopes.includes(entry.scope)) {
          addReason(reasonsByPath, entry.path, `${rule.id}: ${rule.reason}`);
        }
      }
      for (const check of rule.checks) addReason(checks, check, `${rule.id}: ${rule.reason}`);
      for (const id of rule.specialEntrypoints ?? []) {
        const entrypoint = catalog.specialEntrypoints.find(entry => entry.id === id);
        specials.set(id, { ...entrypoint, reason: `${rule.id}: ${rule.reason}` });
      }
    }
  }

  const runScopes = new Set(stageConfig.runScopes);
  const selectedTests = [...reasonsByPath]
    .map(([path, reasons]) => ({ ...entriesByPath.get(path), reasons: [...reasons].sort() }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const runnableTests = selectedTests.filter(entry => runScopes.has(entry.scope));
  const deferredTests = selectedTests.filter(entry => !runScopes.has(entry.scope));
  return {
    version: 1,
    stage,
    changedFiles: paths,
    matchedRules,
    fallbackFull,
    runScopes: [...stageConfig.runScopes],
    runnableTests,
    deferredTests,
    checks: [...checks].map(([id, reasons]) => ({ id, reasons: [...reasons].sort() })),
    deferredEntrypoints: [...specials.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function checkSelectionMap(baseDir = rootDir) {
  loadSelectionInputs(baseDir);
  if (!existsSync(selectionMapPath) && baseDir === rootDir) throw new Error('selection map does not exist');
}
