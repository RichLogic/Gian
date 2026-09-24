import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  assert.deepEqual(validateReview(), { proxies: 5, versions: 50, distributions: 53, metadataOnly: 28 });
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
