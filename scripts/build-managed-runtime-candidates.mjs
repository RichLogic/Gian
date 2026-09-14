#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { proxyReleaseMetadata } from './proxy-release-metadata.mjs';

const execFileAsync = promisify(execFile);
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_RUNTIME_ASSET_BYTES = 512 * 1024 * 1024;

export const upstreamRuntimeCandidates = Object.freeze({
  claude: Object.freeze({
    version: '2.1.159',
    format: 'raw',
    entryRelativePath: 'bin/claude',
    url: 'https://downloads.claude.ai/claude-code-releases/2.1.159/darwin-arm64/claude',
    sha256: '5adf7b4d349f743d669cd5adf2ce76dbb5e146d8ab99b3a63c5aef2ef15595f9',
    size: 215250336,
  }),
  codex: Object.freeze({
    version: '0.153.4',
    format: 'tar.gz',
    entryRelativePath: 'bin/codex',
    url: 'https://github.com/openai/codex/releases/download/rust-v0.153.4/codex-package-aarch64-apple-darwin.tar.gz',
    sha256: '35438da1fbf7a6db7ddb3bcec84448fa6015ba188461472a97d9d1da7d9c4353',
    size: 111554884,
  }),
  kimi: Object.freeze({
    version: '0.41.0',
    format: 'tar.gz',
    entryRelativePath: 'kimi',
    url: 'https://github.com/MoonshotAI/kimi-code/releases/download/%40moonshot-ai/kimi-code%400.41.0/kimi-code-darwin-arm64.tar.gz',
    sha256: '8d3dd7dde4b2a3cbd0993fb677c96665dcb6b93ac8cf0fff80ab20a7539024e9',
    size: 60450550,
  }),
});

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseVersion(output, provider) {
  const version = /(?:^|\s|v)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=\s|$)/u.exec(output)?.[1];
  if (!version) throw new Error(`${provider} --version did not expose SemVer.`);
  return version;
}

async function inspectEntry(provider, path, expectedVersion, environment = {}) {
  const bytes = await readFile(path);
  const { stdout, stderr } = await execFileAsync(path, ['--version'], {
    cwd: rootDir,
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 64 * 1024,
    env: { ...process.env, ...environment },
  });
  const version = parseVersion(`${stdout}\n${stderr}`, provider);
  if (version !== expectedVersion) {
    throw new Error(`${provider} Runtime ${version} does not match ${expectedVersion}.`);
  }
  return { version, sha256: digest(bytes), size: bytes.length };
}

async function downloadPinned(candidate, path) {
  const response = await fetch(candidate.url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Runtime download failed (${response.status}): ${candidate.url}`);
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_RUNTIME_ASSET_BYTES) throw new Error('Runtime download exceeds the size limit.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== candidate.size || digest(bytes) !== candidate.sha256) {
    throw new Error(`Official ${candidate.version} Runtime bytes differ from the pinned coordinate.`);
  }
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  return bytes;
}

async function buildUpstream(provider, candidate, outputDir, workDir) {
  const assetName = `${provider}-${candidate.version}-${candidate.format === 'raw' ? 'darwin-arm64' : 'darwin-arm64.tar.gz'}`;
  const assetPath = join(outputDir, assetName);
  await downloadPinned(candidate, assetPath);
  let entryPath = assetPath;
  if (candidate.format === 'tar.gz') {
    const extracted = join(workDir, provider);
    await mkdir(extracted, { recursive: true, mode: 0o700 });
    await execFileAsync('/usr/bin/tar', ['-xzf', assetPath, '-C', extracted]);
    entryPath = join(extracted, candidate.entryRelativePath);
  }
  await chmod(entryPath, 0o700);
  const environment = {
    HOME: join(workDir, `${provider}-home`),
    CLAUDE_CONFIG_DIR: join(workDir, 'claude-home'),
    CODEX_HOME: join(workDir, 'codex-home'),
    DISABLE_AUTOUPDATER: '1',
  };
  await mkdir(environment.HOME, { recursive: true, mode: 0o700 });
  const entry = await inspectEntry(provider, entryPath, candidate.version, environment);
  return {
    provider,
    version: candidate.version,
    format: candidate.format,
    entryRelativePath: candidate.entryRelativePath,
    entry,
    asset: {
      name: basename(assetPath),
      path: assetPath,
      url: candidate.url,
      sha256: candidate.sha256,
      size: candidate.size,
      publish: false,
    },
    candidateBin: entryPath,
  };
}

async function archiveFileList(directory, prefix = '') {
  const paths = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${item.name}` : item.name;
    const path = join(directory, item.name);
    if (relative === 'node_modules/.package-lock.json') continue;
    if (item.isDirectory()) paths.push(...await archiveFileList(path, relative));
    else if (item.isFile()) paths.push(relative);
    else if (item.isSymbolicLink()) {
      const target = await stat(path);
      if (!target.isFile()) throw new Error(`DSH Runtime link must resolve to a file: ${relative}`);
      paths.push(relative);
    } else {
      throw new Error(`DSH Runtime contains an unsupported filesystem entry: ${relative}`);
    }
  }
  return paths.sort((left, right) => left.localeCompare(right));
}

async function normalizeArchiveTimes(root, paths) {
  const epoch = new Date('2000-01-01T00:00:00.000Z');
  for (let index = 0; index < paths.length; index += 256) {
    await Promise.all(paths.slice(index, index + 256).map(relative => (
      utimes(join(root, ...relative.split('/')), epoch, epoch)
    )));
  }
}

