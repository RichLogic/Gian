import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceRoot = join(root, 'catalog/proxy-information/evidence');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const repository = 'RichLogic/Gian-Proxies';
const notes = {
  codex: {
    id: 'codex', directory: 'codex',
    zh: '将受管 Codex CLI 更新至 0.159.2；Proxy 的 app-server 桥接和 gian.proxy 线协议不变。本次发行未运行真实模型 Turn。',
    en: 'Update the managed Codex CLI to 0.159.2 without changing the Proxy app-server bridge or gian.proxy wire contract. Real model turns were not run for this release.',
  },
  dsh: {
    id: 'ai.deepseek.harness', directory: 'ai.deepseek.harness',
    zh: '适配 DeepSeek Harness 0.1.5-rc.3 的完整能力面，支持文件与图片输入、Steer、Fork、结构化问题以及计划和 Diff 事件；随包内置 Bridge 0.1.5。',
    en: 'Adapt the full DeepSeek Harness 0.1.5-rc.3 capability surface: file and image input, steer, fork, structured questions, and plan and diff events, with bundled Bridge 0.1.5.',
  },
  kimi: {
    id: 'kimi', directory: 'kimi',
    zh: '按原生 step 分开投影助手文本和思考，工具结果保持命令、文件和搜索呈现；修复复用 durable seq 的 volatile 帧与 Usage 事件身份。已完成 Turn 后的空闲会话支持 Fork 和 Sidechat，指定 Turn 的 Fork 仍不可用。本版不改变 Proxy 线协议，也不改变 Kimi Code 2.1.1 Runtime。',
    en: 'Project assistant text and thinking separately for each native step, preserve command, file and search tool-result presentation, and fix volatile frames that reuse the durable sequence and usage event identities. Idle sessions after a completed turn support fork and side chat; forking at a specific turn remains unavailable. The Proxy wire protocol and Kimi Code 2.1.1 Runtime pin are unchanged.',
  },
  zcode: {
    id: 'com.zhipu.zcode', directory: 'com.zhipu.zcode',
    zh: '保持 ZCode CLI 0.16.9 的固定源码与能力，仅缩短托管 Runtime 资产名，使官方 GitHub CDN 重定向符合 Gian 0.6.3 的 URL 长度边界。',
    en: 'Keep the pinned ZCode CLI 0.16.9 source and capabilities; shorten only the managed Runtime asset name so the official GitHub CDN redirect fits Gian 0.6.3 URL bounds.',
  },
};

function releaseEvidence(release) {
  return {
    tag: release.tag_name,
    date: release.published_at,
    url: release.html_url,
    body: release.body,
    assets: release.assets.map(asset => ({
      name: asset.name,
      url: asset.browser_download_url,
      size: asset.size,
      digest: asset.digest,
    })),
  };
}

