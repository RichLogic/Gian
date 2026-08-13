import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
export const APP_MANIFESTS = [
  'package.json',
  'packages/desktop/package.json',
  'packages/host/package.json',
  'packages/shared/package.json',
  'packages/web/package.json',
];
export const INDEPENDENT_MANIFESTS = [
  'packages/proxy-protocol/package.json',
  'packages/proxies/cc-proxy/package.json',
  'packages/proxies/codex-proxy/package.json',
  'packages/proxies/kimi-proxy/package.json',
  'packages/proxies/grok-proxy/package.json',
];
const VERSION_RE = /^\d+\.\d+\.\d+(?:-hotfix)?$/;
const INDEPENDENT_VERSION_RE = /^\d+\.\d+\.\d+$/;
const HOTFIX_PROTECTED_PREFIXES = [
  'packages/proxies/',
  'packages/proxy-protocol/',
  'packages/shared/',
];

export function validateVersionConsistency({
  manifests,
  changelog,
  releaseRef,
  hotfixChangedFiles,
  hotfixBaseAvailable = true,
}) {
  const errors = [];
  const appVersion = manifests['package.json'];
  if (!VERSION_RE.test(appVersion ?? '')) errors.push(`invalid app version: ${appVersion ?? '<missing>'}`);
  for (const path of APP_MANIFESTS) {
    if (manifests[path] !== appVersion) {
      errors.push(`${path} version ${manifests[path] ?? '<missing>'} does not match ${appVersion}`);
    }
  }
  for (const path of INDEPENDENT_MANIFESTS) {
    if (!INDEPENDENT_VERSION_RE.test(manifests[path] ?? '')) {
      errors.push(`${path} has invalid independent version ${manifests[path] ?? '<missing>'}`);
    }
  }
  const latestChangelog = changelog.match(/^## \[([^\]]+)\]/m)?.[1];
  if (latestChangelog !== appVersion) {
    errors.push(`latest CHANGELOG version ${latestChangelog ?? '<missing>'} does not match ${appVersion}`);
  }
  if (releaseRef && releaseRef !== `v${appVersion}`) {
    errors.push(`release ref ${releaseRef} does not match v${appVersion}`);
  }
  if (appVersion?.endsWith('-hotfix')) {
    if (!hotfixBaseAvailable) errors.push(`hotfix base tag v${appVersion.slice(0, -'-hotfix'.length)} is unavailable`);
    const protectedChanges = (hotfixChangedFiles ?? [])
      .filter(path => HOTFIX_PROTECTED_PREFIXES.some(prefix => path.startsWith(prefix)));
    if (protectedChanges.length > 0) {
      errors.push(`hotfix changes Proxy/protocol inputs: ${protectedChanges.join(', ')}`);
    }
  }
  return errors;
}

function git(args) {
  return spawnSync('git', args, { cwd: rootDir, encoding: 'utf8' });
}

function loadManifestVersions() {
  return Object.fromEntries([...APP_MANIFESTS, ...INDEPENDENT_MANIFESTS].map(path => [
    path,
    JSON.parse(readFileSync(join(rootDir, path), 'utf8')).version,
  ]));
}

export function main(argv = process.argv.slice(2)) {
  const releaseIndex = argv.indexOf('--release-ref');
  const releaseRef = releaseIndex >= 0 ? argv[releaseIndex + 1] : undefined;
  if (releaseIndex >= 0 && !releaseRef) throw new Error('--release-ref requires a value');
  const manifests = loadManifestVersions();
  const appVersion = manifests['package.json'];
  let hotfixBaseAvailable = true;
  let hotfixChangedFiles = [];
  if (appVersion.endsWith('-hotfix')) {
    const baseTag = `v${appVersion.slice(0, -'-hotfix'.length)}`;
    hotfixBaseAvailable = git(['rev-parse', '--verify', `${baseTag}^{commit}`]).status === 0;
    if (hotfixBaseAvailable) {
      const diff = git(['diff', '--name-only', baseTag, '--']);
      if (diff.status !== 0) throw new Error(diff.stderr.trim() || 'unable to inspect hotfix changes');
      hotfixChangedFiles = diff.stdout.split('\n').filter(Boolean);
    }
  }
  const errors = validateVersionConsistency({
    manifests,
    changelog: readFileSync(join(rootDir, 'CHANGELOG.md'), 'utf8'),
    releaseRef,
    hotfixBaseAvailable,
    hotfixChangedFiles,
  });
  if (errors.length > 0) throw new Error(`version consistency failed:\n- ${errors.join('\n- ')}`);
  console.log(`version consistency: ${appVersion}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
