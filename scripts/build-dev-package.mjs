import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertExecutionAllowed } from './execution-policy.mjs';
import { devPackageConfiguration, requireDevOAuthClientId } from './dev-package-config.mjs';

const localBuild = process.env.GIAN_ALLOW_LOCAL_DEV_PACKAGE === '1';
assertExecutionAllowed(localBuild ? 'dev-package-local' : 'package');
process.env.GIAN_GITHUB_CLIENT_ID = requireDevOAuthClientId(process.env.GIAN_GITHUB_CLIENT_ID);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const desktop = join(root, 'packages/desktop');
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: desktop, stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${command} failed: ${result.status}`);
}
const actual = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
if (actual.status !== 0) throw new Error('Cannot identify the Dev package source revision');
const sha = process.env.GIAN_BUILD_SHA ?? (localBuild ? actual.stdout.trim() : undefined);
if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('A precise source SHA is required');
if (actual.status !== 0 || actual.stdout.trim() !== sha) throw new Error('Checkout differs from certified SHA');
const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8' });
if (status.status !== 0) throw new Error('Cannot inspect Dev package source status');
if (!localBuild && status.stdout.trim()) throw new Error('Hosted Dev package source must be clean');
const sourceDirty = Boolean(status.stdout.trim());
const branchResult = spawnSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' });
if (branchResult.status !== 0) throw new Error('Cannot identify the Dev package source branch');
const sourceBranch = branchResult.stdout.trim();
let localSourceDigest = null;
if (localBuild) {
  if (!/^release\/\d+\.\d+\.\d+$/.test(sourceBranch)) {
    throw new Error('Local GianDev packaging requires a numeric release branch.');
  }
  const diff = spawnSync('git', ['diff', '--binary', 'HEAD', '--'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 1024 * 1024 });
  if (diff.status !== 0 || untracked.status !== 0) throw new Error('Cannot fingerprint local Dev source');
  const hash = createHash('sha256').update(sha).update(diff.stdout);
  for (const path of untracked.stdout.toString('utf8').split('\0').filter(Boolean).sort()) {
    const file = join(root, path);
    if (!lstatSync(file).isFile()) throw new Error(`Local Dev source contains a non-file untracked path: ${path}`);
    hash.update(path).update(readFileSync(file));
  }
  localSourceDigest = hash.digest('hex');
}
for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_KEYCHAIN', 'APPLE_API_KEY', 'APPLE_API_KEY_BASE64']) {
  if (process.env[name]) throw new Error(`Production credential is forbidden in Dev packaging: ${name}`);
}
run('pnpm', ['run', 'bundle:build']);
const temp = mkdtempSync(join(tmpdir(), 'gian-dev-icon-'));
try {
  const png = join(temp, 'icon.png');
  const iconset = join(temp, 'icon.iconset');
  mkdirSync(iconset);
  run('pnpm', ['exec', 'electron', '../../scripts/render-dev-icon.cjs'], { env: { ...process.env, GIAN_ICON_PROFILE: join(temp, 'profile'), GIAN_ICON_OUTPUT: png } });
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) run('sips', ['-z', String(size * scale), String(size * scale), png, '--out', join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)]);
  }
  const icon = join(temp, 'icon.icns');
  run('iconutil', ['-c', 'icns', iconset, '-o', icon]);
  const config = join(temp, 'builder.json');
  const manifest = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));
  const builder = devPackageConfiguration(manifest.build, sha, icon, manifest.version);
  if (localBuild) {
    builder.artifactName = `GianDev-local-${sourceBranch.slice('release/'.length)}-candidate-${sha.slice(0, 12)}-${localSourceDigest.slice(0, 10)}-\${arch}.\${ext}`;
    builder.extraMetadata = { ...builder.extraMetadata, gianLocalBuild: true, gianLocalSourceDigest: localSourceDigest };
  }
  writeFileSync(config, JSON.stringify(builder));
  run('pnpm', ['exec', 'electron-builder', '--config', config, '--mac', 'zip', '--arm64', '--publish', 'never'], { env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
  const releaseDir = join(desktop, 'release');
  const assets = readdirSync(releaseDir).filter(name => name.endsWith('.zip')).map(name => {
    const data = readFileSync(join(releaseDir, name));
    return { name, size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  });
  if (assets.length !== 1) throw new Error('Expected exactly one Dev ZIP');
  writeFileSync(join(releaseDir, 'SHA256SUMS'), assets.map(asset => `${asset.sha256}  ${asset.name}\n`).join(''));
  writeFileSync(join(releaseDir, 'build-receipt.json'), JSON.stringify({
    schema: 1, channel: 'dev', buildOrigin: localBuild ? 'local' : 'github-hosted',
    version: manifest.version, sourceBranch, sha, sourceDirty, localSourceDigest,
    sourceRunId: process.env.GIAN_SOURCE_RUN_ID, runId: process.env.GITHUB_RUN_ID, assets,
  }, null, 2) + '\n');
} finally { rmSync(temp, { recursive: true, force: true }); }