function capture(sequence, certificatePath, baseIndexPath, releaseDir, providers) {
  assert.ok(Number.isSafeInteger(sequence) && sequence > 0);
  assert.ok(providers.length > 0 && new Set(providers).size === providers.length);
  const certificateBytes = readFileSync(certificatePath);
  const certificate = JSON.parse(certificateBytes);
  assert.equal(certificate.status, 'PASS');
  const certificateDigest = sha256(certificateBytes);
  const base = json(baseIndexPath);
  assert.equal(base.sourceId, 'gian-official');
  assert.ok(base.sequence < sequence);
  const releaseRecord = json(join(evidenceRoot, 'releases.json'));
  const manifestRecords = json(join(evidenceRoot, 'manifests.json'));
  const translations = json(join(root, 'catalog/proxy-information/history-copy.en.json'));
  const selected = new Map();

  for (const provider of providers) {
    const note = notes[provider];
    assert.ok(note, `Unknown provider ${provider}`);
    const record = certificate.proxies.find(item => item.provider === provider);
    assert.ok(record && record.pluginId === note.id);
    const release = json(join(releaseDir, `${record.tag}.release.json`));
    assert.equal(release.tag_name, record.tag);
    assert.equal(release.draft, false);
    assert.equal(release.prerelease, false);
    const releaseUrl = release.html_url;
    const asset = name => {
      const found = release.assets.find(item => item.name === name);
      assert.ok(found && found.digest?.startsWith('sha256:'));
      return found;
    };
    const certificateAsset = asset('certificate.json');
    assert.equal(certificateAsset.digest, `sha256:${certificateDigest}`);
    const archiveAsset = asset(record.archive);
    const qualifiedArchive = certificate.assets.find(item => item.name === record.archive);
    assert.equal(archiveAsset.digest, `sha256:${qualifiedArchive?.sha256}`);
    assert.equal(archiveAsset.size, qualifiedArchive.size);
    const manifestAsset = asset(`${record.archive}.manifest.json`);
    const manifestBytes = readFileSync(join(releaseDir, manifestAsset.name));
    assert.equal(manifestAsset.digest, `sha256:${sha256(manifestBytes)}`);
    const manifest = JSON.parse(manifestBytes);
    assert.deepEqual(manifest, record.manifest);
    if (record.publishRuntime) {
      const runtimeAsset = asset(record.runtimeAsset);
      assert.equal(runtimeAsset.digest, `sha256:${record.runtime.asset.sha256}`);
      assert.equal(runtimeAsset.size, record.runtime.asset.size);
    }

    assert.ok(!releaseRecord.releases.some(item => item.url === releaseUrl));
    releaseRecord.releases.push(releaseEvidence(release));
    assert.ok(!manifestRecords.some(item => item.url === releaseUrl));
    manifestRecords.push({
      tag: record.tag,
      url: releaseUrl,
      manifestUrl: manifestAsset.browser_download_url,
      digest: manifestAsset.digest,
      assetDigestVerified: true,
      schemaVersion: manifest.schemaVersion,
      pluginId: manifest.id,
      pluginVersion: manifest.pluginVersion,
      protocol: manifest.protocol,
      runtime: manifest.runtime,
      process: manifest.process,
    });

    const historyPath = join(root, 'catalog/proxy-information', note.directory, 'changelog.json');
    const history = json(historyPath);
    assert.ok(!history.entries.some(item => item.version === record.version));
    history.currentVersion = record.version;
    history.entries.unshift({
      version: record.version,
      firstPublishedAt: release.published_at,
      evidenceCoverage: 'detailed',
      distributions: [{
        repository,
        tag: record.tag,
        publishedAt: release.published_at,
        releaseUrl,
        manifestUrl: manifestAsset.browser_download_url,
        manifestSha256: sha256(manifestBytes),
        archive: {
          url: archiveAsset.browser_download_url,
          sha256: qualifiedArchive.sha256,
          size: qualifiedArchive.size,
        },
        runtimeDeclaration: {
          id: manifest.runtime.id,
          versions: manifest.runtime.verifiedVersions,
          basis: 'verified-declaration',
        },
        companionDeclarations: provider === 'dsh'
          ? [{ id: '@gian/dsh-bridge', version: '0.1.5', basis: 'bundled-package-source' }]
          : [],
        protocolRange: manifest.protocol.range,
        manifestSchema: manifest.schemaVersion,
        processScope: manifest.process.scope,
      }],
      changes: [{
        category: 'changed',
        text: note.zh,
        evidence: [releaseUrl, `https://github.com/${repository}/blob/${record.tag}/packages/proxies/${provider}-proxy/README.md`],
      }],
      unknowns: [],
    });
    write(historyPath, history);
    translations[note.zh] = note.en;
    selected.set(note.id, record);
  }

  const current = {
    catalog: `https://github.com/${repository}/releases/tag/catalog-v1.${sequence}.0`,
    sequence,
    sourceId: base.sourceId,
    plugins: base.plugins.map(plugin => {
      const pluginId = plugin.pluginId ?? plugin.id;
      const record = selected.get(pluginId);
      const stable = plugin.stable ?? plugin;
      return {
        id: pluginId,
        displayName: plugin.displayName,
        version: record?.version ?? stable.version ?? stable.pluginVersion,
        protocolRange: record?.manifest.protocol.range ?? stable.protocolRange,
        processScope: record?.manifest.process.scope ?? stable.processScope,
        combination: record ? {
          certificate: { id: certificate.certificateId, sha256: certificateDigest },
          companions: [],
          generationId: `${record.provider}-${record.version}-runtime-${record.runtime.version}`,
          runtime: record.runtime,
        } : stable.combination,
      };
    }),
  };
  assert.equal(current.plugins.length, base.plugins.length);
  assert.equal(selected.size, providers.length);
  releaseRecord.capturedAt = new Date().toISOString();
  releaseRecord.selection = 'Public stable Proxy Releases represented by the retained version histories; withdrawn or prerelease identities are excluded.';
  write(join(evidenceRoot, 'releases.json'), releaseRecord);
  write(join(evidenceRoot, 'manifests.json'), manifestRecords);
  write(join(evidenceRoot, 'current-combinations.json'), current);
  write(join(root, 'catalog/proxy-information/history-copy.en.json'), translations);
  console.log(`Captured ${providers.join(', ')} for Catalog ${sequence}`);
}

const [sequenceText, certificatePath, baseIndexPath, releaseDir, ...providers] = process.argv.slice(2);
if (!sequenceText || !certificatePath || !baseIndexPath || !releaseDir) {
  throw new Error('Usage: capture-proxy-release-evidence <sequence> <certificate> <base-index> <release-dir> <provider...>');
}
capture(Number(sequenceText), certificatePath, baseIndexPath, releaseDir, providers);
