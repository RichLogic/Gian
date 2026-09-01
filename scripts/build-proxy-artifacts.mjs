import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmod,
  copyFile,
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
  {
    id: 'claude',
    directory: 'cc-proxy',
    displayName: 'Claude Code',
    processScope: 'session',
    branding: true,
    runtime: {
      id: 'claude',
      displayName: 'Claude Code CLI',
      verifiedCliVersions: ['2.1.159'],
    },
  },
  {
    id: 'codex',
    directory: 'codex-proxy',
    displayName: 'Codex',
    processScope: 'shared',
    branding: true,
    skill: 'gian-session',
    runtime: {
      id: 'codex',
      displayName: 'Codex CLI',
      verifiedCliVersions: ['0.146.0'],
    },
  },
  {
    id: 'kimi',
    directory: 'kimi-proxy',
    displayName: 'Kimi Code',
    processScope: 'shared',
    branding: true,
    runtime: {
      id: 'kimi',
      displayName: 'Kimi Code CLI',
      verifiedCliVersions: ['0.38.0'],
    },
  },
  {
    id: 'dsh',
    pluginId: 'ai.deepseek.harness',
    directory: 'dsh-proxy',
    displayName: 'DeepSeek Harness',
    processScope: 'shared',
    branding: true,
    runtime: {
      id: 'dsh',
      displayName: 'DeepSeek Harness',
      verifiedCliVersions: ['0.1.1-rc.2'],
    },
  },
  {
    id: 'grok',
    directory: 'grok-proxy',
    displayName: 'Grok Build',
    processScope: 'session',
    staged: true,
    runtime: {
      id: 'grok',
      displayName: 'Grok Build CLI',
      verifiedCliVersions: ['1.0.4'],
    },
  },
  {
    id: 'zcode',
    pluginId: 'com.zhipu.zcode',
    directory: 'zcode-proxy',
    displayName: 'ZCode',
    processScope: 'shared',
    branding: true,
    runtime: {
      id: 'zcode',
      displayName: 'ZCode CLI',
      verifiedCliVersions: ['0.16.5'],
    },
  },
];

export const shippingProxyIds = definitions
  .filter(definition => definition.staged !== true)
  .map(definition => definition.id);

const BUILTIN_PROXY_IDS = new Set(definitions.map(definition => definition.pluginId ?? definition.id));
const SEMVER_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function assertRuntimeManifest(manifest) {
  const runtime = manifest.runtime;
  if (!runtime || typeof runtime !== 'object') {
    if (BUILTIN_PROXY_IDS.has(manifest.id)) {
      throw new Error(`${manifest.id} built-in proxy must declare runtime.verifiedCliVersions`);
    }
    return;
  }
  const verified = runtime.verifiedCliVersions;
  if (!Array.isArray(verified) || verified.length === 0) {
    if (BUILTIN_PROXY_IDS.has(manifest.id)) {
      throw new Error(`${manifest.id} built-in proxy must declare runtime.verifiedCliVersions`);
    }
    return;
  }
  if (verified.some(version => typeof version !== 'string' || !SEMVER_RE.test(version))) {
    throw new Error(`${manifest.id} runtime.verifiedCliVersions must contain SemVer values`);
  }
  if (new Set(verified).size !== verified.length) {
    throw new Error(`${manifest.id} runtime.verifiedCliVersions must not contain duplicates`);
  }
}

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

export async function assertProxySelfTest(entryPoint, manifest) {
  const result = await execFileAsync(process.execPath, [entryPoint, '--self-test'], {
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(manifest.schemaVersion >= 2
        ? {
            GIAN_PLUGIN_ID: manifest.id,
            GIAN_PROTOCOL_VERSIONS: '2.1,2.0',
          }
        : {}),
    },
  });
  let response;
  try {
    response = JSON.parse(String(result.stdout).trim());
  } catch {
    throw new Error(`${manifest.id} proxy self-test returned invalid JSON`);
  }
  const validVersion = response?.schemaVersion === manifest.schemaVersion
    && (manifest.schemaVersion === 1 || response?.pluginVersion === manifest.pluginVersion);
  if (!validVersion || response?.id !== manifest.id || response?.ok !== true) {
    throw new Error(
      `${manifest.id} proxy self-test returned an invalid result: ${JSON.stringify(response)}`,
    );
  }
}

