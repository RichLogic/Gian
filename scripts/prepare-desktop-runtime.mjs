import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPortableMacNodeRuntime } from './desktop-runtime-portability.mjs';

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('Gian v0.1 desktop runtime must be prepared on macOS arm64.');
}
if (process.versions.node.split('.')[0] !== '22') {
  throw new Error(`Gian desktop runtime requires Node 22, received ${process.version}.`);
}

const linkedLibraries = execFileSync('/usr/bin/otool', ['-L', process.execPath], {
  encoding: 'utf8',
});
assertPortableMacNodeRuntime(linkedLibraries);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDir = join(root, 'packages', 'desktop', 'runtime');
const nodeRoot = resolve(dirname(process.execPath), '..');
const license = join(nodeRoot, 'LICENSE');
await stat(license);
await mkdir(runtimeDir, { recursive: true });
await copyFile(process.execPath, join(runtimeDir, 'node'));
await chmod(join(runtimeDir, 'node'), 0o755);
await copyFile(license, join(runtimeDir, 'NODE-LICENSE'));
const githubClientId = (process.env.GIAN_GITHUB_CLIENT_ID ?? '').trim();
if (githubClientId && !/^[A-Za-z0-9_-]{8,200}$/.test(githubClientId)) {
  throw new Error('GIAN_GITHUB_CLIENT_ID is not a valid GitHub OAuth client id.');
}
await writeFile(
  join(runtimeDir, 'github-auth.json'),
  `${JSON.stringify({ clientId: githubClientId })}\n`,
  { mode: 0o644 },
);
if (!githubClientId) {
  console.warn('GIAN_GITHUB_CLIENT_ID is empty; this build will show GitHub login as unavailable.');
}
console.log(`Prepared Node ${process.version} runtime at ${runtimeDir}`);
