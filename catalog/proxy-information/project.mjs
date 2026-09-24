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

export function projectInformation(target, certifiedProxies) {
  const summary = validateReview();
  const current = json(join(root, 'evidence/current-combinations.json'));
  const metadata = json(join(root, 'localizations.json'));
  const localizations = {};
  assert.equal(certifiedProxies.length, current.plugins.length, 'Certified shipping set differs');
  assert.equal(new Set(certifiedProxies.map(p => p.pluginId)).size, current.plugins.length);
  for (const active of current.plugins) {
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
  return { summary, localizations };
}
