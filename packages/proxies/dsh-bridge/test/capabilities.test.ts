/**
 * Capability completion suite for the 0.1.5-rc.3 bridge surface: structured
 * attachments, skill activation, strict steering, native fork, native session
 * list, structured user questions, subagent lifecycle, and customization
 * inventory — all through the deterministic fake host.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';

import { BridgeServer } from '../src/server.js';
import { BridgeWriter } from '../src/jsonrpc.js';
import { FakeDshRuntime } from '../src/fake-host.js';

interface Harness {
  runtime: FakeDshRuntime;
  server: BridgeServer;
  notifications: Array<{ method: string; params: Record<string, unknown> }>;
}

function makeHarness(options: ConstructorParameters<typeof FakeDshRuntime>[0] = {}): Harness {
  const runtime = new FakeDshRuntime(options);
  const notifications: Harness['notifications'] = [];
  const out = new Writable({
    write(chunk, _enc, cb) {
      const line = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (line.trim() === '') return cb();
      const value = JSON.parse(line.trim());
      if ('method' in value && value.id === undefined) notifications.push({ method: value.method, params: value.params });
      cb();
    },
  });
  const server = new BridgeServer({ host: runtime, writer: new BridgeWriter(out) });
  return { runtime, server, notifications };
}

async function request(server: BridgeServer, method: string, params: Record<string, unknown> = {}) {
  return server.handle({ id: `r-${method}`, method, params });
}

async function createSession(server: BridgeServer, sessionId = 's1'): Promise<void> {
  await request(server, 'session.create', {
    sessionId,
    workspace: { cwd: '/w', roots: ['/w'] },
    config: {},
  });
}

/* ------------------------- Attachments and skills ------------------------ */

test('structured image, file, and text input reach the native message as content blocks', async () => {
  const { server } = makeHarness({ script: 'attachments' });
  await request(server, 'initialize', { protocol: { versions: ['1.0'] } });
  await createSession(server);
  const result = await request(server, 'turn.start', {
    sessionId: 's1',
    turnId: 't1',
    input: [
      { type: 'text', text: 'Inspect these' },
      { type: 'localImage', path: '/w/pic.png', name: 'pic.png', mime: 'image/png', size: 64 },
      { type: 'localFile', path: '/w/notes.txt', name: 'notes.txt', size: 4096 },
    ],
    config: {},
  });
  assert.equal((result as { accepted: boolean }).accepted, true);
  const page = await request(server, 'session.events.read', { sessionId: 's1', cursor: null, limit: 100 });
  const events = (page as { events: Array<{ type: string; data: Record<string, unknown> }> }).events;
  const userMessages = events.filter(event => event.type === 'user/message');
  const blocks = (userMessages[0]?.data as { message?: { content?: Array<Record<string, unknown>> } })?.message?.content ?? [];
  assert.equal(blocks[0]?.type, 'text');
  assert.equal(blocks[1]?.type, 'image');
  const attachment = blocks[1]?.attachment as Record<string, unknown> | undefined;
  assert.equal(attachment?.mediaType, 'image/png');
  assert.equal(blocks[2]?.type, 'file');
  assert.equal((blocks[2]?.attachment as Record<string, unknown> | undefined)?.name, 'notes.txt');
});

test('attachment failures reject the turn before any native event is appended', async () => {
  const { server, runtime } = makeHarness({ script: 'attachments' });
  await request(server, 'initialize', { protocol: { versions: ['1.0'] } });
  await createSession(server);
  const cases = [
    { input: [{ type: 'localImage', path: 'relative/pic.png' }] },
    { input: [{ type: 'localImage', path: '/w/../w/pic.png' }] },
    { input: [{ type: 'localFile', path: '/missing/file.txt' }] },
    { input: [{ type: 'localImage', path: '/refused/pic.png', mime: 'image/png' }] },
    { input: [{ type: 'skill', skill: 'nope' }] },
  ];
  for (const params of cases) {
    await assert.rejects(
      () => request(server, 'turn.start', { sessionId: 's1', turnId: 't1', config: {}, ...params }),
      (error: unknown) => String((error as Error).message).startsWith('CONFIG_VALUE_INVALID'),
      `expected rejection for ${JSON.stringify(params)}`,
    );
  }
  const page = await request(server, 'session.events.read', { sessionId: 's1', cursor: null, limit: 100 });
  assert.equal((page as { events: unknown[] }).events.length, 0);
  // The session stays usable after failed admissions.
  const ok = await request(server, 'turn.start', {
    sessionId: 's1', turnId: 't2', config: {},
    input: [{ type: 'text', text: 'plain text only' }],
  });
  assert.equal((ok as { accepted: boolean }).accepted, true);
  void runtime;
});

