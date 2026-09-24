import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateCanonicalId, executionSyncResultSchema, type ExecutionSession } from '@gian/remote-protocol';
import type { EventEnvelope } from '@gian/shared';
import { RemoteExecutionBindings } from '../src/remote/execution-bindings.js';
import { RemoteExecutionReplicas } from '../src/remote/execution-journal.js';
import { remoteHistoryEvent } from '../src/remote/controller-hub.js';
import { remoteStableUuid } from '../src/remote/projection.js';
import { command, seedDevice, setupRemoteHarness, teardownRemoteHarness } from './fixtures/remote-harness.js';

test('exported executions belong to Repos, not remote Tasks, and another same-account device can resume history', async () => {
  const f = setupRemoteHarness();
  try {
    const creator = seedDevice(f);
    f.runtime.devices.bindAccount(creator.id, '42');
    const device = f.runtime.devices.get(creator.id)!;
    const create = command('execution.create', {
      catalog_revision: f.runtime.projector.catalogRevision(), workspace_id: f.workspaceId,
      agent_id: remoteStableUuid('agent', 'agent-claude-review'), name: 'Remote execution',
    });
    const result = await f.runtime.commands.execute(device, create);
    assert.equal(result.ok, true, result.error?.message);
    const session = result.data as ExecutionSession;
    assert.equal(session.task_id, null);
    assert.equal(session.workspace_id, f.workspaceId);
    assert.equal(f.tasks.listTasks().length, 1);
    const repeated = await f.runtime.commands.execute(device, { ...create, attempt_id: generateCanonicalId() });
    assert.equal((repeated.data as ExecutionSession).id, session.id);

    const next = seedDevice(f, 'Second Gian');
    f.runtime.devices.bindAccount(next.id, '42');
    const controller = f.runtime.devices.get(next.id)!;
    f.runtime.devices.revoke(device.id);
    assert.equal(f.runtime.executions.list(controller).sessions[0]?.id, session.id);
    assert.throws(() => f.runtime.executions.list({ ...controller, accountId: null }), /verified account/);
    assert.throws(() => f.runtime.executions.sync({ ...controller, accountId: '99' }, { session_id: session.id, after: 0 }), /not available/);

    const marker = 'REMOTE_AB_' + generateCanonicalId();
    const fullText = ('remote result ' + marker + '\n').repeat(700);
    f.runtime.executions.append({ session_id: session.id, turn: 1, call_id: 'user', ts: Date.now(),
      event: 'user_message', data: { text: marker } });
    f.runtime.executions.append({ session_id: session.id, turn: 1, call_id: 'answer', ts: Date.now(),
      event: 'content.completed', data: {}, display: { type: 'message', data: { itemId: 'answer', text: fullText, delta: false } } });
    const page = f.runtime.executions.sync(controller, { session_id: session.id, after: 0 });
    const user = page.events.find(entry => 'item' in entry && entry.item.kind === 'user');
    assert.ok(user && 'item' in user && user.item.kind === 'user');
    assert.equal(user.item.text, marker);
    const text = page.events.flatMap(entry => 'item' in entry && entry.item.kind === 'assistant' ? [entry.item.text] : []).join('');
    assert.equal(text, fullText);
    assert.ok(page.events.length > 1);
    assert.equal(page.has_more, false);
    assert.equal(f.runtime.executions.sync(controller, { session_id: session.id, after: page.cursor, stream_id: page.stream_id }).events.length, 0);
  } finally { teardownRemoteHarness(f); }
});

test('replicas persist contiguous history, real interaction resolution, and reject stale or cross-session replies', async () => {
  const f = setupRemoteHarness();
  try {
    const seeded = seedDevice(f);
    f.runtime.devices.bindAccount(seeded.id, '42');
    const device = f.runtime.devices.get(seeded.id)!;
    const remote = await f.sessions.createSession({ workspace_id: f.workspaceId, agent_id: 'agent-claude-review' });
    f.runtime.executions.register(remote.id, device);
    const approvalId = generateCanonicalId();
    const event: EventEnvelope = { session_id: remote.id, turn: 1, call_id: approvalId, ts: Date.now(),
      event: 'approval_requested', data: {}, display: { type: 'interaction.approval', data: {
        approvalId, title: 'Write file', category: 'command', description: 'Write result.txt', risk: 'low', scopeOptions: ['once'],
      } } };
    f.runtime.executions.append(event);
    f.runtime.executions.append({ ...event, event: 'approval_resolved', display: { type: 'interaction.resolved',
      data: { approvalId, decision: 'decline', auto: false } } });
    const data = f.runtime.executions.sync(device, { session_id: remote.id, after: 0 });
    assert.ok('interaction' in data.events[0]!);
    assert.ok('resolution' in data.events[1]!);
    const localId = generateCanonicalId();
    f.db.prepare('INSERT INTO sessions (id, executor, native_session_id, task_id) VALUES (?, ?, ?, ?)')
      .run(localId, 'claude', generateCanonicalId(), f.taskId);
    const bindings = new RemoteExecutionBindings(f.db);
    const binding = bindings.bind({ local_session_id: localId, target: {
      server_origin: 'https://remote.example', server_identity_fingerprint: 'a'.repeat(64), account_id: '42',
      host_id: generateCanonicalId(), remote_session_id: remote.id,
    } });
    const replicas = new RemoteExecutionReplicas(f.db);
    replicas.apply(binding, data);
    replicas.apply(binding, data);
    assert.equal(replicas.items(localId).length, 2);
    assert.equal(replicas.snapshot(localId)?.events.length, 0);
    const history = new RemoteExecutionReplicas(f.db).items(localId).map(entry => remoteHistoryEvent(localId, entry));
    assert.equal(history[0]?.display?.type, 'interaction.approval');
    assert.equal(history[1]?.display?.type, 'interaction.resolved');
    if (history[1]?.display?.type === 'interaction.resolved') assert.equal(history[1].display.data.decision, 'decline');
    assert.throws(() => replicas.apply(binding, { ...data, session: { ...data.session, id: generateCanonicalId() } }), /cross-session/);
    assert.throws(() => replicas.apply(binding, { ...data, events: [], cursor: 0 }), /stale history/);
    assert.throws(() => replicas.apply(binding, { ...data, stream_id: generateCanonicalId() }), /stream changed/);
    assert.throws(() => replicas.apply(binding, { ...data, events: [], cursor: data.cursor + 1 }), /history cursor/);
    assert.equal(executionSyncResultSchema.safeParse(data).success, true);
    assert.equal(f.sessions.getSession(localId).task_id, f.taskId);
  } finally { teardownRemoteHarness(f); }
});