async function buildDsh(outputDir, workDir) {
  const metadata = proxyReleaseMetadata('dsh');
  const lockedSource = resolve(rootDir, 'runtimes/deepseek-harness');
  const runtimeRoot = join(workDir, 'dsh-runtime');
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await Promise.all([
    copyFile(join(lockedSource, 'package.json'), join(runtimeRoot, 'package.json')),
    copyFile(join(lockedSource, 'package-lock.json'), join(runtimeRoot, 'package-lock.json')),
  ]);
  await execFileAsync(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
    'ci',
    '--ignore-scripts',
    '--omit=dev',
    '--no-audit',
    '--no-fund',
  ], {
    cwd: runtimeRoot,
    encoding: 'utf8',
    timeout: 15 * 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const sourcePath = join(runtimeRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
  const version = metadata.runtime.verifiedVersions[0];
  const entry = await inspectEntry('dsh', sourcePath, version, {
    HOME: join(workDir, 'dsh-home'),
    DSH_HOME: join(workDir, 'dsh-home'),
    DSH_TELEMETRY_DISABLED: '1',
  });
  const name = `gian-runtime-dsh-${version}-darwin-arm64.tar.gz`;
  const path = join(outputDir, name);
  const listPath = join(workDir, 'dsh-runtime-files');
  const paths = await archiveFileList(join(runtimeRoot, 'node_modules'), 'node_modules');
  await normalizeArchiveTimes(runtimeRoot, paths);
  await writeFile(listPath, Buffer.from(`${paths.join('\0')}\0`, 'utf8'));
  await execFileAsync('/usr/bin/tar', [
    '-czhf', path,
    '--format', 'ustar',
    '--uid', '0',
    '--gid', '0',
    '--uname', 'root',
    '--gname', 'root',
    '--numeric-owner',
    '--no-xattrs',
    '--no-acls',
    '--no-fflags',
    '--no-mac-metadata',
    '--options', 'gzip:!timestamp',
    '-C', runtimeRoot,
    '--null',
    '-T', listPath,
  ], {
    maxBuffer: 1024 * 1024,
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  const bytes = await readFile(path);
  if (bytes.length > MAX_RUNTIME_ASSET_BYTES) throw new Error('DSH Runtime archive exceeds the size limit.');
  return {
    provider: 'dsh', version, format: 'tar.gz',
    entryRelativePath: 'node_modules/@deepseek-ai/dsh/lib/bin.js', entry,
    asset: {
      name, path,
      url: `https://github.com/RichLogic/Gian/releases/download/${metadata.tag}/${name}`,
      sha256: digest(bytes), size: bytes.length, publish: true,
    },
    candidateBin: sourcePath,
  };
}

export function validateRuntimeCandidateDefinitions() {
  for (const [provider, candidate] of Object.entries(upstreamRuntimeCandidates)) {
    if (!['raw', 'tar.gz'].includes(candidate.format)) throw new Error(`${provider} format is invalid.`);
    if (!/^https:\/\//u.test(candidate.url) || !/^[a-f0-9]{64}$/u.test(candidate.sha256)) {
      throw new Error(`${provider} upstream coordinate is invalid.`);
    }
    if (!Number.isSafeInteger(candidate.size) || candidate.size <= 0 || candidate.size > MAX_RUNTIME_ASSET_BYTES) {
      throw new Error(`${provider} upstream size is invalid.`);
    }
  }
  return true;
}

export async function buildManagedRuntimeCandidates({ outputDir, githubEnv = null }) {
  validateRuntimeCandidateDefinitions();
  const target = resolve(outputDir);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true, mode: 0o700 });
  const workDir = resolve(dirname(target), '.runtime-work');
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  const candidates = [];
  for (const [provider, definition] of Object.entries(upstreamRuntimeCandidates)) {
    candidates.push(await buildUpstream(provider, definition, target, workDir));
  }
  candidates.push(await buildDsh(target, workDir));
  const manifest = {
    schemaVersion: 1,
    platform: 'darwin-arm64',
    candidates: candidates.map(({ candidateBin, ...candidate }) => ({
      ...candidate,
      asset: { ...candidate.asset, path: candidate.asset.name },
    })),
  };
  await writeFile(join(target, 'runtime-candidates.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  if (githubEnv) {
    const envNames = { claude: 'CLAUDE_BIN', codex: 'CODEX_BIN', kimi: 'KIMI_BIN', dsh: 'DSH_BIN' };
    const body = candidates.map(candidate => `${envNames[candidate.provider]}=${candidate.candidateBin}`).join('\n');
    await writeFile(resolve(githubEnv), `${body}\n`, { flag: 'a' });
  }
  return manifest;
}

function parseArgs(argv) {
  const options = { outputDir: 'artifacts/runtimes', githubEnv: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output') options.outputDir = argv[++index];
    else if (arg === '--github-env') options.githubEnv = argv[++index];
    else throw new Error(`Unknown Runtime candidate argument ${arg}.`);
  }
  if (!options.outputDir) throw new Error('--output requires a path.');
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildManagedRuntimeCandidates(parseArgs(process.argv.slice(2))).then(manifest => {
    console.log(`prepared ${manifest.candidates.length} managed Runtime candidates`);
  }).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
