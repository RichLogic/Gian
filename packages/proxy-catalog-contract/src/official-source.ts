import { createHash, generateKeyPairSync } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

import {
  MAX_CATALOG_DOCUMENT_BYTES,
  MAX_CATALOG_IMAGE_BYTES,
  MAX_CATALOG_INDEX_BYTES,
} from './constants.js';
import { catalogEntryV1Schema, isCanonicalRelativePath, type CatalogEntryV1 } from './schemas.js';
import { compileCatalogBundle, type CatalogSigningKey } from './compiler.js';
import { assertCatalogImageMagic } from './media.js';
import { CATALOG_DOCUMENT_KEYS } from './constants.js';
import { isApprovedGitHubReleaseAssetUrl, isApprovedRuntimeAssetUrl } from './url-policy.js';

function isSentinelHash(sha256: string): boolean {
  return /^[0-9a-f]{64}$/.test(sha256) && new Set(sha256).size === 1;
}
const FORBIDDEN_PLUGIN_IDS = new Set(['io.gian.fixture']);
const REQUIRED_OFFICIAL_PLUGIN_IDS = [
  'claude',
  'codex',
  'kimi',
  'ai.deepseek.harness',
  'com.zhipu.zcode',
] as const;
const DEFAULT_ARTIFACT_REPOSITORIES = ['RichLogic/Gian'] as const;
const DEFAULT_RUNTIME_ASSET_PREFIXES = [
  'https://downloads.claude.ai/claude-code-releases/',
  'https://github.com/openai/codex/releases/download/',
  'https://github.com/MoonshotAI/kimi-code/releases/download/',
  'https://github.com/MoonshotAI/kimi-cli/releases/download/',
  'https://github.com/RichLogic/Gian/releases/download/',
] as const;

export interface OfficialCatalogSourcePlugin {
  directory: string;
  entry: CatalogEntryV1;
  documents: Record<(typeof CATALOG_DOCUMENT_KEYS)[number], Buffer>;
  logos: { light: Buffer; dark: Buffer };
  sidecar: Buffer;
}

export async function loadOfficialCatalogSource(sourceRoot: string): Promise<OfficialCatalogSourcePlugin[]> {
  const pluginRoot = join(sourceRoot, 'plugins');
  const names = (await readdir(pluginRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0) {
    throw new Error('Official Catalog source contains no plugins.');
  }
  const plugins: OfficialCatalogSourcePlugin[] = [];
  for (const pluginId of names) {
    const directory = join(pluginRoot, pluginId);
    const dirInfo = await lstat(directory);
    if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) {
      throw new Error(`Official source plugin ${pluginId} is not a regular directory.`);
    }
    const entryBytes = await readContainedRegularFile(directory, 'entry.json', MAX_CATALOG_INDEX_BYTES);
    const entry = catalogEntryV1Schema.parse(JSON.parse(entryBytes.toString('utf8')));
    if (entry.pluginId !== pluginId) {
      throw new Error(`Official source directory ${pluginId} does not match entry.pluginId.`);
    }
    if (FORBIDDEN_PLUGIN_IDS.has(entry.pluginId)) {
      throw new Error(`Official Catalog source must not contain test fixture ${entry.pluginId}.`);
    }
    const declaredPaths = [
      'entry.json',
      'sidecar.json',
      entry.documentation.overview,
      entry.documentation.setup,
      entry.documentation.usage,
      entry.documentation.troubleshooting,
      entry.branding.logoLight.path,
      entry.branding.logoDark.path,
    ];
    if (new Set(declaredPaths).size !== declaredPaths.length) {
      throw new Error(`Official source plugin ${pluginId} declares a duplicate path.`);
    }
    await assertSourceInventory(directory, new Set(declaredPaths));
    const sidecar = await readContainedRegularFile(directory, 'sidecar.json', MAX_CATALOG_INDEX_BYTES);
    const documents = {
      overview: await readContainedRegularFile(directory, entry.documentation.overview, MAX_CATALOG_DOCUMENT_BYTES),
      setup: await readContainedRegularFile(directory, entry.documentation.setup, MAX_CATALOG_DOCUMENT_BYTES),
      usage: await readContainedRegularFile(directory, entry.documentation.usage, MAX_CATALOG_DOCUMENT_BYTES),
      troubleshooting: await readContainedRegularFile(
        directory,
        entry.documentation.troubleshooting,
        MAX_CATALOG_DOCUMENT_BYTES,
      ),
    };
    const logos = {
      light: await readContainedRegularFile(directory, entry.branding.logoLight.path, MAX_CATALOG_IMAGE_BYTES),
      dark: await readContainedRegularFile(directory, entry.branding.logoDark.path, MAX_CATALOG_IMAGE_BYTES),
    };
    assertCatalogImageMagic(logos.light, entry.branding.logoLight.mediaType);
    assertCatalogImageMagic(logos.dark, entry.branding.logoDark.mediaType);
    if (entry.channels.stable.manifest) {
      rejectSentinel(entry.channels.stable.manifest.sha256, `${entry.pluginId} manifest`);
    }
    for (const [platform, artifact] of Object.entries(entry.channels.stable.artifacts ?? {})) {
      if (!artifact) continue;
      rejectSentinel(artifact.sha256, `${entry.pluginId} ${platform}`);
    }
    const combination = entry.channels.stable.combination;
    if (combination) {
      rejectSentinel(combination.certificate.sha256, `${entry.pluginId} certificate`);
      if (combination.runtime?.kind === 'native-binary') {
        rejectSentinel(combination.runtime.asset.sha256, `${entry.pluginId} Runtime`);
      } else if (combination.runtime?.kind === 'external-app') {
        rejectSentinel(combination.runtime.artifactSha256, `${entry.pluginId} external Runtime`);
      }
      for (const companion of combination.companions) {
        rejectSentinel(companion.distribution.asset.sha256, `${entry.pluginId} ${companion.id}`);
      }
    }
    plugins.push({ directory, entry, documents, logos, sidecar });
  }
  return plugins;
}