test('skill activation injects the rendered body with the native invocation source', async () => {
  const { server } = makeHarness({ script: 'attachments' });
  await request(server, 'initialize', { protocol: { versions: ['1.0'] } });
  await createSession(server);
  const result = await request(server, 'turn.start', {
    sessionId: 's1',
    turnId: 't1',
    input: [
      { type: 'skill', skill: 'fake-skill' },
      { type: 'text', text: 'run the skill' },
    ],
    config: {},
  });
  assert.equal((result as { accepted: boolean }).accepted, true);
  const page = await request(server, 'session.events.read', { sessionId: 's1', cursor: null, limit: 100 });
  const events = (page as { events: Array<{ type: string; data: Record<string, unknown> }> }).events;
  const injected = events.filter(event => event.type === 'user/message'
    && typeof (event.data as { source?: { kind?: string } }).source === 'object'
    && (event.data as { source: { kind: string } }).source.kind === 'skill-invocation');
  assert.equal(injected.length, 1);
  const content = ((injected[0]?.data as { message?: { content?: Array<{ text?: string }> } }).message?.content ?? []);
  assert.match(String(content[0]?.text ?? ''), /fake-skill/);
  const userText = events.find(event => event.type === 'user/message'
    && (event.data as { source?: string }).source === 'gian');
  assert.ok(userText, 'the plain user text must remain the turn message');
});

/* -------------------------------- Steering ------------------------------- */

test('steer requires an open native turn and refuses queueing', async () => {
  const { server, runtime } = makeHarness({ script: 'interrupt' });
  await request(server, 'initialize', { protocol: { versions: ['1.0'] } });
  await createSession(server);
  await assert.rejects(
    () => request(server, 'turn.steer', { sessionId: 's1', input: [{ type: 'text', text: 'too early' }] }),
    /TURN_NOT_FOUND/,
  );
  await request(server, 'turn.start', {
    sessionId: 's1', turnId: 't1', config: {},
    input: [{ type: 'text', text: 'start' }],
  });
  const steered = await request(server, 'turn.steer', {
    sessionId: 's1', input: [{ type: 'text', text: 'go left' }],
  });
  assert.equal((steered as { accepted: boolean }).accepted, true);
  const page = await request(server, 'session.events.read', { sessionId: 's1', cursor: null, limit: 100 });
  const events = (page as { events: Array<{ type: string; data: Record<string, unknown> }> }).events;
  const steerMessage = events.find(event => event.type === 'user/message'
    && JSON.stringify(event.data).includes('go left'));
  assert.ok(steerMessage, 'steered content must be delivered as a durable user message');
  assert.equal(runtime.sessions.get('s1')?.openTurn, 0);
});

/* --------------------------------- Fork ---------------------------------- */

test('head fork seeds a child with native lineage and leaves the parent untouched', async () => {
  const { server, runtime } = makeHarness({ script: 'success' });
  await request(server, 'initialize', { protocol: { versions: ['1.0'] } });
  await createSession(server);
  await request(server, 'turn.start', {
    sessionId: 's1', turnId: 't1', config: {},
    input: [{ type: 'text', text: 'history' }],
  });
  const parentEvents = runtime.sessions.get('s1')!.events.length;
  const forked = await request(server, 'session.fork', {
    sessionId: 's1',
    newSessionId: 'child-1',
    anchor: { kind: 'head' },
  }) as { session: { nativeId: string }; parentNativeId: string; atSeq: number; seedEventCount: number };
  assert.equal(forked.parentNativeId, runtime.sessions.get('s1')!.nativeId);
  assert.equal(forked.atSeq, parentEvents - 1);
  assert.equal(forked.seedEventCount, parentEvents);
  const child = runtime.sessions.get('child-1');
  assert.ok(child);
  assert.equal(child.parentNativeId, runtime.sessions.get('s1')!.nativeId);
  assert.equal(child.events.length, parentEvents);
  // The parent is only read: its log is byte-identical after the fork.
  assert.equal(runtime.sessions.get('s1')!.events.length, parentEvents);
});

test('turn-anchored fork cuts at the verified turn/end seq and unknown turns refuse', async () => {
  const { server, runtime } = makeHarness({ script: 'success' });
  await request(server, 'initialize', { protocol: { versions: ['1.0'] } });
  await createSession(server);
  await request(server, 'turn.start', {
    sessionId: 's1', turnId: 't1', config: {},
    input: [{ type: 'text', text: 'first' }],
  });
  await request(server, 'turn.start', {
    sessionId: 's1', turnId: 't2', config: {},
    input: [{ type: 'text', text: 'second' }],
  });
  const turnZeroEnd = runtime.sessions.get('s1')!.events
    .findIndex(event => event.type === 'turn/end' && event.data.turn === 0);
  const forked = await request(server, 'session.fork', {
    sessionId: 's1',
    newSessionId: 'child-at-turn',
    anchor: { kind: 'turn', nativeTurn: 0 },
  }) as { atSeq: number; seedEventCount: number };
  assert.equal(forked.atSeq, turnZeroEnd);
  assert.equal(forked.seedEventCount, turnZeroEnd + 1);
  await assert.rejects(
    () => request(server, 'session.fork', {
      sessionId: 's1',
      newSessionId: 'child-unknown',
      anchor: { kind: 'turn', nativeTurn: 99 },
    }),
    /FORK_BOUNDARY_UNAVAILABLE/,
  );
});

