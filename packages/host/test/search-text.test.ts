// Pure search projection. Loading this file needs the shared remark deps.
// NOT_RUN until the owner allows install and module-scoped checks.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { GIAN_ACTION_CLOSE, GIAN_ACTION_OPEN, GIAN_ROLE_CLOSE, GIAN_ROLE_OPEN } from '../../shared/src/action.js';
import { MANAGER_SYS_CLOSE, MANAGER_SYS_OPEN } from '../../shared/src/manager.js';
import type { ComposerDocument } from '../../shared/src/context.js';
import { findLiteralRanges, projectComposerSearchText, projectSearchText, scanLiteralRanges, snippetAround } from '../../shared/src/search-text.js';

test('projection keeps visible text and drops html plus link destinations', () => {
  const text = projectSearchText([
    'See [label](https://secret.example/a) and `pnpm test`.',
    '',
    '<script>hidden-html()</script>',
    '',
    'after $E=mc^2$',
  ].join('\n'));
  assert.equal(text.includes('secret.example'), false);
  assert.equal(text.includes('hidden-html'), false);
  assert.equal(text.includes('label'), true);
  assert.equal(text.includes('pnpm test'), true);
  assert.equal(text.includes('E=mc^2'), true);
  assert.equal(text.includes('after'), true);
});

test('projection strips role headers and settled action blocks only', () => {
  const role = projectSearchText(`${GIAN_ROLE_OPEN}\nengineer\n${GIAN_ROLE_CLOSE}\nhello`);
  assert.equal(role.includes('engineer'), false);
  assert.equal(role.includes('hello'), true);

  const manager = projectSearchText(`${MANAGER_SYS_OPEN}\nsecret-system\n${MANAGER_SYS_CLOSE}\nhello`);
  assert.equal(manager.includes('secret-system'), true);

  const closed = projectSearchText(
    `before\n${GIAN_ACTION_OPEN}\n{"method":"create_subtask"}\n${GIAN_ACTION_CLOSE}\nafter-token`,
  );
  assert.equal(closed.includes('create_subtask'), false);
  assert.equal(closed.includes('after-token'), true);

  const open = projectSearchText(`before ${GIAN_ACTION_OPEN} still-visible`);
  assert.equal(open.includes('still-visible'), true);
});

test('literal ranges use original UTF-16 spans for normalized graphemes', () => {
  const text = 'xe\u0301y';
  const ranges = findLiteralRanges(text, '\u00e9');
  assert.equal(ranges.length, 1);
  assert.equal(text.slice(ranges[0]!.start, ranges[0]!.end), 'e\u0301');

  const long = `${'a'.repeat(80)}中文${'b'.repeat(80)}`;
  const window = snippetAround(long, findLiteralRanges(long, '中文'));
  assert.equal(window.snippet.slice(window.ranges[0]!.start, window.ranges[0]!.end), '中文');
  assert.ok(window.snippet.length < long.length);
  const bounded = scanLiteralRanges(text, '\u00e9', { limit: 4 });
  assert.deepEqual(bounded.ranges, ranges);
  assert.equal(bounded.resume, null);
});

test('a repeated document scans a bounded number of occurrences', () => {
  const text = 'xy'.repeat(5000);
  const first = scanLiteralRanges(text, 'xy', { limit: 2 });
  assert.equal(first.ranges.length, 2);
  assert.equal(first.resume, first.ranges[1]!.end);
  const second = scanLiteralRanges(text, 'xy', { from: first.resume ?? 0, limit: 2 });
  assert.equal(second.ranges.length, 2);
  assert.ok((second.ranges[0]?.start ?? 0) >= (first.resume ?? 0));
  assert.notEqual(second.ranges[0]?.start, first.ranges[0]?.start);
  assert.deepEqual(scanLiteralRanges(text, '', { limit: 2 }), { ranges: [], resume: null });
  assert.deepEqual(scanLiteralRanges('abc', 'zzz', { limit: 2 }), { ranges: [], resume: null });
});

