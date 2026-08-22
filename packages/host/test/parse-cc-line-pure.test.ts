import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseCcLine } from '../src/native/replay.js';

test('parseCcLine ignores empty, junk, and malformed lines', () => {
  assert.equal(parseCcLine(''), null);
  assert.equal(parseCcLine('{'), null);
  assert.equal(parseCcLine('{"type":"system"}'), null);
});

test('parseCcLine drops system-noise user lines', () => {
  assert.equal(parseCcLine(JSON.stringify({
    type: 'user',
    message: { content: '<system-reminder>do not show</system-reminder>' },
  })), null);
  assert.equal(parseCcLine(JSON.stringify({
    type: 'user',
    message: { content: 'Caveat: The messages below are hidden' },
  })), null);
});

test('parseCcLine turns a user string into a turn-start user_message', () => {
  const parsed = parseCcLine(JSON.stringify({
    type: 'user',
    message: { content: 'hello from the user' },
  }));
  assert.ok(parsed);
  assert.equal(parsed!.boundary, 'turn-start');
  assert.equal(parsed!.events.length, 1);
  assert.equal(parsed!.events[0]!.type, 'user_message');
  assert.equal((parsed!.events[0]!.data as { text: string }).text, 'hello from the user');
});

test('parseCcLine extracts assistant text blocks', () => {
  const parsed = parseCcLine(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'answer', id: 'blk-1' }] },
  }));
  assert.ok(parsed);
  assert.equal(parsed!.boundary, 'continue');
  assert.equal(parsed!.events.length > 0, true);
  assert.equal(parsed!.events[0]!.type, 'output.text');
  assert.equal(typeof parsed!.events[0]!.data, 'object');
});
