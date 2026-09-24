import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { build } from 'esbuild';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const platform = 'darwin-arm64';
const SEMVER_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const RELEASE_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const ACCEPTANCE_SETUPS = new Set(['default', 'claude-settings', 'kimi-store', 'dsh-profile']);

function canonicalRelativePath(value) {
  const candidate = typeof value === 'string' && value.startsWith('./') ? value.slice(2) : value;
  return typeof value === 'string'
    && value.length > 0
    && !isAbsolute(value)
    && !value.includes('\\')
    && !value.split('/').includes('..')
    && normalize(candidate) === candidate;
}

/** Discover release metadata from each Proxy package and Manifest. There is
 * no central Provider list: adding a package changes only that package's own
 * package.json/manifest plus Catalog data. */
export async function discoverProxyDefinitions(repoRoot = root) {
  const proxiesDir = join(repoRoot, 'packages', 'proxies');
  const result = [];
  const directories = (await readdir(proxiesDir, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
    .map(entry => entry.name)
    .sort();
  for (const directory of directories) {
    let packageMetadata;
    let manifest;
    try {
      packageMetadata = JSON.parse(await readFile(join(proxiesDir, directory, 'package.json'), 'utf8'));
      manifest = JSON.parse(await readFile(join(proxiesDir, directory, 'manifest.json'), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    const release = packageMetadata.gianProxy;
    if (!release) continue;
    if (
      !RELEASE_ID_RE.test(release.releaseId ?? '')
      || typeof release.shipping !== 'boolean'
      || typeof release.realAcceptance?.binaryEnv !== 'string'
      || !/^[A-Z][A-Z0-9_]+$/.test(release.realAcceptance.binaryEnv)
      || !ACCEPTANCE_SETUPS.has(release.realAcceptance.setup)
      || (release.realAcceptance.proxyBinaryArg !== undefined
        && !/^--[a-z][a-z0-9-]+$/.test(release.realAcceptance.proxyBinaryArg))
    ) {
      throw new Error(`${directory} has invalid package.json gianProxy metadata`);
    }
    if (!SEMVER_RE.test(packageMetadata.version ?? '') || packageMetadata.version !== manifest.pluginVersion) {
      throw new Error(`${manifest.id ?? directory} package and Manifest versions differ`);
    }
    if (
      typeof packageMetadata.name !== 'string'
      || !packageMetadata.name.startsWith('@gian/')
      || !packageMetadata.name.endsWith('-proxy')
      || !canonicalRelativePath(packageMetadata.main)
    ) {
      throw new Error(`${directory} has invalid Proxy package metadata`);
    }
    result.push({
      id: release.releaseId,
      pluginId: manifest.id,
      directory,
      packageName: packageMetadata.name,
      pluginVersion: packageMetadata.version,
      sourceEntry: join(proxiesDir, directory, packageMetadata.main),
      bundlePackages: release.bundlePackages ?? [],
      shipping: release.shipping,
      realAcceptance: release.realAcceptance,
      displayName: manifest.displayName,
      processScope: manifest.process.scope,
      environment: {
        runtimeBinary: release.realAcceptance.binaryEnv,
      },
      qualification: {
        binaryArgument: release.realAcceptance.proxyBinaryArg ?? null,
        setup: release.realAcceptance.setup,
      },
      runtime: {
        id: manifest.runtime.id ?? null,
        displayName: manifest.runtime.displayName ?? null,
        verifiedCliVersions: [...(manifest.runtime.verifiedVersions ?? [])],
      },
      manifest,
    });
  }
  const releaseIds = result.map(item => item.id);
  const pluginIds = result.map(item => item.pluginId);
  if (new Set(releaseIds).size !== releaseIds.length || new Set(pluginIds).size !== pluginIds.length) {
    throw new Error('Proxy package releaseId and pluginId values must be unique.');
  }
  return result;
}

export const proxyDefinitions = await discoverProxyDefinitions();
export const shippingProxyIds = proxyDefinitions
  .filter(definition => definition.shipping)
  .map(definition => definition.id);

export function assertRuntimeManifest(manifest) {
  const runtime = manifest.runtime;
  if (!runtime || typeof runtime !== 'object') {
    throw new Error(`${manifest.id} Proxy must declare runtime`);
  }
  if (runtime.kind !== 'external' && runtime.kind !== 'none') {
    throw new Error(`${manifest.id} Proxy must declare runtime.kind`);
  }
  if (runtime.kind === 'none') return;
  const verified = runtime.verifiedVersions;
  if (!Array.isArray(verified) || verified.length === 0) {
    throw new Error(`${manifest.id} external Runtime must declare runtime.verifiedVersions`);
  }
  if (verified.some(version => typeof version !== 'string' || !SEMVER_RE.test(version))) {
    throw new Error(`${manifest.id} runtime.verifiedVersions must contain SemVer values`);
  }
  if (new Set(verified).size !== verified.length) {
    throw new Error(`${manifest.id} runtime.verifiedVersions must not contain duplicates`);
  }
}

export async function buildProxyBundle(entryPoint, outfile, packageIdentity) {
  if (packageIdentity) {
    if (!/^@gian\/[a-z0-9-]+-proxy$/.test(packageIdentity.name ?? '') || !SEMVER_RE.test(packageIdentity.version ?? '')) {
      throw new Error('Invalid bundled Proxy package identity');
    }
    // The standalone archive must carry its own version, not fall back to a
    // source default or inherit an unrelated App package higher in the path.
    await writeFile(join(dirname(outfile), 'package.json'), `${JSON.stringify({
      name: packageIdentity.name, version: packageIdentity.version, type: 'module',
    }, null, 2)}\n`);
  }
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

export async function assertProxySelfTest(entryPoint, manifest) {
  const result = await execFileAsync(process.execPath, [entryPoint, '--self-test'], {
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIAN_PLUGIN_ID: manifest.id,
      GIAN_PROTOCOL_VERSIONS: '2.2',
    },
  });
  let response;
  try {
    response = JSON.parse(String(result.stdout).trim());
  } catch {
    throw new Error(`${manifest.id} proxy self-test returned invalid JSON`);
  }
  if (
    response?.schemaVersion !== manifest.schemaVersion
    || response?.pluginVersion !== manifest.pluginVersion
    || response?.id !== manifest.id
    || response?.ok !== true
  ) {
    throw new Error(
      `${manifest.id} proxy self-test returned an invalid result: ${JSON.stringify(response)}`,
    );
  }
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key?.startsWith('--') && value && !value.startsWith('--')) {
      args.set(key.slice(2), value);
      index += 1;
    } else {
      throw new Error(`Invalid Proxy artifact argument: ${String(key)}`);
    }
  }
  return args;
}

async function copyManifestReference(definition, packageDir, reference) {
  if (!canonicalRelativePath(reference?.path) || !/^[0-9a-f]{64}$/.test(reference?.sha256 ?? '')) {
    throw new Error(`${definition.pluginId} has an invalid Manifest asset reference`);
  }
  const source = join(root, 'packages', 'proxies', definition.directory, reference.path);
  const bytes = await readFile(source);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== reference.sha256) {
    throw new Error(`${definition.pluginId} referenced asset ${reference.path} digest mismatch`);
  }
  const destination = join(packageDir, reference.path);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const requestedPlugin = args.get('plugin');
  if (requestedPlugin && !proxyDefinitions.some(definition => definition.id === requestedPlugin)) {
    throw new Error(`unknown proxy plugin: ${requestedPlugin}`);
  }
  const selectedDefinitions = requestedPlugin
    ? proxyDefinitions.filter(definition => definition.id === requestedPlugin)
    : proxyDefinitions.filter(definition => definition.shipping);
  const outputDir = resolve(root, args.get('output') ?? 'artifacts/proxies');
  await mkdir(outputDir, { recursive: true });

  for (const definition of selectedDefinitions) {
    const { id, pluginVersion } = definition;
    const requestedVersion = args.get('version');
    if (requestedVersion && requestedVersion !== pluginVersion) {
      throw new Error(
        `${id} package version ${pluginVersion} does not match requested ${requestedVersion}`,
      );
    }
    const manifest = structuredClone(definition.manifest);
    assertRuntimeManifest(manifest);
    const staging = join(outputDir, `.staging-${id}`);
    const packageDir = join(staging, 'package');
    const proxyEntry = join(packageDir, 'proxy.mjs');
    const assetName = `gian-proxy-${id}-${pluginVersion}-${platform}.tar.gz`;
    const assetPath = join(outputDir, assetName);
    const manifestAssetPath = `${assetPath}.manifest.json`;
    await rm(staging, { recursive: true, force: true });
    await mkdir(packageDir, { recursive: true });
    try {
      await buildProxyBundle(definition.sourceEntry, proxyEntry, {
        name: definition.packageName, version: pluginVersion,
      });
      await chmod(proxyEntry, 0o755);
      for (const companion of definition.bundlePackages) {
        if (!/^[a-z][a-z0-9-]+$/.test(companion.directory ?? '')
          || !canonicalRelativePath(companion.path)
          || !Array.isArray(companion.files) || companion.files.length === 0) {
          throw new Error('Invalid bundled package metadata');
        }
        for (const file of companion.files) {
          if (!canonicalRelativePath(file)) throw new Error('Invalid bundled package file');
          await cp(join(root, 'packages/proxies', companion.directory, file),
            join(packageDir, companion.path, file), { recursive: true, errorOnExist: true, force: false });
        }
      }
      const references = [
        ...Object.values(manifest.branding?.logo ?? {}).filter(Boolean),
        ...(manifest.skills ?? []),
      ];
      for (const reference of references) {
        await copyManifestReference(definition, packageDir, reference);
      }
      await assertProxySelfTest(proxyEntry, manifest);
      const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
      await writeFile(join(packageDir, 'manifest.json'), manifestJson);
      await writeFile(manifestAssetPath, manifestJson);
      await execFileAsync('/usr/bin/tar', ['-czf', assetPath, '-C', packageDir, '.']);
      const checksum = createHash('sha256').update(await readFile(assetPath)).digest('hex');
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
