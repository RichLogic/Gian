import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { projectInformation, projectTutorial } from './project.mjs';
import { validateReview } from './validate.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const current = JSON.parse(readFileSync(join(root, 'evidence/current-combinations.json'), 'utf8'));
const certified = current.plugins.map(p => ({ pluginId: p.id, version: p.version, runtime: p.combination.runtime }));

test('authored histories remain complete and their Markdown projection matches', () => {
  assert.deepEqual(validateReview(), { proxies: 6, versions: 79, distributions: 82, metadataOnly: 28 });
});

test('v1 tutorial concatenation preserves all nine chapters byte for byte', () => {
  for (const plugin of current.plugins) {
    const tutorial = readFileSync(join(root, plugin.id, 'tutorial.md'), 'utf8');
    const history = readFileSync(join(root, plugin.id, 'changelog.md'), 'utf8');
    const docs = projectTutorial(tutorial, history);
    assert.deepEqual(Object.keys(docs), ['overview', 'setup', 'usage', 'troubleshooting']);
    assert.equal(docs.setup + docs.usage + docs.troubleshooting, tutorial);
    assert.equal(docs.overview, history);
    assert.throws(() => projectTutorial(tutorial.replace('## 9.', '## 10.'), history), /chapter contract/);
    assert.throws(() => projectTutorial(tutorial + '\n<script>alert(1)</script>\n', history), /HTML/);
  }
});

test('publication replaces only v1 documents and rejects mismatched certified versions', () => {
  const target = mkdtempSync(join(tmpdir(), 'gian-information-'));
  try {
    cpSync(join(root, '../official-source'), target, { recursive: true });
    const before = new Map(current.plugins.map(p => [p.id, readFileSync(join(target, 'plugins', p.id, 'entry.json'), 'utf8')]));
    const { localizations } = projectInformation(target, certified);
    for (const p of current.plugins) {
      const en = localizations[p.id].en;
      const zh = localizations[p.id]['zh-CN'];
      assert.match(zh.tagline, /在 Gian 中/);
      assert.doesNotMatch(en.tagline + Object.values(en.documents).join(''), /\p{Script=Han}/u);
      assert.equal(en.documents.setup + en.documents.usage + en.documents.troubleshooting,
        readFileSync(join(root, p.id, 'tutorial.en.md'), 'utf8'));
      const history = JSON.parse(readFileSync(join(root, p.id, 'changelog.json'), 'utf8'));
      for (const entry of history.entries) assert.ok(en.documents.overview.includes(`## ${entry.version}\n`));
      assert.equal(readFileSync(join(target, 'plugins', p.id, 'entry.json'), 'utf8'), before.get(p.id));
      assert.equal(readFileSync(join(target, 'plugins', p.id, 'overview.md'), 'utf8'),
        readFileSync(join(root, p.id, 'changelog.md'), 'utf8'));
    }
    const mismatched = structuredClone(certified);
    mismatched[0].version = '99.0.0';
    assert.throws(() => projectInformation(target, mismatched), /Proxy snapshot differs/);
    const runtimeMismatch = structuredClone(certified);
    runtimeMismatch[0].runtime.version = '99.0.0';
    assert.throws(() => projectInformation(target, runtimeMismatch), /Runtime snapshot differs/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('new selected qualified metadata leaves excluded signed content and localizations untouched', () => {
  const target = mkdtempSync(join(tmpdir(), 'gian-information-addition-'));
  try {
    cpSync(join(root, '../official-source'), target, { recursive: true });
    const pluginId = 'io.gian.antigravity';
    const directory = join(target, 'plugins', pluginId);
    const manifest = JSON.parse(readFileSync(join(directory, 'sidecar.json'), 'utf8'));
    const addition = { pluginId, version: '0.0.1', manifest, runtime: { runtimeId: 'antigravity-acp', version: '1.3.0' } };
    const oldPath = join(target, 'plugins', current.plugins[0].id, 'overview.md');
    writeFileSync(oldPath, '# Exact signed base28 content\n');
    const inheritedLocalizations = { [current.plugins[0].id]: {
      en: { displayName: 'Signed name', tagline: 'Signed tagline', documents: { overview: Buffer.from('signed localized bytes') } },
    } };
    const before = readFileSync(join(directory, 'overview.md'));
    const options = { selectedIds: [pluginId], inheritedLocalizations };
    const result = projectInformation(target, [...certified, addition], options);
    assert.equal(readFileSync(oldPath, 'utf8'), '# Exact signed base28 content\n');
    assert.deepEqual(Buffer.from(result.localizations[current.plugins[0].id].en.documents.overview),
      inheritedLocalizations[current.plugins[0].id].en.documents.overview);
    assert.deepEqual(readFileSync(join(directory, 'overview.md')), before);
    assert.throws(() => projectInformation(target, [...certified, { ...addition, version: '0.0.2' }], options), /version differs/);
    assert.throws(() => projectInformation(target, [...certified, { ...addition, manifest: { ...manifest, id: 'other' } }], options), /Manifest differs/);
    assert.throws(() => projectInformation(target, [...certified, { ...addition, runtime: { runtimeId: 'antigravity-acp', version: '0.0.1' } }], options), /Runtime version differs/);
    writeFileSync(join(directory, 'usage.md'), '');
    assert.throws(() => projectInformation(target, [...certified, addition], options), /documentation is incomplete/);
  } finally { rmSync(target, { recursive: true, force: true }); }
});
