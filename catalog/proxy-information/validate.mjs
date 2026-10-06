import assert from 'node:assert/strict';
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const repo = resolve(root, '../..');
const requireContract = createRequire(join(repo, 'packages/proxy-catalog-contract/package.json'));
const semver = requireContract('semver');
const { fromMarkdown } = await import(pathToFileURL(requireContract.resolve('mdast-util-from-markdown')).href);
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const categories = ['added', 'changed', 'fixed', 'attention'];
const labels = { added: '新增', changed: '变更', fixed: '修复', attention: '注意事项' };
const folders = { claude: 'cc-proxy', codex: 'codex-proxy', kimi: 'kimi-proxy',
  'ai.deepseek.harness': 'dsh-proxy', 'com.zhipu.zcode': 'zcode-proxy', grok: 'grok-proxy' };

function containedFile(path, max = 256 * 1024) {
  const resolved = realpathSync(path);
  const rel = relative(realpathSync(root), resolved);
  assert.ok(rel && !rel.startsWith('..') && !rel.startsWith('/'), 'File escapes the review root');
  assert.ok(statSync(path).isFile() && statSync(path).size <= max, 'Invalid or oversized review file');
  return readFileSync(path, 'utf8');
}

function text(node) {
  return node.value ?? (node.children ?? []).map(text).join('');
}

