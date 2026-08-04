import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendCcCustomTitle } from '../src/native/locate-jsonl.js';
import { parseCcLine } from '../src/native/replay.js';

// SESSION-NAME-001 — appending a Claude `custom-title` line to set the native
// session display name.

test('appendCcCustomTitle writes a well-formed custom-title line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-name-'));
  try {
    const fp = join(dir, 'sess.jsonl');
    writeFileSync(fp, '{"type":"user","message":{"content":"hi"}}\n', 'utf8');

    const wrote = appendCcCustomTitle(fp, 'abc-123', '  My Session  ');
    assert.equal(wrote, true);

    const lines = readFileSync(fp, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const parsed = JSON.parse(lines[1]!);
    assert.deepEqual(parsed, {
      type: 'custom-title',
      customTitle: 'My Session',
      sessionId: 'abc-123',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendCcCustomTitle strips control chars and is a no-op for empty names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-name-'));
  try {
    const fp = join(dir, 'sess.jsonl');
    writeFileSync(fp, '', 'utf8');

    assert.equal(appendCcCustomTitle(fp, 'id', '   '), false);
    assert.equal(readFileSync(fp, 'utf8'), '');

    assert.equal(appendCcCustomTitle(fp, 'id', 'a\nb\tc'), true);
    assert.equal(JSON.parse(readFileSync(fp, 'utf8').trim()).customTitle, 'a b c');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseCcLine ignores custom-title / ai-title meta lines (zero ripple)', () => {
  // The whole "append a line" design relies on the watcher/replay ignoring
  // non-message lines — otherwise a rename would surface a junk transcript row.
  assert.equal(
    parseCcLine(JSON.stringify({ type: 'custom-title', customTitle: 'x', sessionId: 's' })),
    null,
  );
  assert.equal(
    parseCcLine(JSON.stringify({ type: 'ai-title', aiTitle: 'x', sessionId: 's' })),
    null,
  );
  // sanity: a real user message is NOT ignored.
  const userLine = parseCcLine(JSON.stringify({ type: 'user', message: { content: 'hello' } }));
  assert.equal(userLine?.boundary, 'turn-start');
});
