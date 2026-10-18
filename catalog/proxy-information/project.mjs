import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderEnglishHistory, tutorialChapters, validateReview } from './validate.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const json = path => JSON.parse(readFileSync(path, 'utf8'));

export function projectTutorial(tutorial, history, locale = 'zh-CN') {
  const chapters = tutorialChapters(tutorial, locale);
  const heading = tutorial.slice(0, tutorial.indexOf(chapters[0]));
  return {
    overview: history,
    setup: heading + chapters.slice(0, 4).join(''),
    usage: chapters.slice(4, 8).join(''),
    troubleshooting: chapters[8],
  };
}

export function projectInformation(target, certifiedProxies, { selectedIds, inheritedLocalizations = {} } = {}) {
  const summary = validateReview();
  const current = json(join(root, 'evidence/current-combinations.json'));
  const metadata = json(join(root, 'localizations.json'));
  const localizations = structuredClone(inheritedLocalizations);
  const selected = selectedIds ?? current.plugins.map(plugin => plugin.id);
  if (selectedIds === undefined) assert.equal(certifiedProxies.length, current.plugins.length, 'Certified shipping set differs');
  assert.equal(new Set(certifiedProxies.map(p => p.pluginId)).size, certifiedProxies.length);
  assert.equal(new Set(selected).size, selected.length, 'Duplicate selected documentation');
  assert.ok(selected.every(id => certifiedProxies.some(record => record.pluginId === id)), 'Selected documentation lacks qualification');
  for (const active of current.plugins) {
    if (!selected.includes(active.id)) continue;
    const certified = certifiedProxies.find(p => p.pluginId === active.id);
    assert.equal(certified?.version, active.version, 'Documentation Proxy snapshot differs');
    assert.deepEqual(certified.runtime, active.combination.runtime, 'Documentation Runtime snapshot differs');
    const tutorial = readFileSync(join(root, active.id, 'tutorial.md'), 'utf8');
    const history = readFileSync(join(root, active.id, 'changelog.md'), 'utf8');
    const englishTutorial = readFileSync(join(root, active.id, 'tutorial.en.md'), 'utf8');
    const englishHistory = renderEnglishHistory(json(join(root, active.id, 'changelog.json')), active);
    localizations[active.id] = {
      en: { ...metadata[active.id].en, documents: projectTutorial(englishTutorial, englishHistory, 'en') },
      'zh-CN': { ...metadata[active.id]['zh-CN'], documents: projectTutorial(tutorial, history) },
    };
    const directory = join(target, 'plugins', active.id);
    const entry = json(join(directory, 'entry.json'));
    // Retain the exact v1 wire shape so existing strict-schema clients can refresh.
    for (const [key, markdown] of Object.entries(projectTutorial(tutorial, history))) {
      assert.equal(entry.documentation[key], `${key}.md`, 'Unexpected documentation target');
      writeFileSync(join(directory, `${key}.md`), markdown);
    }
  }
  for (const id of selected.filter(id => !current.plugins.some(plugin => plugin.id === id))) {
    const certified = certifiedProxies.find(record => record.pluginId === id);
    const directory = join(target, 'plugins', id);
    const entry = json(join(directory, 'entry.json'));
    const manifest = json(join(directory, 'sidecar.json'));
    assert.equal(entry.pluginId, id);
    assert.equal(entry.channels.stable.pluginVersion, certified.version, 'New documentation Proxy version differs');
    assert.deepEqual(manifest, certified.manifest, 'New documentation Manifest differs');
    assert.equal(manifest.pluginVersion, certified.version);
    assert.equal(certified.runtime.runtimeId, manifest.runtime.id, 'New documentation Runtime identity differs');
    assert.ok(manifest.runtime.verifiedVersions.includes(certified.runtime.version), 'New documentation Runtime version differs');
    for (const key of ['overview', 'setup', 'usage', 'troubleshooting']) {
      assert.equal(entry.documentation[key], `${key}.md`);
      assert.ok(readFileSync(join(directory, `${key}.md`), 'utf8').trim(), 'New Proxy documentation is incomplete');
    }
    // No publication history exists yet. The source's reviewed default docs
    // are compiled as-is; never mint history dates or hashes to pass this gate.
  }
  return { summary, localizations };
}