export function verifyOfficialCatalogSource(
  plugins: readonly OfficialCatalogSourcePlugin[],
  options?: {
    allowedArtifactRepositories?: readonly string[];
    allowedRuntimeAssetPrefixes?: readonly string[];
  },
): void {
  if (plugins.length === 0) throw new Error('Official Catalog source is empty.');
  const allowed = options?.allowedArtifactRepositories ?? DEFAULT_ARTIFACT_REPOSITORIES;
  const runtimePrefixes = options?.allowedRuntimeAssetPrefixes ?? DEFAULT_RUNTIME_ASSET_PREFIXES;
  const seen = new Set<string>();
  for (const plugin of plugins) {
    if (seen.has(plugin.entry.pluginId)) {
      throw new Error(`Duplicate official source plugin ${plugin.entry.pluginId}.`);
    }
    seen.add(plugin.entry.pluginId);
    const manifest = plugin.entry.channels.stable.manifest;
    const artifacts = plugin.entry.channels.stable.artifacts ?? {};
    const hasArtifact = Object.values(artifacts).some((asset) => asset !== undefined);
    if (Boolean(manifest) !== hasArtifact) {
      throw new Error(`${plugin.entry.pluginId} must declare Manifest and artifacts together.`);
    }
    if (!manifest) continue;
    rejectSentinel(manifest.sha256, `${plugin.entry.pluginId} manifest`);
    if (!isApprovedGitHubReleaseAssetUrl(manifest.url, allowed)) {
      throw new Error(`${plugin.entry.pluginId} Manifest URL is not an allowed artifact URL.`);
    }
    for (const [platform, artifact] of Object.entries(artifacts)) {
      if (!artifact) continue;
      rejectSentinel(artifact.sha256, `${plugin.entry.pluginId} ${platform}`);
      if (!isApprovedGitHubReleaseAssetUrl(artifact.url, allowed)) {
        throw new Error(`${plugin.entry.pluginId} ${platform} artifact URL is not an allowed artifact URL.`);
      }
    }
    const combination = plugin.entry.channels.stable.combination;
    if (combination) {
      const assets = [
        ...(combination.runtime?.kind === 'native-binary' ? [combination.runtime.asset] : []),
        ...combination.companions.map(companion => companion.distribution.asset),
      ];
      for (const asset of assets) {
        rejectSentinel(asset.sha256, `${plugin.entry.pluginId} Runtime`);
        if (!isApprovedRuntimeAssetUrl(asset.url, runtimePrefixes)) {
          throw new Error(`${plugin.entry.pluginId} Runtime URL is not an allowed artifact URL.`);
        }
      }
    }
  }
  for (const pluginId of REQUIRED_OFFICIAL_PLUGIN_IDS) {
    if (!seen.has(pluginId)) {
      throw new Error(`Official Catalog source is missing visible product plugin ${pluginId}.`);
    }
  }
}

