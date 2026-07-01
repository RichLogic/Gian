// Coverage for traceability rows:
//   ACTION-PARSE-001 — tail rule accepts a trailing action block.
//   ACTION-PARSE-002 — a block followed by prose is treated as an example (not-trailing).
//   ACTION-PARSE-003 — a fenced block is treated as an example.
//   ACTION-PARSE-004 — with multiple blocks, the trailing one wins.
//   ACTION-PARSE-005 — malformed JSON / unknown method / missing params are rejected.
//   ACTION-PARSE-006 — per-method params validation (create_subtask/message_subtask/submit_step).
//   ACTION-ID-001    — computeActionId / computePayloadHash are stable and input-sensitive.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  parseGianAction,
  computeActionId,
  computePayloadHash,
} from '../src/task/action-parser.js';

const CREATE = JSON.stringify({
  method: 'create_subtask',
  params: { workspace: 'repoA', executor: 'claude', brief: 'Add the X feature', name: 'X' },
});

function block(json: string): string {
  return `<<gian:action>>\n${json}\n<</gian:action>>`;
}

test('ACTION-PARSE-001: accepts a trailing create_subtask block', () => {
  const text = `Sure, I'll spin that up.\n\n${block(CREATE)}`;
  const res = parseGianAction(text);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.action.method, 'create_subtask');
  assert.deepEqual(res.action.params, {
    workspace: 'repoA',
    executor: 'claude',
    brief: 'Add the X feature',
    name: 'X',
  });
  // blockText is the verbatim OPEN..CLOSE slice.
  assert.ok(res.blockText.startsWith('<<gian:action>>'));
  assert.ok(res.blockText.endsWith('<</gian:action>>'));
});

test('ACTION-PARSE-001: trailing whitespace after the block is tolerated', () => {
  const res = parseGianAction(`${block(CREATE)}\n\n   \n`);
  assert.equal(res.ok, true);
});

test('ACTION-PARSE-002: a block followed by prose is not executed (not-trailing)', () => {
  const text = `${block(CREATE)}\n\nLet me know if that looks right!`;
  const res = parseGianAction(text);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'not-trailing');
});

test('ACTION-PARSE-003: a fenced block is treated as an example (closed fence → not-trailing)', () => {
  const text = 'For example you could send:\n```\n' + block(CREATE) + '\n```';
  const res = parseGianAction(text);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'not-trailing');
});

test('ACTION-PARSE-003: an open fence right before the block is treated as an example', () => {
  // No closing fence, so the tail rule alone would accept it — the fence count
  // guard must reject it.
  const text = 'Here is the shape:\n```\n' + block(CREATE);
  const res = parseGianAction(text);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'not-trailing');
});

test('ACTION-PARSE-004: with an example block then a real trailing block, the trailing one wins', () => {
  const example = block(JSON.stringify({
    method: 'create_subtask',
    params: { workspace: 'demo', executor: 'codex', brief: 'ignore me' },
  }));
  const real = block(CREATE);
  // The example is inline prose (not fenced), then the real block closes the msg.
  const text = `You might write ${example.replace(/\n/g, ' ')} — but here is the real one:\n\n${real}`;
  const res = parseGianAction(text);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.action.params.workspace, 'repoA'); // the trailing (CREATE) block
});

test('ACTION-PARSE-005: no block at all → no-block', () => {
  const res = parseGianAction('Just some ordinary text with no action.');
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'no-block');
});

test('ACTION-PARSE-005: malformed JSON → bad-json', () => {
  const res = parseGianAction(block('{not valid json'));
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'bad-json');
});

test('ACTION-PARSE-005: unknown method → unknown-method', () => {
  const res = parseGianAction(block(JSON.stringify({ method: 'delete_everything', params: {} })));
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'unknown-method');
});

test('ACTION-PARSE-006: create_subtask missing brief → invalid-params', () => {
  const res = parseGianAction(block(JSON.stringify({
    method: 'create_subtask',
    params: { workspace: 'repoA', executor: 'claude' },
  })));
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'invalid-params');
});

test('ACTION-PARSE-006: create_subtask bad executor → invalid-params', () => {
  const res = parseGianAction(block(JSON.stringify({
    method: 'create_subtask',
    params: { workspace: 'repoA', executor: 'gpt', brief: 'x' },
  })));
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'invalid-params');
});

test('ACTION-PARSE-006: message_subtask requires subtask_id and text', () => {
  const ok = parseGianAction(block(JSON.stringify({
    method: 'message_subtask',
    params: { subtask_id: 's1', text: 'please rebase' },
  })));
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.action.method, 'message_subtask');
    assert.deepEqual(ok.action.params, { subtask_id: 's1', text: 'please rebase' });
  }
  const bad = parseGianAction(block(JSON.stringify({
    method: 'message_subtask',
    params: { subtask_id: 's1' },
  })));
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.reason, 'invalid-params');
});

test('ACTION-PARSE-006: submit_step done/pass with points', () => {
  const res = parseGianAction(block(JSON.stringify({
    method: 'submit_step',
    params: { status: 'done', verdict: 'pass', headline: 'tests green', points: ['a', ' ', 'b'] },
  })));
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.action.method, 'submit_step');
  assert.deepEqual(res.action.params, {
    status: 'done',
    headline: 'tests green',
    verdict: 'pass',
    points: ['a', 'b'], // blank point dropped
  });
});

test('ACTION-PARSE-006: submit_step blocked with null verdict', () => {
  const res = parseGianAction(block(JSON.stringify({
    method: 'submit_step',
    params: { status: 'blocked', verdict: null, headline: 'need creds' },
  })));
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.action.method, 'submit_step');
  assert.deepEqual(res.action.params, { status: 'blocked', headline: 'need creds', verdict: null });
});

test('ACTION-PARSE-006: submit_step bad status → invalid-params', () => {
  const res = parseGianAction(block(JSON.stringify({
    method: 'submit_step',
    params: { status: 'maybe', headline: 'x' },
  })));
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'invalid-params');
});

test('ACTION-ID-001: computePayloadHash is stable and input-sensitive', () => {
  const a = 'block-text-A';
  assert.equal(computePayloadHash(a), computePayloadHash(a));
  assert.notEqual(computePayloadHash(a), computePayloadHash('block-text-B'));
  // sha256 hex is 64 chars.
  assert.equal(computePayloadHash(a).length, 64);
});

test('ACTION-ID-001: computeActionId is deterministic and each part matters', () => {
  const id = computeActionId('sess1', 'turn1', 'ph1');
  assert.equal(id, computeActionId('sess1', 'turn1', 'ph1'));
  assert.notEqual(id, computeActionId('sess2', 'turn1', 'ph1'));
  assert.notEqual(id, computeActionId('sess1', 'turn2', 'ph1'));
  assert.notEqual(id, computeActionId('sess1', 'turn1', 'ph2'));
});

test('ACTION-ID-001: re-parsing identical final text yields an identical action id', () => {
  const text = `done!\n\n${block(CREATE)}`;
  const r1 = parseGianAction(text);
  const r2 = parseGianAction(text);
  assert.equal(r1.ok && r2.ok, true);
  if (!r1.ok || !r2.ok) return;
  const id1 = computeActionId('s', 'tk', computePayloadHash(r1.blockText));
  const id2 = computeActionId('s', 'tk', computePayloadHash(r2.blockText));
  assert.equal(id1, id2);
});