async function main() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 1) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    if (key?.startsWith('--') && value && !value.startsWith('--')) {
      args.set(key.slice(2), value);
      index += 1;
    }
  }

  const requestedPlugin = args.get('plugin');
  if (requestedPlugin && !definitions.some(definition => definition.id === requestedPlugin)) {
    throw new Error(`unknown proxy plugin: ${requestedPlugin}`);
  }
  const selectedDefinitions = requestedPlugin
    ? definitions.filter(definition => definition.id === requestedPlugin)
    : definitions.filter(definition => shippingProxyIds.includes(definition.id));
  const outputDir = resolve(root, args.get('output') ?? 'artifacts/proxies');
  await mkdir(outputDir, { recursive: true });

  for (const definition of selectedDefinitions) {
    const { id, directory } = definition;
    const packageMetadata = JSON.parse(await readFile(join(
      root,
      'packages',
      'proxies',
      directory,
      'package.json',
    ), 'utf8'));
    const pluginVersion = packageMetadata.version;
    if (!/^[0-9A-Za-z.+-]+$/.test(pluginVersion)) {
      throw new Error(`invalid ${id} proxy version`);
    }
    const requestedVersion = args.get('version');
    if (requestedVersion && requestedVersion !== pluginVersion) {
      throw new Error(
        `${id} package version ${pluginVersion} does not match requested ${requestedVersion}`,
      );
    }
    const logoSources = definition.branding ? {
      light: join(root, 'packages', 'proxies', directory, 'assets', 'logo-light.png'),
      dark: join(root, 'packages', 'proxies', directory, 'assets', 'logo-dark.png'),
    } : null;
    const skillSource = definition.skill
      ? join(root, 'packages', 'proxies', directory, 'skills', definition.skill, 'SKILL.md')
      : null;
    const skills = skillSource ? [{
      name: definition.skill,
      path: `skills/${definition.skill}/SKILL.md`,
      sha256: createHash('sha256').update(await readFile(skillSource)).digest('hex'),
    }] : undefined;
    const logoDescriptor = async (variant) => ({
      path: `assets/logo-${variant}.png`,
      mediaType: 'image/png',
      sha256: createHash('sha256').update(await readFile(logoSources[variant])).digest('hex'),
    });
    const branding = logoSources ? {
      logo: {
        light: await logoDescriptor('light'),
        dark: await logoDescriptor('dark'),
      },
    } : undefined;
    const manifest = {
      schemaVersion: branding ? 3 : 2,
      id: definition.pluginId ?? id,
      displayName: definition.displayName,
      pluginVersion,
      entry: 'proxy.mjs',
      protocol: { name: 'gian.proxy', range: '>=2.1 <3.0' },
      process: { scope: definition.processScope },
      runtime: definition.runtime,
      ...(skills ? { skills } : {}),
      ...(branding ? { branding } : {}),
    };
    assertRuntimeManifest(manifest);
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
    const assetName = `gian-proxy-${id}-${pluginVersion}-${platform}.tar.gz`;
    const assetPath = join(outputDir, assetName);
    const manifestAssetPath = `${assetPath}.manifest.json`;
    await rm(staging, { recursive: true, force: true });
    await mkdir(packageDir, { recursive: true });
    try {
      await buildProxyBundle(sourceEntry, proxyEntry);
      await chmod(proxyEntry, 0o755);
      if (logoSources) {
        const assetDir = join(packageDir, 'assets');
        await mkdir(assetDir, { recursive: true });
        await copyFile(logoSources.light, join(assetDir, 'logo-light.png'));
        await copyFile(logoSources.dark, join(assetDir, 'logo-dark.png'));
      }
      if (skillSource) {
        const skillDir = join(packageDir, 'skills', definition.skill);
        await mkdir(skillDir, { recursive: true });
        await copyFile(skillSource, join(skillDir, 'SKILL.md'));
      }
      await assertProxySelfTest(proxyEntry, manifest);
      const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
      await writeFile(join(packageDir, 'manifest.json'), manifestJson);
      await writeFile(manifestAssetPath, manifestJson);
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
