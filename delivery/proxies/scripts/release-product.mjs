import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { proxyDefinitions, assertProxySelfTest, main as buildArtifacts } from './build-proxy-artifacts.mjs';
import { proxyReleaseMetadata, reviewedExternalRuntimeCandidates } from './proxy-release-metadata.mjs';
import { verifySource } from './verify-source.mjs';
import { assertSameCatalogExecutables, assertSelectedCatalogExecutables, selectReleaseDefinitions } from './catalog-docs-policy.mjs';

const repository = 'RichLogic/Gian-Proxies';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseSelection = JSON.parse(readFileSync(join(root, 'release-selection.json')));
const shipping = selectReleaseDefinitions(proxyDefinitions, releaseSelection);
const output = join(root, 'artifacts/release');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path));
const put = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + '\n'); };
function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.status !== 0) throw new Error(`${binary} ${args.join(' ')} failed (${result.status})`);
}
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const gh = (...args) => execFileSync('gh', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const asset = path => ({ name: path.split('/').at(-1), size: readFileSync(path).length, sha256: hash(readFileSync(path)) });
const releaseUrl = (tag, name) => `https://github.com/${repository}/releases/download/${tag}/${name}`;

export function validateCertificate(certificate, expected = {}) {
  if (certificate?.schema !== 1 || certificate.model !== 'standalone-proxy-artifacts-v1' || certificate.status !== 'PASS'
    || certificate.repository !== repository || !/^[a-f0-9]{40}$/.test(certificate.revision ?? '')
    || certificate.runner?.environment !== 'github-hosted' || certificate.runner.os !== 'macOS' || certificate.runner.arch !== 'ARM64'
    || !/^[1-9][0-9]*$/.test(certificate.runner.runId ?? '') || !/^[1-9][0-9]*$/.test(certificate.runner.runAttempt ?? '')
    || certificate.certificateId !== `proxies-${certificate.revision}-${certificate.runner.runId}-${certificate.runner.runAttempt}`) throw new Error('Invalid hosted Proxy artifact certificate');
  const age = Date.now() - Date.parse(certificate.completedAt);
  if (!Number.isFinite(age) || age < -60_000 || age > 72 * 3600_000) throw new Error('Proxy artifact certificate expired');
  for (const [key, value] of Object.entries(expected)) {
    const actual = key === 'revision' ? certificate.revision : certificate.runner[key];
    if (actual !== String(value)) throw new Error(`Certificate ${key} mismatch`);
  }
  const required = ['source', 'build', 'proxy-contracts', 'runtime-artifacts', 'archive-self-tests'];
  if (!Array.isArray(certificate.steps) || required.some(id => certificate.steps.filter(s => s.id === id && s.status === 'PASS').length !== 1)
    || certificate.steps.some(s => s.status !== 'PASS')) throw new Error('Incomplete Proxy qualification evidence');
  if (!Array.isArray(certificate.proxies) || certificate.proxies.length !== shipping.length
    || new Set(certificate.proxies.map(p => p.provider)).size !== shipping.length) throw new Error('Incomplete shipping set');
  for (const definition of shipping) {
    const record = certificate.proxies.find(p => p.provider === definition.id);
    const metadata = proxyReleaseMetadata(definition.id);
    if (!record || record.pluginId !== metadata.pluginId || record.version !== metadata.version
      || record.tag !== metadata.tag || !isDeepStrictEqual(record.manifest, definition.manifest)
      || !metadata.runtime.verifiedVersions.includes(record.runtime.version)) throw new Error(`Certificate metadata mismatch: ${definition.id}`);
  }
  if (!Array.isArray(certificate.assets) || !certificate.assets.length) throw new Error('Certificate has no artifacts');
  const names = new Set();
  for (const item of certificate.assets) {
    if (!/^[a-zA-Z0-9._-]+$/.test(item.name) || names.has(item.name)
      || !Number.isSafeInteger(item.size) || item.size <= 0 || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Invalid certificate asset identity');
    names.add(item.name);
  }
  return certificate;
}

function validateBytes(certificate, directory) {
  for (const expected of certificate.assets) {
    const actual = asset(join(directory, expected.name));
    if (!isDeepStrictEqual(expected, actual)) throw new Error(`Artifact differs from qualification: ${expected.name}`);
  }
}

async function build() {
  command('pnpm', ['--filter', '@gian/shared', 'build']);
  command('pnpm', ['--filter', '@gian/proxy-catalog-contract', 'build']);
  command('pnpm', ['--filter', '@gian/dsh-bridge', 'build']);
  for (const definition of shipping) command('pnpm', ['--filter', definition.packageName, 'build']);
  command('pnpm', ['exec', 'tsc', '-p', 'support/runtime-extractor/tsconfig.json']);
}

async function qualify() {
  if (process.env.GITHUB_REPOSITORY !== repository || process.env.GIAN_RUNNER_ENVIRONMENT !== 'github-hosted'
    || process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Qualification requires the GitHub-hosted macOS ARM64 product workflow');
  const steps = [];
  const step = async (id, fn) => { await fn(); steps.push({ id, status: 'PASS' }); };
  await step('source', async () => {
    verifySource();
    if (git('status', '--porcelain', '--untracked-files=no')) throw new Error('Qualification source is dirty');
    command('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main']);
  });
  await step('build', build);
  await step('proxy-contracts', async () => {
    for (const definition of shipping) command('pnpm', ['--filter', definition.packageName, 'test']);
    command('pnpm', ['--filter', '@gian/dsh-bridge', 'test']);
    command('pnpm', ['--filter', '@gian/proxy-catalog-contract', 'test']);
  });
  await step('runtime-artifacts', async () => {
    command(process.execPath, ['scripts/build-managed-runtime-candidates.mjs', '--output', 'artifacts/runtimes']);
    command(process.execPath, ['scripts/verify-managed-runtime-candidates.mjs']);
  });
  rmSync(output, { recursive: true, force: true }); mkdirSync(output, { recursive: true });
  const runtimes = json(join(root, 'artifacts/runtimes/runtime-candidates.json'));
  const proxies = [];
  await step('archive-self-tests', async () => {
    for (const definition of shipping) await buildArtifacts(['--plugin', definition.id, '--output', 'artifacts/proxies']);
    const { extractManagedRuntimeArchive } = await import('../support/runtime-extractor/dist/safe-extract.js');
    for (const definition of shipping) {
      const metadata = proxyReleaseMetadata(definition.id);
      const temporary = mkdtempSync(join(tmpdir(), 'gian-proxy-archive-'));
      try {
        const path = join(root, 'artifacts/proxies', metadata.asset);
        await extractManagedRuntimeArchive(readFileSync(path), temporary);
        if (!isDeepStrictEqual(json(join(temporary, 'manifest.json')), definition.manifest)) throw new Error('Archived Manifest mismatch');
        await assertProxySelfTest(join(temporary, 'proxy.mjs'), definition.manifest);
        for (const companion of definition.bundlePackages) {
          for (const file of companion.files) if (!existsSync(join(temporary, companion.path, file))) throw new Error('Bundled companion is incomplete');
        }
        for (const suffix of ['', '.sha256', '.manifest.json']) cpSync(`${path}${suffix}`, join(output, `${metadata.asset}${suffix}`));
      } finally { rmSync(temporary, { recursive: true, force: true }); }
      let runtime;
      if (metadata.runtime.distribution === 'external-app') {
        const reviewed = reviewedExternalRuntimeCandidates[definition.id];
        if (!reviewed || !metadata.runtime.verifiedVersions.includes(reviewed.version)) throw new Error('Missing reviewed external Runtime identity');
        runtime = { kind: 'external-app', runtimeId: metadata.runtime.id, version: reviewed.version, artifactSha256: reviewed.sha256 };
      } else {
        const candidate = runtimes.candidates.find(r => r.provider === definition.id);
        if (!candidate || !metadata.runtime.verifiedVersions.includes(candidate.version)) throw new Error('Runtime candidate version mismatch');
        cpSync(join(root, 'artifacts/runtimes', candidate.asset.name), join(output, candidate.asset.name));
        runtime = { kind: 'native-binary', runtimeId: metadata.runtime.id, version: candidate.version,
          asset: { url: candidate.asset.url, sha256: candidate.asset.sha256, size: candidate.asset.size },
          format: candidate.format, entryRelativePath: candidate.entryRelativePath };
      }
      proxies.push({ provider: definition.id, pluginId: metadata.pluginId, version: metadata.version,
        tag: metadata.tag, archive: metadata.asset, manifest: definition.manifest, runtime,
        runtimeAsset: runtimes.candidates.find(r => r.provider === definition.id)?.asset.name ?? null,
        publishRuntime: runtimes.candidates.find(r => r.provider === definition.id)?.asset.publish ?? false });
    }
  });
  const revision = git('rev-parse', 'HEAD');
  const runner = { environment: process.env.GIAN_RUNNER_ENVIRONMENT, os: process.env.RUNNER_OS, arch: process.env.RUNNER_ARCH,
    runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT };
  const certificate = { schema: 1, model: 'standalone-proxy-artifacts-v1', status: 'PASS', repository, revision, runner,
    certificateId: `proxies-${revision}-${runner.runId}-${runner.runAttempt}`, completedAt: new Date().toISOString(), steps,
    protocolPackage: json(join(root, 'protocol-package.json')), proxies,
    assets: readdirSync(output).sort().map(name => asset(join(output, name))),
    exclusions: ['App/Desktop acceptance', 'Host/Web journeys', 'real Provider turns', 'external ZCode App execution'] };
  validateCertificate(certificate);
  put(join(output, 'certificate.json'), certificate);
  console.log(`Qualified ${proxies.length} exact Proxy archives; no App or real Provider acceptance claimed`);
}

function readCertified(directory) {
  const certificate = validateCertificate(json(join(directory, 'certificate.json')), {
    revision: process.env.CERTIFIED_SHA, runId: process.env.CERTIFICATION_RUN_ID, runAttempt: process.env.CERTIFICATION_RUN_ATTEMPT,
  });
  const run = JSON.parse(gh('api', `repos/${repository}/actions/runs/${certificate.runner.runId}`));
  if (run.status !== 'completed' || run.conclusion !== 'success' || run.path !== '.github/workflows/qualify.yml'
    || run.event !== 'workflow_dispatch' || run.head_repository.full_name !== repository || run.head_sha !== certificate.revision
    || String(run.run_attempt) !== certificate.runner.runAttempt) throw new Error('Unauthenticated qualification workflow');
  command('git', ['merge-base', '--is-ancestor', certificate.revision, 'origin/main']);
  validateBytes(certificate, directory);
  return certificate;
}

function publishRelease(tag, paths, notes, latest = false) {
  const expected = paths.map(asset).sort((a, b) => a.name.localeCompare(b.name));
  const inspect = () => {
    const result = spawnSync('gh', ['api', `repos/${repository}/releases/tags/${tag}`], { encoding: 'utf8' });
    if (result.status !== 0) return false;
    const release = JSON.parse(result.stdout);
    if (release.draft || release.prerelease || release.tag_name !== tag || release.assets.length !== expected.length) throw new Error(`Existing immutable release differs: ${tag}`);
    for (const item of expected) {
      const remote = release.assets.find(a => a.name === item.name);
      if (!remote || remote.size !== item.size || remote.digest !== `sha256:${item.sha256}`) throw new Error(`Published asset mismatch: ${tag}/${item.name}`);
    }
    return true;
  };
  if (inspect()) return;
  command('gh', ['release', 'create', tag, ...paths, '--repo', repository, '--verify-tag', latest ? '--latest' : '--latest=false', '--title', tag, '--notes', notes]);
  if (!inspect()) throw new Error('Published release cannot be verified');
}

async function publish(directory) {
  const certificate = readCertified(directory);
  if (process.env.GITHUB_REPOSITORY !== repository) throw new Error('Wrong publication repository');
  for (const record of certificate.proxies) {
    if (git('rev-parse', `refs/tags/${record.tag}^{commit}`) !== certificate.revision) throw new Error('Maintainer must authorize an immutable tag at the qualified commit');
    const names = [record.archive, `${record.archive}.sha256`, `${record.archive}.manifest.json`, 'certificate.json'];
    if (record.publishRuntime) names.push(record.runtimeAsset);
    publishRelease(record.tag, names.map(name => join(directory, name)),
      `Independent Proxy ${record.version}. Exact hosted artifacts from ${certificate.certificateId}. DSH includes its Bridge. ZCode remains an external-App integration with upstream standalone limitations. No App or real-provider acceptance is claimed.`);
  }
}

function authorizeCatalogPublication(sequence, issuedAt) {
  if (!Number.isSafeInteger(sequence) || sequence <= 6 || !Number.isFinite(Date.parse(issuedAt))) throw new Error('Catalog sequence must exceed the legacy sequence 6 and have an explicit issue time');
  for (const repo of [repository]) {
    const releases = JSON.parse(gh('api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`)).flat();
    const existing = releases.filter(r => !r.draft && !r.prerelease && /^catalog-v1\.[1-9][0-9]*\.0$/.test(r.tag_name));
    if (existing.some(r => Number(r.tag_name.split('.')[1]) >= sequence)) throw new Error('Catalog sequence is not newer than all published generations');
  }
  const tag = `catalog-v1.${sequence}.0`;
  if (git('rev-parse', `refs/tags/${tag}^{commit}`) !== git('rev-parse', 'HEAD')) throw new Error('Maintainer must authorize the exact Catalog source tag');
  return tag;
}

async function catalog(directory, sequence, issuedAt) {
  const certificate = readCertified(directory);
  const tag = authorizeCatalogPublication(sequence, issuedAt);
  command('pnpm', ['--filter', '@gian/shared', 'build']);
  command('pnpm', ['--filter', '@gian/proxy-catalog-contract', 'build']);
  const { compileOfficialCatalogSource, writeCompiledCatalogBundle } = await import('../packages/proxy-catalog-contract/dist/src/index.js');
  const source = join(root, 'output/catalog-source');
  rmSync(source, { recursive: true, force: true });
  cpSync(join(root, 'catalog/official-source'), source, { recursive: true });
  const inherited = await inheritCatalogExecutables(source, sequence);
  const { projectInformation } = await import('../catalog/proxy-information/project.mjs');
  const catalogRecords = inherited.previous.plugins.map(plugin => certificate.proxies.find(record => record.pluginId === plugin.pluginId)
    ?? { pluginId: plugin.pluginId, version: plugin.stable.pluginVersion, runtime: plugin.stable.combination.runtime });
  const { localizations } = projectInformation(source, catalogRecords);
  for (const record of certificate.proxies) {
    const release = JSON.parse(gh('api', `repos/${repository}/releases/tags/${record.tag}`));
    if (release.draft || release.prerelease) throw new Error('Catalog cannot reference a draft Proxy');
    for (const name of [record.archive, `${record.archive}.manifest.json`, 'certificate.json', ...(record.publishRuntime ? [record.runtimeAsset] : [])]) {
      const remote = release.assets.find(a => a.name === name);
      const local = asset(join(directory, name));
      if (!remote || remote.size !== local.size || remote.digest !== `sha256:${local.sha256}`) throw new Error(`Catalog source asset differs: ${name}`);
    }
    const coordinate = name => { const a = asset(join(directory, name)); return { url: releaseUrl(record.tag, name), size: a.size, sha256: a.sha256 }; };
    const entryPath = join(source, 'plugins', record.pluginId, 'entry.json');
    const entry = json(entryPath);
    entry.channels.stable = { pluginVersion: record.version, manifest: coordinate(`${record.archive}.manifest.json`),
      artifacts: { 'darwin-arm64': coordinate(record.archive) }, combination: {
        generationId: `${record.provider}-${record.version}-runtime-${record.runtime.version}`,
        certificate: { id: certificate.certificateId, sha256: hash(readFileSync(join(directory, 'certificate.json'))) },
        runtime: record.runtime, companions: [],
      } };
    put(entryPath, entry);
    put(join(source, 'plugins', record.pluginId, 'sidecar.json'), record.manifest);
  }
  if (!process.env.GIAN_CATALOG_SIGNING_KEY_PEM) throw new Error('Configure the existing GIAN_CATALOG_SIGNING_KEY_PEM in Gian-Proxies; never generate a replacement');
  const { officialCatalogSourcePolicy } = await import('../packages/shared/dist/index.js');
  const policy = officialCatalogSourcePolicy();
  const bundle = await compileOfficialCatalogSource({ sourceRoot: source, sequence, issuedAt, localizations,
    signingKey: { keyId: 'gian-official-catalog-2026-09', privateKey: process.env.GIAN_CATALOG_SIGNING_KEY_PEM },
    allowedArtifactRepositories: inherited.repositories,
    allowedRuntimeAssetPrefixes: [...policy.runtimeAssetPrefixes, `https://github.com/${repository}/releases/download/`],
  });
  assertSelectedCatalogExecutables(inherited.previous, bundle.index, certificate.proxies.map(record => record.pluginId));
  await writeCompiledCatalogBundle(join(root, 'output/catalog-bundle'), bundle.files);
  const { stageOfficialCatalogRelease } = await import('./stage-official-catalog-release.mjs');
  const target = join(root, 'output/catalog-release');
  await stageOfficialCatalogRelease({ bundleDir: join(root, 'output/catalog-bundle'), outputDir: target });
  publishRelease(tag, readdirSync(target).sort().map(name => join(target, name)),
    `Signed official Catalog sequence ${sequence}. Updated selected Proxy/Runtime combinations from ${certificate.certificateId}; excluded Proxies retain exact signed coordinates from ${releaseSelection.baseCatalogTag}. No App release.`, true);
}

async function inheritCatalogExecutables(source, sequence) {
  const { verifyCatalogBundleFiles, parseGitHubReleaseAssetUrl } = await import('../packages/proxy-catalog-contract/dist/src/index.js');
  const { officialCatalogSourcePolicy } = await import('../packages/shared/dist/index.js');
  const policy = officialCatalogSourcePolicy();
  const temporary = mkdtempSync(join(tmpdir(), 'gian-catalog-base-'));
  try {
    const base = JSON.parse(gh('api', `repos/${repository}/releases/tags/${releaseSelection.baseCatalogTag}`));
    if (base.draft || base.prerelease) throw new Error('Base Catalog must be a stable public release');
    command('gh', ['release', 'download', releaseSelection.baseCatalogTag, '--repo', repository, '--dir', temporary]);
    const files = new Map(readdirSync(temporary).map(name => [name.replaceAll('__', '/'), readFileSync(join(temporary, name))]));
    if (files.size !== readdirSync(temporary).length) throw new Error('Duplicate base Catalog asset path');
    const previous = verifyCatalogBundleFiles({ files, pinnedPublicKeys: policy.pinnedPublicKeys, expectedSourceId: policy.sourceId });
    if (`catalog-v1.${previous.sequence}.0` !== releaseSelection.baseCatalogTag || previous.sequence >= sequence) throw new Error('Signed base Catalog identity mismatch');
    const repositories = [...new Set([...policy.artifactRepositories, repository])];
    for (const plugin of previous.plugins) {
      const stable = plugin.stable;
      if (!stable.manifest || !stable.combination || !Object.keys(stable.artifacts).length) throw new Error('Base combination is not installable');
      let manifestRelease;
      for (const ref of [stable.manifest, ...Object.values(stable.artifacts)]) {
        const coordinate = parseGitHubReleaseAssetUrl(ref.url, repositories);
        if (!coordinate) throw new Error('Unapproved base artifact coordinate');
        const release = JSON.parse(gh('api', `repos/${coordinate.repository}/releases/tags/${coordinate.tag}`));
        const remote = release.assets.find(asset => asset.name === coordinate.asset);
        if (release.draft || release.prerelease || !remote || remote.size !== ref.size || remote.digest !== `sha256:${ref.sha256}`) throw new Error('Base published artifact changed');
        if (ref === stable.manifest) manifestRelease = { release, coordinate };
      }
      if (manifestRelease.release.assets.find(asset => asset.name === 'certificate.json')?.digest !== `sha256:${stable.combination.certificate.sha256}`) throw new Error('Base certificate digest mismatch');
      const entryPath = join(source, 'plugins', plugin.pluginId, 'entry.json');
      const entry = json(entryPath);
      entry.channels.stable = { pluginVersion: stable.pluginVersion, manifest: stable.manifest, artifacts: stable.artifacts, combination: stable.combination };
      put(entryPath, entry);
      const sidecarPath = join(source, 'plugins', plugin.pluginId, 'sidecar.json');
      command('gh', ['release', 'download', manifestRelease.coordinate.tag, '--repo', manifestRelease.coordinate.repository,
        '--pattern', manifestRelease.coordinate.asset, '--output', sidecarPath, '--clobber']);
      const bytes = readFileSync(sidecarPath);
      if (bytes.length !== stable.manifest.size || hash(bytes) !== stable.manifest.sha256) throw new Error('Base Manifest bytes changed');
    }
    return { previous, repositories };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

async function catalogDocs(directory, sequence, issuedAt) {
  const tag = authorizeCatalogPublication(sequence, issuedAt);
  if (process.env.GITHUB_REPOSITORY !== repository) throw new Error('Wrong publication repository');
  const { compileOfficialCatalogSource, writeCompiledCatalogBundle, verifyCatalogBundleFiles,
    parseGitHubReleaseAssetUrl } = await import('../packages/proxy-catalog-contract/dist/src/index.js');
  const { officialCatalogSourcePolicy } = await import('../packages/shared/dist/index.js');
  const policy = officialCatalogSourcePolicy();
  const files = new Map(readdirSync(directory).map(name => [name.replaceAll('__', '/'), readFileSync(join(directory, name))]));
  if (files.size !== readdirSync(directory).length) throw new Error('Duplicate Catalog asset path');
  const previous = verifyCatalogBundleFiles({ files, pinnedPublicKeys: policy.pinnedPublicKeys, expectedSourceId: policy.sourceId });
  if (`catalog-v1.${previous.sequence}.0` !== process.env.BASE_CATALOG_TAG || previous.sequence >= sequence) {
    throw new Error('Documentation base does not match the selected signed Catalog');
  }
  const source = join(root, 'output/catalog-docs-source');
  rmSync(source, { recursive: true, force: true });
  cpSync(join(root, 'catalog/official-source'), source, { recursive: true });
  const repositories = [...new Set([...policy.artifactRepositories, repository])];
  const releases = new Map();
  const checkPublished = ref => {
    const coordinate = parseGitHubReleaseAssetUrl(ref.url, repositories);
    if (!coordinate) throw new Error('Unapproved inherited Proxy coordinate');
    const key = `${coordinate.repository}/${coordinate.tag}`;
    if (!releases.has(key)) releases.set(key, JSON.parse(gh('api', `repos/${coordinate.repository}/releases/tags/${coordinate.tag}`)));
    const release = releases.get(key);
    const remote = release.assets.find(item => item.name === coordinate.asset);
    if (release.draft || release.prerelease || release.tag_name !== coordinate.tag
      || !remote || remote.size !== ref.size || remote.digest !== `sha256:${ref.sha256}`) {
      throw new Error(`Inherited published artifact differs: ${ref.url}`);
    }
    return { coordinate, release };
  };
  for (const plugin of previous.plugins) {
    const stable = plugin.stable;
    if (!stable.manifest || !stable.combination || !Object.keys(stable.artifacts).length) {
      throw new Error('Documentation refresh requires an already certified installable combination');
    }
    const { coordinate, release } = checkPublished(stable.manifest);
    for (const ref of Object.values(stable.artifacts)) if (ref) checkPublished(ref);
    const proof = release.assets.find(item => item.name === 'certificate.json');
    if (proof?.digest !== `sha256:${stable.combination.certificate.sha256}`) throw new Error('Inherited publication proof differs');
    const sidecarPath = join(source, 'plugins', plugin.pluginId, 'sidecar.json');
    command('gh', ['release', 'download', coordinate.tag, '--repo', coordinate.repository,
      '--pattern', coordinate.asset, '--output', sidecarPath, '--clobber']);
    const sidecar = readFileSync(sidecarPath);
    if (sidecar.length !== stable.manifest.size || hash(sidecar) !== stable.manifest.sha256) throw new Error('Inherited Manifest digest mismatch');
    const entryPath = join(source, 'plugins', plugin.pluginId, 'entry.json');
    const entry = json(entryPath);
    entry.channels.stable = { pluginVersion: stable.pluginVersion, manifest: stable.manifest,
      artifacts: stable.artifacts, combination: stable.combination };
    put(entryPath, entry);
  }
  const { projectInformation } = await import('../catalog/proxy-information/project.mjs');
  const { localizations } = projectInformation(source, previous.plugins.map(plugin => ({
    pluginId: plugin.pluginId, version: plugin.stable.pluginVersion, runtime: plugin.stable.combination.runtime,
  })));
  if (!process.env.GIAN_CATALOG_SIGNING_KEY_PEM) throw new Error('Existing Catalog signing key is required');
  const bundle = await compileOfficialCatalogSource({ sourceRoot: source, sequence, issuedAt, localizations,
    signingKey: { keyId: 'gian-official-catalog-2026-09', privateKey: process.env.GIAN_CATALOG_SIGNING_KEY_PEM },
    allowedArtifactRepositories: repositories,
    allowedRuntimeAssetPrefixes: [...policy.runtimeAssetPrefixes, `https://github.com/${repository}/releases/download/`],
  });
  assertSameCatalogExecutables(previous, bundle.index);
  await writeCompiledCatalogBundle(join(root, 'output/catalog-bundle'), bundle.files);
  const { stageOfficialCatalogRelease } = await import('./stage-official-catalog-release.mjs');
  const target = join(root, 'output/catalog-release');
  await stageOfficialCatalogRelease({ bundleDir: join(root, 'output/catalog-bundle'), outputDir: target });
  publishRelease(tag, readdirSync(target).sort().map(name => join(target, name)),
    `Signed Catalog sequence ${sequence}: Chinese and English Proxy descriptions, tutorials and version histories. Compatible clients follow their UI language. Executable and certification coordinates are unchanged from ${process.env.BASE_CATALOG_TAG}; no Proxy or App release. Older clients retain the original v1 documents.`, true);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, directory = 'certification', sequence, issuedAt] = process.argv.slice(2);
  if (mode === 'build') await build();
  else if (mode === 'qualify') await qualify();
  else if (mode === 'publish') await publish(resolve(directory));
  else if (mode === 'catalog') await catalog(resolve(directory), Number(sequence), issuedAt);
  else if (mode === 'catalog-docs') await catalogDocs(resolve(directory), Number(sequence), issuedAt);
  else throw new Error('Expected build, qualify, publish, catalog or catalog-docs');
}
