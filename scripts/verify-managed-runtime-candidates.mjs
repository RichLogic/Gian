#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { extractManagedRuntimeArchive } from '../packages/host/dist/runtime/safe-extract.js';

const execFileAsync = promisify(execFile);
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function verifyManagedRuntimeCandidates(directory = join(rootDir, 'artifacts/runtimes')) {
  const candidateDir = resolve(directory);
  const manifest = JSON.parse(await readFile(join(candidateDir, 'runtime-candidates.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.platform !== 'darwin-arm64' || !Array.isArray(manifest.candidates)) {
    throw new Error('Managed Runtime candidate manifest is invalid.');
  }
  const tempRoot = await mkdtemp(join(tmpdir(), 'gian-runtime-verify-'));
  try {
    for (const candidate of manifest.candidates) {
      const assetPath = join(candidateDir, candidate.asset.name);
      const asset = await readFile(assetPath);
      const info = await stat(assetPath);
      if (digest(asset) !== candidate.asset.sha256 || info.size !== candidate.asset.size) {
        throw new Error(`${candidate.provider} Runtime asset differs from its manifest.`);
      }
      let entryPath = assetPath;
      if (candidate.format === 'tar.gz') {
        const destination = join(tempRoot, candidate.provider);
        await mkdir(destination, { recursive: true, mode: 0o700 });
        try {
          await extractManagedRuntimeArchive(asset, destination);
        } catch (error) {
          throw new Error(`${candidate.provider} Runtime extraction failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        entryPath = join(destination, candidate.entryRelativePath);
      }
      await chmod(entryPath, 0o700);
      const entry = await readFile(entryPath);
      if (digest(entry) !== candidate.entry.sha256 || entry.length !== candidate.entry.size) {
        throw new Error(`${candidate.provider} Runtime entry differs from its manifest.`);
      }
      const home = join(tempRoot, `${candidate.provider}-home`);
      await mkdir(home, { recursive: true, mode: 0o700 });
      const result = await execFileAsync(entryPath, ['--version'], {
        cwd: tempRoot,
        encoding: 'utf8',
        timeout: 20_000,
        maxBuffer: 64 * 1024,
        env: {
          ...process.env,
          HOME: home,
          CLAUDE_CONFIG_DIR: home,
          CODEX_HOME: home,
          KIMI_HOME: home,
          DSH_HOME: home,
          DISABLE_AUTOUPDATER: '1',
          DSH_TELEMETRY_DISABLED: '1',
        },
      });
      if (!`${result.stdout}\n${result.stderr}`.includes(candidate.version)) {
        throw new Error(`${candidate.provider} extracted Runtime reports a different version.`);
      }
    }
    return manifest.candidates.length;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--directory');
  const directory = index >= 0 ? process.argv[index + 1] : undefined;
  verifyManagedRuntimeCandidates(directory).then(count => {
    console.log(`verified ${count} managed Runtime candidate artifacts`);
  }).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
