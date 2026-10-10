import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildDshRuntimeCandidate } from './build-managed-runtime-candidates.mjs';

export async function prepareDevSourceRuntimeAssets({ root, coordinates, directory,
  prepareAssets, build = buildDshRuntimeCandidate }) {
  for (const coordinate of coordinates.filter(item => item.build)) {
    const source = coordinate.build;
    if (source.kind !== 'dsh-lock') throw new Error('Unsupported Dev Runtime source builder.');
    const sourceDir = join(root, 'runtimes/deepseek-harness');
    const packageBytes = await readFile(join(sourceDir, 'package.json'));
    const lockBytes = await readFile(join(sourceDir, 'package-lock.json'));
    const digest = bytes => createHash('sha256').update(bytes).digest('hex');
    if (digest(packageBytes) !== source.packageSha256 || digest(lockBytes) !== source.lockSha256) {
      throw new Error('Dev Runtime source differs from its pinned package/lock digests.');
    }
    const pkg = JSON.parse(packageBytes);
    const lock = JSON.parse(lockBytes);
    if (pkg.dependencies?.['@deepseek-ai/dsh'] !== coordinate.version
      || lock.packages?.['node_modules/@deepseek-ai/dsh']?.version !== coordinate.version) {
      throw new Error('Dev Runtime source version differs from its Proxy declaration.');
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await prepareAssets({ directory, coordinates: [coordinate], download: async () => {
      const temp = await mkdtemp(join(directory, '.source-runtime-'));
      try {
        const output = join(temp, 'assets');
        const work = join(temp, 'work');
        await mkdir(output);
        await mkdir(work);
        const candidate = await build(output, work);
        if (candidate.version !== coordinate.version || candidate.format !== coordinate.format
          || candidate.entryRelativePath !== coordinate.entryRelativePath) {
          throw new Error('Built Dev Runtime does not match its pinned declaration.');
        }
        return await readFile(candidate.asset.path);
      } finally { await rm(temp, { recursive: true, force: true }); }
    } });
  }
}