export function tutorialChapters(markdown, locale = 'zh-CN') {
  const ast = fromMarkdown(markdown);
  const headings = ast.children.filter(n => n.type === 'heading' && n.depth === 2).map(text);
  const expected = locale === 'en'
    ? ['What it does in Gian', 'Capabilities and limitations', 'Runtime architecture', 'Installation and dependencies',
      'First use', 'HOME and isolation', 'Reverse proxies and custom endpoints', 'Operational notes', 'Troubleshooting']
    : ['在 Gian 中做什么', '支持的能力与限制', '运行原理与进程关系', '安装与依赖',
      '第一次使用', 'HOME 与隔离', '反向代理与自定义端点', '操作注意事项', '故障排查'];
  assert.deepEqual(headings, expected.map((name, i) => `${i + 1}. ${name}`), 'Tutorial chapter contract differs');
  const positions = ast.children.flatMap((n, i) => n.type === 'heading' && n.depth === 2 ? [i] : []);
  for (let i = 0; i < positions.length; i++) {
    const body = ast.children.slice(positions[i] + 1, positions[i + 1] ?? ast.children.length);
    assert.ok(body.some(n => text(n).trim().length > 0), 'Tutorial chapter must not be empty');
  }
  const visit = node => {
    assert.notEqual(node.type, 'html', 'Authored tutorial must not contain HTML');
    if (node.url) {
      assert.ok(!/^(?:javascript|data|file|vbscript):/i.test(node.url), 'Unsafe Markdown URL');
      if (/^[a-z]+:/i.test(node.url)) assert.ok(node.url.startsWith('https://'), 'External links must use HTTPS');
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(ast);
  return positions.map((position, i) => markdown.slice(ast.children[position].position.start.offset,
    positions[i + 1] === undefined ? markdown.length : ast.children[positions[i + 1]].position.start.offset));
}

function renderHistory(history, current) {
  let md = `# ${current.displayName}：版本更新\n\n本文件由 changelog.json 的结构化记录投影，按 Proxy 版本倒序。首次发布日期与新仓库分发日期分别记录；未知历史不会用当前版本说明回填。\n\n本次发布组合快照：Proxy **${current.version}**，Runtime **${current.combination.runtime.version}**。这是发布目标，不表示当前机器已安装。\n\n`;
  for (const entry of history.entries) {
    md += `## ${entry.version}\n\n首次公开发布：${entry.firstPublishedAt}（UTC）。\n\n`;
    for (const d of entry.distributions) {
      const basis = d.runtimeDeclaration.basis === 'verified-declaration' ? 'Manifest 兼容声明'
        : d.runtimeDeclaration.basis === 'recommended-declaration' ? '历史推荐声明' : '未记录 CLI 版本';
      md += `- [${d.repository} 分发](${d.releaseUrl})：${d.publishedAt}。\n`;
      md += `- 对应 CLI：${d.runtimeDeclaration.versions.join('、') || '未记录'}（${basis}，不是本机状态）。`;
      if (d.companionDeclarations.length) {
        const bridge = d.companionDeclarations[0];
        md += ` Bridge：${bridge.version}（${bridge.basis === 'bundled-package-source' ? '当前归档对应的源码包' : '该公开 tag 的源码包'}）。`;
      }
      md += '\n';
    }
    md += '\n';
    for (const category of categories) {
      const notes = entry.changes.filter(n => n.category === category);
      if (!notes.length) continue;
      md += `### ${labels[category]}\n\n`;
      for (const n of notes) {
        const links = n.evidence.map((url, i) => `[依据${n.evidence.length > 1 ? i + 1 : ''}](${url})`).join(' ');
        md += `- ${n.text} ${links}\n`;
      }
      md += '\n';
    }
    if (entry.unknowns.length) {
      md += '### 历史证据边界\n\n';
      for (const note of entry.unknowns) md += `- ${note}\n`;
      md += '\n';
    }
  }
  md += '## 已撤回版本\n\n';
  if (!history.withdrawnVersions.length) md += '无。\n';
  for (const item of history.withdrawnVersions) {
    md += `- ${item.version}：${item.withdrawnOn} 已撤回，不可安装。[依据](${item.evidence})\n`;
  }
  return md;
}

export function validateReview({ render = false } = {}) {
  const releases = json(join(root, 'evidence/releases.json')).releases;
  const manifests = json(join(root, 'evidence/manifests.json'));
  const current = json(join(root, 'evidence/current-combinations.json'));
  const observed = new Set();
  let versions = 0;
  let metadataOnly = 0;
  for (const [id, directory] of Object.entries(folders)) {
    const history = JSON.parse(containedFile(join(root, id, 'changelog.json')));
    const manifest = json(join(repo, 'packages/proxies', directory, 'manifest.json'));
    const pkg = json(join(repo, 'packages/proxies', directory, 'package.json'));
    const active = current.plugins.find(p => p.id === id);
    assert.equal(history.schemaVersion, 1);
    assert.equal(history.pluginId, id);
    // Published history is evidence, not the version of an unreleased source
    // candidate. Publication still requires an exact certified snapshot in
    // projectInformation; never fabricate releases to allow development.
    assert.equal(history.currentVersion, active?.version);
    assert.equal(manifest.pluginVersion, pkg.version);
    assert.ok(semver.gte(pkg.version, active.version), 'Source version is older than the published snapshot');
    assert.equal(history.entries.filter(e => e.version === active.version).length, 1, 'Published version must occur exactly once');
    assert.ok(history.entries.length > 0 && history.entries.length <= 100);
    const unique = new Set();
    let previous = null;
    for (const e of history.entries) {
      assert.equal(semver.valid(e.version), e.version);
      assert.ok(!unique.has(e.version), 'Duplicate Proxy version');
      unique.add(e.version);
      if (previous) assert.ok(semver.gt(previous, e.version), 'History must be newest-first');
      previous = e.version;
      assert.ok(!history.withdrawnVersions.some(v => v.version === e.version), 'Withdrawn version is installable');
      assert.ok(['detailed', 'metadata-only'].includes(e.evidenceCoverage));
      if (e.evidenceCoverage === 'metadata-only') {
        assert.ok(e.unknowns.length > 0, 'Legacy gaps must remain visible');
        metadataOnly++;
      }
      assert.ok(e.distributions.length > 0);
      for (const d of e.distributions) {
        const source = releases.find(r => r.url === d.releaseUrl);
        const sidecar = manifests.find(m => m.url === d.releaseUrl);
        assert.ok(source && sidecar, 'Release lacks captured source evidence');
        assert.ok(!observed.has(d.releaseUrl), 'Duplicate distribution');
        observed.add(d.releaseUrl);
        assert.equal(d.tag, source.tag);
        assert.ok(d.tag.endsWith(`-v${e.version}`));
        assert.equal(d.publishedAt, source.date);
        assert.ok(Number.isFinite(Date.parse(d.publishedAt)), 'Invalid release date');
        assert.equal(d.manifestUrl, sidecar.manifestUrl);
        assert.equal(d.manifestSha256, sidecar.digest.replace(/^sha256:/, ''));
        assert.equal(sidecar.assetDigestVerified, true);
        assert.equal(d.protocolRange, sidecar.protocol.range);
        const r = sidecar.runtime ?? {};
        const declared = r.verifiedVersions ?? r.verifiedCliVersions ?? (r.recommendedCliVersion ? [r.recommendedCliVersion] : []);
        assert.deepEqual(d.runtimeDeclaration.versions, declared);
        const basis = r.verifiedVersions || r.verifiedCliVersions ? 'verified-declaration'
          : r.recommendedCliVersion ? 'recommended-declaration' : 'unrecorded';
        assert.equal(d.runtimeDeclaration.basis, basis, 'Runtime evidence was silently promoted');
        const archive = source.assets.find(a => a.name.endsWith('.tar.gz'));
        assert.equal(d.archive?.url, archive?.url);
        assert.equal(d.archive?.sha256, archive?.digest?.replace(/^sha256:/, '') ?? null);
      }
      assert.equal(e.firstPublishedAt, e.distributions.map(d => d.publishedAt).sort()[0]);
      for (const note of e.changes) {
        assert.ok(categories.includes(note.category));
        assert.ok(typeof note.text === 'string' && note.text.length > 0 && note.text.length < 2048);
        assert.ok(Array.isArray(note.evidence) && note.evidence.length > 0);
        for (const url of note.evidence) assert.match(url, /^https:\/\/github\.com\/RichLogic\/(Gian|Gian-Proxies)\//);
      }
      versions++;
    }
    tutorialChapters(containedFile(join(root, id, 'tutorial.md')));
    tutorialChapters(containedFile(join(root, id, 'tutorial.en.md')), 'en');
    renderEnglishHistory(history, active);
    containedFile(join(root, id, 'basic.md'));
    const projection = renderHistory(history, active);
    const mdPath = join(root, id, 'changelog.md');
    if (render) writeFileSync(mdPath, projection);
    else assert.equal(containedFile(mdPath), projection, 'Edit changelog.json then regenerate its Markdown projection');
  }
  assert.equal(observed.size, releases.length, 'A retained public distribution was omitted');
  return { proxies: Object.keys(folders).length, versions, distributions: observed.size, metadataOnly };
}

export function renderEnglishHistory(history, current) {
  const copy = json(join(root, 'history-copy.en.json'));
  const translate = source => {
    assert.ok(typeof copy[source] === 'string' && copy[source].trim(), `Missing English history translation: ${source}`);
    return copy[source];
  };
  const headings = { added: 'Added', changed: 'Changed', fixed: 'Fixed', attention: 'Notes' };
  let md = `# ${current.displayName}: Version history\n\nGenerated from the structured changelog, newest Proxy version first. Original publication and later repository distributions are recorded separately; missing historical details are not invented.\n\nRelease combination snapshot: Proxy **${current.version}**, Runtime **${current.combination.runtime.version}**. These are distribution targets, not this machine's installed state.\n\n`;
  for (const entry of history.entries) {
    md += `## ${entry.version}\n\nFirst published: ${entry.firstPublishedAt} (UTC).\n\n`;
    for (const d of entry.distributions) {
      const basis = d.runtimeDeclaration.basis === 'verified-declaration' ? 'Manifest compatibility declaration'
        : d.runtimeDeclaration.basis === 'recommended-declaration' ? 'historical recommendation' : 'CLI version not recorded';
      md += `- [${d.repository} distribution](${d.releaseUrl}): ${d.publishedAt}.\n`;
      md += `- CLI: ${d.runtimeDeclaration.versions.join(', ') || 'not recorded'} (${basis}, not local installation state).`;
      for (const bridge of d.companionDeclarations) md += ` Bridge: ${bridge.version} (${bridge.basis === 'bundled-package-source'
        ? 'source package corresponding to this archive' : 'source package at this public tag'}).`;
      md += '\n';
    }
    md += '\n';
    for (const category of categories) {
      const notes = entry.changes.filter(n => n.category === category);
      if (!notes.length) continue;
      md += `### ${headings[category]}\n\n`;
      for (const note of notes) md += `- ${translate(note.text)} ${note.evidence.map((url, i) => `[Source ${i + 1}](${url})`).join(' ')}\n`;
      md += '\n';
    }
    if (entry.unknowns.length) {
      md += '### Historical evidence limits\n\n';
      for (const note of entry.unknowns) md += `- ${translate(note)}\n`;
      md += '\n';
    }
  }
  md += '## Withdrawn versions\n\n';
  if (!history.withdrawnVersions.length) md += 'None.\n';
  for (const item of history.withdrawnVersions) {
    md += `- ${item.version}: withdrawn on ${item.withdrawnOn}; not installable. [Source](${item.evidence})\n`;
  }
  return md;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.slice(2).every(arg => arg === '--render'), 'Only --render is supported');
  console.log(JSON.stringify(validateReview({ render: process.argv.includes('--render') })));
}