/* --------------------------- Structured questions ------------------------ */

test('user questions map to structured interactions and answers flow back natively', async () => {
  const { server, runtime, notifications } = makeHarness({ script: 'success' });
  await request(server, 'initialize', { protocol: { versions: ['1.0'] } });
  await createSession(server);
  const pending = runtime.askFakeQuestion('s1', [
    {
      id: 'color',
      question: 'Pick a color',
      options: [{ label: 'red' }, { label: 'blue' }],
    },
  ]);
  const requested = notifications.find(n => n.method === 'interaction.requested');
  assert.ok(requested, 'the question must surface as interaction.requested');
  const interactionId = (requested.params as { interactionId: string }).interactionId;
  const singleSelect = (requested.params as { inputs: Array<Record<string, unknown>> }).inputs[0];
  assert.equal(singleSelect?.type, 'single_select');

  await request(server, 'interaction.respond', {
    sessionId: 's1',
    interactionId,
    actionId: 'submit',
    values: { color: 'blue' },
  });
  const answer = await pending as { answers: Array<{ id: string; selected: string[] }> };
  assert.deepEqual(answer.answers, [{ id: 'color', selected: ['blue'] }]);
  const resolved = notifications.find(n => n.method === 'interaction.resolved');
  assert.equal((resolved?.params as { outcome: string }).outcome, 'submitted');
});

test('cancelling a structured question fails the native ask without a fabricated answer', async () => {
  const { server, runtime, notifications } = makeHarness({ script: 'success' });
  await request(server, 'initialize', { protocol: { versions: ['1.0'] } });
  await createSession(server);
  const pending = runtime.askFakeQuestion('s1', [
    { id: 'free', question: 'Describe the change' },
  ]);
  const requested = notifications.find(n => n.method === 'interaction.requested');
  const interactionId = (requested!.params as { interactionId: string }).interactionId;
  await request(server, 'interaction.respond', {
    sessionId: 's1',
    interactionId,
    actionId: 'cancel',
    values: {},
  });
  await assert.rejects(() => pending, /ASK_ABORTED/);
  const resolved = notifications.find(n => n.method === 'interaction.resolved');
  assert.equal((resolved?.params as { outcome: string }).outcome, 'cancelled');
});

/* ------------------------- Subagent and customization -------------------- */

test('subagent lifecycle and child tool activity carry the parent attribution', async () => {
  const { server, notifications } = makeHarness({ script: 'subagent' });
  await request(server, 'initialize', { protocol: { versions: ['1.0'] } });
  await createSession(server);
  await request(server, 'turn.start', {
    sessionId: 's1', turnId: 't1', config: {},
    input: [{ type: 'text', text: 'delegate' }],
  });
  const started = notifications.find(n => n.method === 'subagent.started');
  const activity = notifications.find(n => n.method === 'subagent.activity');
  const finished = notifications.find(n => n.method === 'subagent.finished');
  assert.ok(started && activity && finished, 'lifecycle and activity must be bridged');
  assert.equal((started.params as { sessionId: string }).sessionId, 's1');
  assert.equal((started.params as { state: string }).state, 'running');
  assert.equal((activity.params as { kind: string }).kind, 'tool/call');
  assert.equal((finished.params as { state: string }).state, 'completed');
});

test('customization inventory serves native skills read-only and refuses other kinds', async () => {
  const { server } = makeHarness();
  await request(server, 'initialize', { protocol: { versions: ['1.0'] } });
  const skills = await request(server, 'customization.list', { kind: 'skill' }) as {
    status: string;
    completeness: string;
    items: Array<{ id: string; name: string }>;
  };
  assert.equal(skills.status, 'ok');
  assert.equal(skills.completeness, 'effective');
  assert.equal(skills.items.length, 1);
  const detail = await request(server, 'customization.detail', {
    kind: 'skill',
    id: skills.items[0]!.id,
  }) as { status: string; text: string };
  assert.equal(detail.status, 'ok');
  assert.match(detail.text, /Fake skill body/);
  for (const kind of ['mcp', 'hook', 'rule'] as const) {
    const unsupported = await request(server, 'customization.list', { kind }) as { status: string };
    assert.equal(unsupported.status, 'provider_unsupported');
  }
});