test('nfkc expansions keep one physical range and every page limit concatenates', () => {
  const ligatures: Array<[string, string]> = [
    ['\uFB03', 'f'],
    ['\uFB00', 'f'],
    ['\uFB04', 'fl'],
  ];
  for (const [text, query] of ligatures) {
    const full = findLiteralRanges(text, query);
    assert.deepEqual(full, [{ start: 0, end: text.length }]);
    assert.deepEqual(scanLiteralRanges(text, query, { limit: 50 }).ranges, full);
    assert.deepEqual(pageRanges(text, query, 1), full);
    assert.deepEqual(pageRanges(text, query, 2), full);
  }
  const crossed = '\uFB01f';
  const crossedFull = findLiteralRanges(crossed, 'f');
  assert.deepEqual(crossedFull, [{ start: 0, end: 1 }, { start: 1, end: 2 }]);
  assert.deepEqual(scanLiteralRanges(crossed, 'f', { limit: 50 }).ranges, crossedFull);
  assert.deepEqual(pageRanges(crossed, 'f', 1), crossedFull);
  const spanned = findLiteralRanges('\uFB01x', 'ix');
  assert.deepEqual(spanned, [{ start: 0, end: 2 }]);
  assert.deepEqual(pageRanges('\uFB01x', 'ix', 1), spanned);
  const repeated = '\uFB03\uFB03\uFB03';
  const overlapping = findLiteralRanges(repeated, 'iff');
  assert.deepEqual(overlapping, [{ start: 0, end: 2 }]);
  assert.deepEqual(scanLiteralRanges(repeated, 'iff', { limit: 1 }).ranges, overlapping);
  assert.deepEqual(pageRanges(repeated, 'iff', 1), overlapping);
});

test('composer projection counts chip labels and visible markdown only', () => {
  const around = document([
    { type: 'text', text: 'before ' },
    { type: 'reference', id: 'note', referenceType: 'context', label: 'Notes' },
    { type: 'text', text: ' after' },
  ]);
  assert.equal(projectComposerSearchText(around), 'before Notes after');

  const markdown = document([
    { type: 'text', text: 'See **' },
    { type: 'reference', id: 'note', referenceType: 'context', label: 'Notes' },
    { type: 'text', text: '** later' },
  ]);
  const across = projectComposerSearchText(markdown);
  assert.equal(across.includes('See'), true);
  assert.equal(across.includes('Notes'), true);
  assert.equal(across.includes('later'), true);
  assert.equal(across.includes('"Notes"'), false);

  const literal = document([
    { type: 'reference', id: 'star', referenceType: 'context', label: '*star*' },
  ]);
  assert.equal(projectComposerSearchText(literal), '*star*');

  const attachment = document([
    { type: 'reference', id: 'file', referenceType: 'attachment', label: 'diagram.png' },
  ]);
  assert.equal(projectComposerSearchText(attachment), 'diagram.png');
  assert.equal(projectComposerSearchText(attachment).includes('attachment-body'), false);

  const reference = document([
    { type: 'reference', id: 'plan', referenceType: 'context', label: 'Plan' },
  ]);
  assert.equal(projectComposerSearchText(reference), 'Plan');

  const spaced = document([
    { type: 'reference', id: 'a', referenceType: 'context', label: 'Alpha' },
    { type: 'text', text: '  ' },
    { type: 'reference', id: 'b', referenceType: 'context', label: 'Beta' },
  ]);
  assert.equal(projectComposerSearchText(spaced), 'Alpha  Beta');
  assert.equal(projectSearchText('plain-legacy-token'), 'plain-legacy-token');
});

function document(segments: ComposerDocument['segments']): ComposerDocument {
  return { version: 1, segments };
}

function pageRanges(text: string, query: string, limit: number) {
  const ranges = [];
  let from = 0;
  for (let guard = 0; guard < 12; guard += 1) {
    const page = scanLiteralRanges(text, query, { from, limit });
    ranges.push(...page.ranges);
    if (page.resume === null) return ranges;
    assert.ok(page.resume > from);
    from = page.resume;
  }
  throw new Error('literal scan did not finish');
}
