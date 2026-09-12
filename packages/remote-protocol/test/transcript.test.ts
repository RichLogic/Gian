import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  REMOTE_METHOD_RESULTS,
  generateCanonicalId,
  transcriptItemSchema,
} from '../src/index.js';

function base() {
  return {
    id: generateCanonicalId(),
    turn_id: generateCanonicalId(),
    turn: 7,
    ts: Date.now(),
  };
}

test('Remote transcript items preserve real turn identity and streaming semantics', () => {
  const item = transcriptItemSchema.parse({
    ...base(),
    kind: 'assistant',
    text: 'hello',
    delta: true,
  });
  assert.equal(item.kind, 'assistant');
  assert.equal(item.turn, 7);
  assert.equal(item.delta, true);
});

test('Remote user messages carry only opaque attachment handles and safe metadata', () => {
  const attachmentId = generateCanonicalId();
  const item = transcriptItemSchema.parse({
    ...base(),
    kind: 'user',
    text: 'see attachment',
    attachments: [{
      id: attachmentId,
      session_id: generateCanonicalId(),
      name: 'screen.png',
      mime: 'image/png',
      size: 128,
      revision: 'event:0',
      previewable: true,
      downloadable: true,
      expires_at: new Date().toISOString(),
    }],
  });
  assert.equal(item.kind, 'user');
  assert.equal(item.attachments?.[0]?.id, attachmentId);
  assert.equal(JSON.stringify(item).includes('/Users/'), false);
});

test('Remote transcript contract rejects legacy category rows and sensitive activity payloads', () => {
  assert.throws(() => transcriptItemSchema.parse({
    ...base(),
    category: 'notice',
    text: 'notice',
  }));
  assert.throws(() => transcriptItemSchema.parse({
    ...base(),
    kind: 'command',
    status: 'success',
    command: 'curl --token secret',
    stdout: '/Users/example/private.txt',
  }));
});

test('session.page requires explicit pagination state', () => {
  const sessionId = generateCanonicalId();
  const page = {
    session_id: sessionId,
    has_more: false,
    items: [{ ...base(), kind: 'file-read' }],
  };
  assert.doesNotThrow(() => REMOTE_METHOD_RESULTS['session.page'].parse(page));
  assert.throws(() => REMOTE_METHOD_RESULTS['session.page'].parse({
    session_id: sessionId,
    items: page.items,
  }));
});

test('catalog model choices stay closed and presentation-only', () => {
  const model = {
    catalog_revision: 'revision',
    workspaces: [],
    agents: [{
      id: generateCanonicalId(),
      name: 'Codex',
      proxy: 'codex',
      readiness: 'ready',
      models: [{
        id: 'gpt-5.3-codex',
        label: 'GPT-5.3 Codex',
        is_default: true,
        supported_thinking: ['medium', 'high'],
      }],
    }],
    tasks: [],
  };
  assert.doesNotThrow(() => REMOTE_METHOD_RESULTS['catalog.read'].parse(model));
  assert.throws(() => REMOTE_METHOD_RESULTS['catalog.read'].parse({
    ...model,
    agents: [{ ...model.agents[0], models: [{ ...model.agents[0]!.models[0], cli_path: '/private/bin' }] }],
  }));
});
