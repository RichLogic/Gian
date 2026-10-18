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
  claude: {
    id: 'claude', directory: 'claude',
    zh: '将受管 Claude Code Runtime 更新至 2.1.302（2026-10-16 已晋升至 /latest、npm latest 与 GitHub latest；SHA-256 与大小经官方清单校验）。上游 2.1.302 变更不涉及线协议或启动面，全部相关命令行标志已在新二进制上复验。线协议范围不变。产物经过托管认证；本次发行未运行真实模型 Turn。',
    en: 'Update the managed Claude Code Runtime to 2.1.302 (promoted to /latest, npm latest and GitHub latest on 2026-10-16; SHA-256 and size verified against the official manifest). Upstream 2.1.302 has no wire-protocol or spawn-surface changes; every flag the adapter spawns or parses was re-verified on the new binary. The wire protocol range is unchanged. Artifacts pass hosted qualification; real model turns were not run for this release.',
  },
  codex: {
    id: 'codex', directory: 'codex',
    zh: '将受管 Codex CLI 更新至 0.163.0（0.163 系列首个稳定版，2026-10-15 发布；与官方 rust-v0.163.0 GitHub 资产摘要一致）。逐文件比对 app-server 协议 schema：Proxy 使用的全部协议面仅为增量可选字段，ServerRequest 逐字节一致，Proxy 调用的方法无删除或变更（未使用的实时语音枚举另有变化）；0.162.1 与 0.163.0 的无凭证 initialize 握手一致。线协议不变。产物经过托管认证；本次发行未运行真实模型 Turn。',
    en: 'Update the managed Codex CLI to 0.163.0 (first stable of the 0.163 line, published 2026-10-15; matching the official rust-v0.163.0 GitHub asset digest). Exact old/new app-server schema comparison shows additive-only changes across every Proxy-used protocol surface (optional fields, new read-state notifications), a byte-identical ServerRequest, and no removed or changed method the Proxy calls (unrelated realtime voice enums also changed; the Proxy does not use them); no-credential initialize handshakes are identical on 0.162.1 and 0.163.0. The wire contract is unchanged. Artifacts pass hosted qualification; real model turns were not run for this release.',
  },
  dsh: {
    id: 'ai.deepseek.harness', directory: 'ai.deepseek.harness',
    // Next publish copy. changelog.md's top snapshot stays the published
    // Proxy 0.3.3 / Runtime 0.1.5-rc.3 projection until this capture runs.
    zh: '适配 DeepSeek Harness 0.2.0-rc.2：会话日志升到 V4，已删除的模型选择回退到当前默认模型并提示重选；新增 Side Chat 与原生会话 Fork。随包内置 Bridge 0.1.6。本次发行未运行真实模型 Turn。',
    en: 'Support DeepSeek Harness 0.2.0-rc.2: session logs move to V4, a saved model that is no longer advertised falls back to the current default with a prompt to reselect, and Side Chat plus native session fork are now available. Bundled Bridge is 0.1.6. Real model turns were not run for this release.',
  },
  kimi: {
    id: 'kimi', directory: 'kimi',
    zh: '将 Kimi Code Runtime 更新至 2.2.0（与官方 @moonshot-ai/kimi-code@2.2.0 GitHub 资产摘要一致）。2.1.1 到 2.2.0 的 server-api 参考差异仅为新增（Remote Control 端点与可选字段），实况 2.2.0 /openapi.json 与 /asyncapi.json 探测确认本 Proxy 使用的全部 REST 路由与 WebSocket 消息类型。适配器与线协议范围不变。产物经过托管认证；本次发行未运行真实模型 Turn。',
    en: 'Update the Kimi Code Runtime to 2.2.0 (matching the official @moonshot-ai/kimi-code@2.2.0 GitHub asset digest). The published server-api reference diff from 2.1.1 to 2.2.0 is purely additive (Remote Control endpoints, optional fields), and a live 2.2.0 /openapi.json + /asyncapi.json probe confirmed every REST route and WebSocket message type this Proxy uses. The adapter and the wire protocol range are unchanged. Artifacts pass hosted qualification; real model turns were not run for this release.',
  },
  grok: {
    id: 'grok', directory: 'grok',
    zh: '将受管 Grok CLI 更新至 1.0.62（已晋升 stable：x.ai/cli、官方 GCS 镜像与 npm @xai-official/grok latest 一致；x.ai 与 GCS 字节完全相同）。新二进制已验证启动标志与 ACP initialize 契约（agentVersion 1.0.62、grokShell、能力形状不变，保留原始握手证据）；1.0.53–1.0.62 的逐版本说明在可访问的官方更新日志中 NOT_OBSERVED（该页最新条目仍为 1.0.52），如实记录而非阻止已晋升的稳定通道。已知限制不变：auto/always_approve 快照下的原生批准卡片现象未验证（需要已认证会话）。线协议范围不变。产物经过托管认证；本次发行未运行真实模型 Turn。',
    en: 'Update the managed Grok CLI to 1.0.62 (promoted to stable on x.ai/cli, the official GCS mirror and npm @xai-official/grok latest; bytes identical from x.ai and GCS). The spawn flags and ACP initialize contract are verified on the new binary (agentVersion 1.0.62, grokShell, unchanged capability shape; raw handshake evidence preserved); per-version notes for 1.0.53–1.0.62 are NOT_OBSERVED in the accessible official changelog, whose latest entry remains 1.0.52 — recorded honestly rather than blocking the promoted stable channel. Known limitation unchanged: native approval cards under auto/always_approve snapshots remain unverified (an authenticated session is required). The wire protocol range is unchanged. Artifacts pass hosted qualification; real model turns were not run for this release.',
  },
  zcode: {
    id: 'com.zhipu.zcode', directory: 'com.zhipu.zcode',
    zh: '托管 Runtime 更新至已审查的 ZCode v3.15.1 源码 aac4755（上游 CLI 版本仍为 0.16.9），保留独立认证与模型目录集成。修复新版 MCP 表单提问：自由文本正常输入、可选字段保持可选、重复题目使用索引答案避免覆盖，并原样保留字符串。产物经过托管认证；本次发行未运行真实模型 Turn。',
    en: 'Update the managed Runtime to reviewed ZCode v3.15.1 source aac4755 (upstream CLI still reports 0.16.9), retaining standalone authentication and model catalog integration. Fix native MCP forms: free-text inputs, optional fields, indexed answers for repeated questions, and exact string preservation. Artifacts pass hosted qualification; real model turns were not run for this release.',
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
  const ownerDirect = certificate.releaseMode === 'owner-authorized-no-tests';
  assert.equal(certificate.status, ownerDirect ? 'NOT_RUN' : 'PASS');
  if (ownerDirect) {
    assert.deepEqual(providers, ['claude']);
    assert.equal(certificate.proxies.length, 1);
    assert.ok(['0.3.4', '0.3.5'].includes(certificate.proxies[0].version));
  }
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
          ? [{ id: '@gian/dsh-bridge', version: '0.1.6', basis: 'bundled-package-source' }]
          : [],
        protocolRange: manifest.protocol.range,
        manifestSchema: manifest.schemaVersion,
        processScope: manifest.process.scope,
      }],
      changes: [{
        category: 'changed',
        text: note.zh,
        evidence: [releaseUrl, `https://github.com/${repository}/blob/${record.tag}/${provider === 'claude'
          ? 'packages/proxies/cc-proxy/src/protocol/v2-adapter.ts'
          : `packages/proxies/${provider}-proxy/README.md`}`],
      }],
      unknowns: ownerDirect ? ['All tests, Runtime probes and archive self-tests are NOT_RUN by Owner instruction.'] : [],
    });
    write(historyPath, history);
    translations[note.zh] = note.en;
    if (ownerDirect) translations['Owner 指定未运行任何测试、Runtime 探测或包自检。'] =
      'The Owner explicitly requested publication without tests, Runtime probes or archive self-tests.';
    if (ownerDirect) translations['All tests, Runtime probes and archive self-tests are NOT_RUN by Owner instruction.'] =
      'All tests, Runtime probes and archive self-tests are NOT_RUN by Owner instruction.';
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