export async function compileOfficialCatalogSource(input: {
  sourceRoot: string;
  localizations?: import('./localization.js').CatalogLocalizationInput;
  sequence: number;
  issuedAt: string;
  signingKey: CatalogSigningKey;
  allowedArtifactRepositories?: readonly string[];
  allowedRuntimeAssetPrefixes?: readonly string[];
}): Promise<ReturnType<typeof compileCatalogBundle>> {
  const allowedArtifactRepositories = input.allowedArtifactRepositories ?? [...DEFAULT_ARTIFACT_REPOSITORIES];
  const allowedRuntimeAssetPrefixes = input.allowedRuntimeAssetPrefixes ?? [...DEFAULT_RUNTIME_ASSET_PREFIXES];
  const plugins = await loadOfficialCatalogSource(input.sourceRoot);
  verifyOfficialCatalogSource(plugins, { allowedArtifactRepositories, allowedRuntimeAssetPrefixes });
  return compileCatalogBundle({
    localizations: input.localizations,
    sourceId: 'gian-official',
    sequence: input.sequence,
    issuedAt: input.issuedAt,
    allowedArtifactRepositories,
    allowedRuntimeAssetPrefixes,
    signingKey: input.signingKey,
    plugins: plugins.map((plugin) => ({
      entry: plugin.entry,
      documents: {
        overview: plugin.documents.overview,
        setup: plugin.documents.setup,
        usage: plugin.documents.usage,
        troubleshooting: plugin.documents.troubleshooting,
      },
      logos: plugin.logos,
      manifestSidecar: plugin.sidecar,
    })),
  });
}

export async function writeCompiledCatalogBundle(
  outDir: string,
  files: Map<string, Buffer>,
): Promise<void> {
  const staging = `${outDir}.${randomDirectorySuffix()}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  for (const [path, bytes] of [...files.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const target = join(staging, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  await rm(outDir, { recursive: true, force: true });
  await rename(staging, outDir);
}

export function ephemeralCatalogSigningKey(): CatalogSigningKey {
  const pair = generateKeyPairSync('ed25519');
  return {
    keyId: 'gian-official-catalog-quality',
    privateKey: pair.privateKey,
  };
}

function rejectSentinel(sha256: string, label: string): void {
  if (isSentinelHash(sha256)) {
    throw new Error(`${label} uses a sentinel digest.`);
  }
}

async function readContainedRegularFile(
  root: string,
  relativePath: string,
  maxBytes: number,
): Promise<Buffer> {
  if (!isCanonicalRelativePath(relativePath)) {
    throw new Error(`Declared source path is unsafe: ${relativePath}`);
  }
  const full = join(root, ...relativePath.split('/'));
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(full);
  } catch {
    throw new Error(`Official source file is missing: ${relativePath}`);
  }
  if (info.isSymbolicLink()) {
    throw new Error(`Official source file is a symlink: ${relativePath}`);
  }
  if (!info.isFile()) {
    throw new Error(`Official source file is not a regular file: ${relativePath}`);
  }
  if (info.size > maxBytes) {
    throw new Error(`Official source file exceeds size bound: ${relativePath}`);
  }
  const resolvedRoot = await realpath(root);
  const resolved = await realpath(full);
  const rel = relative(resolvedRoot, resolved).split(sep).join('/');
  if (rel.startsWith('..') || isAbsolute(rel) || rel !== relativePath) {
    throw new Error(`Official source file escapes the plugin directory: ${relativePath}`);
  }
  const handle = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const bytes = await handle.readFile();
    if (bytes.byteLength > maxBytes) {
      throw new Error(`Official source file exceeds size bound: ${relativePath}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function assertSourceInventory(root: string, declared: Set<string>): Promise<void> {
  const seen = new Set<string>();
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      const info = await lstat(full);
      const rel = relative(root, full).split(sep).join('/');
      if (info.isSymbolicLink()) {
        throw new Error(`Official source contains a symlink: ${rel}`);
      }
      if (info.isDirectory()) {
        const allowedDir = [...declared].some((path) => path === rel || path.startsWith(`${rel}/`));
        if (!allowedDir) {
          throw new Error(`Official source has an undeclared directory: ${rel}`);
        }
        await walk(full);
        continue;
      }
      if (!info.isFile()) {
        throw new Error(`Official source contains a special file: ${rel}`);
      }
      if (!declared.has(rel)) {
        throw new Error(`Official source contains an undeclared file: ${rel}`);
      }
      seen.add(rel);
    }
  };
  await walk(root);
  for (const path of declared) {
    if (!seen.has(path)) {
      throw new Error(`Official source is missing declared file: ${path}`);
    }
  }
}

function randomDirectorySuffix(): string {
  return createHash('sha256').update(`${process.pid}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 16);
}
