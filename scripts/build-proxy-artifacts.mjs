import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const platform = 'darwin-arm64';
const definitions = [
  ['claude', 'cc-proxy'],
  ['codex', 'codex-proxy'],
  ['kimi', 'kimi-proxy'],
];

export async function buildProxyBundle(entryPoint, outfile) {
  await build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: false,
    minify: false,
    banner: {
      js: [
        'import { createRequire as __gianCreateRequire } from "node:module";',
        'const require = __gianCreateRequire(import.meta.url);',
      ].join('\n'),
    },
  });
  const bundled = await readFile(outfile, 'utf8');
  const withoutShebangs = bundled.replace(/^#![^\r\n]*(?:\r?\n|$)/gm, '');
  await writeFile(outfile, `#!/usr/bin/env node\n${withoutShebangs}`);
}

export async function assertProxySelfTest(entryPoint, expectedId) {
  const result = await execFileAsync(process.execPath, [entryPoint, '--self-test'], {
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    encoding: 'utf8',
  });
  let response;
  try {
    response = JSON.parse(String(result.stdout).trim());
  } catch {
    throw new Error(`${expectedId} proxy self-test returned invalid JSON`);
  }
  if (
    response?.schemaVersion !== 1
    || response?.id !== expectedId
    || response?.ok !== true
  ) {
    throw new Error(`${expectedId} proxy self-test returned an invalid result`);
  }
}

async function main() {
  const rootPackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 1) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    if (key?.startsWith('--') && value && !value.startsWith('--')) {
      args.set(key.slice(2), value);
      index += 1;
    }
  }

  const version = args.get('version') ?? rootPackage.version;
  if (!/^[0-9A-Za-z._-]+$/.test(version)) throw new Error('invalid proxy version');
  const outputDir = resolve(root, args.get('output') ?? 'artifacts/proxies');
  await mkdir(outputDir, { recursive: true });

  for (const [id, directory] of definitions) {
    const staging = join(outputDir, `.staging-${id}`);
    const packageDir = join(staging, 'package');
    const proxyEntry = join(packageDir, 'proxy.mjs');
    const sourceEntry = join(
      root,
      'packages',
      'proxies',
      directory,
      'dist',
      'src',
      'cli',
      'spawn.js',
    );
    const assetName = `gian-proxy-${id}-${version}-${platform}.tar.gz`;
    const assetPath = join(outputDir, assetName);
    await rm(staging, { recursive: true, force: true });
    await mkdir(packageDir, { recursive: true });
    try {
      await buildProxyBundle(sourceEntry, proxyEntry);
      await chmod(proxyEntry, 0o755);
      await assertProxySelfTest(proxyEntry, id);
      await writeFile(join(packageDir, 'manifest.json'), `${JSON.stringify({
        schemaVersion: 1,
        id,
        version,
        entry: 'proxy.mjs',
      }, null, 2)}\n`);
      await execFileAsync('/usr/bin/tar', [
        '-czf',
        assetPath,
        '-C',
        packageDir,
        '.',
      ]);
      const checksum = createHash('sha256')
        .update(await readFile(assetPath))
        .digest('hex');
      await writeFile(`${assetPath}.sha256`, `${checksum}  ${assetName}\n`);
      console.log(assetPath);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
