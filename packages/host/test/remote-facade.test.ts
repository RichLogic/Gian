import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import {
  REMOTE_METHODS,
  generateCanonicalId,
  generateUuidV7,
  parseRemoteMethodParams,
} from '@gian/remote-protocol';
import type { EventEnvelope } from '@gian/shared';
import { writeAttachment } from '../src/storage/attachments.js';
import {
  assertNoLeak,
  capRemoteTranscriptItems,
  remoteActionId,
  remoteStableUuid,
} from '../src/remote/projection.js';
import { hostServiceTier } from '../src/remote/command-adapter.js';
import {
  command,
  seedDevice,
  setupRemoteHarness,
  teardownRemoteHarness,
} from './fixtures/remote-harness.js';

test('RemoteMethod registry is exhaustive and rejects crafted params', async () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context);
    assert.equal(REMOTE_METHODS.length, 15);
    for (const method of REMOTE_METHODS) {
      assert.equal(typeof method, 'string');
    }
    const crafted = await context.runtime.commands.execute(device, command('session.update', {
      session_id: randomUUID(),
      session_revision: '0',
      name: 'nope',
      approval_mode: 'auto',
    }));
    assert.equal(crafted.ok, false);
    assert.equal(crafted.error?.code, 'INVALID_FRAME');

    const role = await context.runtime.commands.execute(device, command('session.send', {
      session_id: randomUUID(),
      text: 'hi',
      role: 'admin',
    }));
    assert.equal(role.ok, false);
  } finally {
    teardownRemoteHarness(context);
  }
});

test('Remote exports only incomplete Sessions owned by open Doing Tasks', async () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context);
    const visible = await context.sessions.createSession({
      workspace_id: context.workspaceId,
      agent_id: 'agent-claude-review',
      task_id: context.taskId,
      type: 'subtask',
      name: 'Visible Doing session',
    });
    const completed = await context.sessions.createSession({
      workspace_id: context.workspaceId,
      agent_id: 'agent-claude-review',
      task_id: context.taskId,
      type: 'subtask',
      name: 'Completed session',
    });
    context.db.prepare('UPDATE sessions SET completed_at = ? WHERE id = ?')
      .run(new Date().toISOString(), completed.id);
    const unassigned = await context.sessions.createSession({
      workspace_id: context.workspaceId,
      agent_id: 'agent-claude-review',
      task_id: null,
      name: 'Unassigned session',
    });
    const doneTask = context.tasks.createTask({ name: 'Done task' });
    const doneTaskSession = await context.sessions.createSession({
      workspace_id: context.workspaceId,
      agent_id: 'agent-claude-review',
      task_id: doneTask.id,
      type: 'subtask',
      name: 'Done Task session',
    });
    context.tasks.updateTask(doneTask.id, { status: 'done' });
    context.db.prepare('UPDATE sessions SET unread = 1 WHERE id = ?').run(visible.id);

    void context.approvals.request({
      sessionId: visible.id,
      turnId: randomUUID(),
      category: 'command',
      risk: 'high',
      description: 'visible approval',
    });
    void context.approvals.request({
      sessionId: completed.id,
      turnId: randomUUID(),
      category: 'command',
      risk: 'high',
      description: 'hidden approval',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const snapshot = context.runtime.projector.snapshot({
      capabilities: {} as never,
      deviceId: device.id,
      attention: [
        { session_id: visible.id, kind: 'running', updated_at: new Date().toISOString() },
        { session_id: completed.id, kind: 'completed', updated_at: new Date().toISOString() },
      ],
    });
    assert.deepEqual(snapshot.sessions.map((session) => session.id), [visible.id]);
    assert.equal(snapshot.sessions[0]?.unread, true);
    assert.deepEqual(snapshot.tasks.map((task) => task.id), [context.taskId]);
    assert.deepEqual(snapshot.tasks[0]?.session_ids, [visible.id]);
    assert.deepEqual(snapshot.interactions.map((interaction) => interaction.session_id), [visible.id]);
    assert.deepEqual(snapshot.attention.map((attention) => attention.session_id), [visible.id]);

    writeFileSync(join(context.dir, 'completed.txt'), 'must stay local');
    const staleFile = context.runtime.fileRefs.issue({
      deviceId: device.id,
      sessionId: completed.id,
      relativePath: 'completed.txt',
      contentRevision: '1',
    });
    await assert.rejects(
      () => context.runtime.fileRefs.preview({ deviceId: device.id, handleId: staleFile.id }),
      /no longer available/,
    );
    await assert.rejects(
      () => context.runtime.attachments.begin({
        deviceId: device.id,
        sessionId: completed.id,
        name: 'hidden.txt',
        mime: 'text/plain',
        size: 1,
        sha256: '0'.repeat(64),
      }),
      /not visible/,
    );

    for (const session of [completed, unassigned, doneTaskSession]) {
      const page = await context.runtime.commands.execute(device, command('session.page', {
        session_id: session.id,
        turns: 3,
      }));
      assert.equal(page.ok, false);
      assert.equal(page.error?.code, 'REMOTE_CAPABILITY_DENIED');
    }

    const unassignedCreate = await context.runtime.commands.execute(device, command('session.create', {
      catalog_revision: context.runtime.projector.catalogRevision(),
      workspace_id: context.workspaceId,
      agent_id: remoteStableUuid('agent', 'agent-claude-review'),
    }));
    assert.equal(unassignedCreate.ok, false);
    assert.equal(unassignedCreate.error?.code, 'REMOTE_CAPABILITY_DENIED');

    const beforeTaskRemovalSequence = context.runtime.replay.eventSequence;
    const beforeTaskRemovalRevision = context.runtime.replay.currentRevision;
    context.tasks.updateTask(context.taskId, { status: 'done' });
    context.runtime.observeHostBroadcast({
      type: 'task:updated',
      task: { id: context.taskId, status: 'done' },
    });
    const taskRemoval = context.runtime.replay.replayAfter(
      beforeTaskRemovalSequence - 1,
      beforeTaskRemovalRevision,
    );
    assert.notEqual(taskRemoval, 'snapshot');
    assert.ok(taskRemoval.some((frame) => (
      frame.message.type === 'state.patch'
      && frame.message.patch.tasks?.remove_ids.includes(context.taskId)
      && frame.message.patch.sessions?.remove_ids.includes(visible.id)
    )));
  } finally {
    teardownRemoteHarness(context);
  }
});

test('catalog, session, queue, and history projections cannot leak path/native/credential fields', async () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context);
    const catalog = await context.runtime.commands.execute(device, command('catalog.read', {}));
    assert.equal(catalog.ok, true, catalog.error?.message);
    assertNoLeak(catalog.data);
    const serialized = JSON.stringify(catalog.data);
    assert.equal(serialized.includes('"path"'), false);
    assert.equal(serialized.includes('native_session_id'), false);
    assert.equal(serialized.includes('/tmp/'), false);

    const created = await context.runtime.commands.execute(device, command('session.create', {
      catalog_revision: context.runtime.projector.catalogRevision(),
      workspace_id: context.workspaceId,
      task_id: context.taskId,
      agent_id: remoteStableUuid('agent', 'agent-claude-review'),
      name: 'Remote session',
    }));
    assert.equal(created.ok, true, created.error?.message);
    assertNoLeak(created.data);
    const session = created.data as { id: string; revision: string; queue: { revision: string } };
    assert.equal((created.data as { model?: string }).model, 'sonnet');

    const snapshot = await context.runtime.commands.execute(device, command('state.refresh', {}));
    assert.equal(snapshot.ok, true, snapshot.error?.message);
    assertNoLeak(snapshot.data);
    assert.equal(JSON.stringify(snapshot.data).includes('runtime_profile'), false);

    const page = await context.runtime.commands.execute(device, command('session.page', {
      session_id: session.id,
      turns: 3,
    }));
    assert.equal(page.ok, true, page.error?.message);
    assertNoLeak(page.data);

    const queued = await context.runtime.commands.execute(device, command('session.send', {
      session_id: session.id,
      text: 'first',
    }));
    assert.equal(queued.ok, true, queued.error?.message);
    const second = await context.runtime.commands.execute(device, command('session.send', {
      session_id: session.id,
      text: 'queued-later',
    }));
    assert.equal(second.ok, true, second.error?.message);
    const get = context.sessions.getQueue(session.id);
    const revision = context.sessions.getQueueRevision(session.id);
    const updated = await context.runtime.commands.execute(device, command('queue.update', {
      session_id: session.id,
      queue_id: get[0]!.id,
      text: 'edited-remote',
      expected_queue_revision: revision,
    }));
    assert.equal(updated.ok, true, updated.error?.message);
    assertNoLeak(updated.data);
  } finally {
    teardownRemoteHarness(context);
  }
});

test('Remote transcript projection preserves event kind and turn without exporting activity payloads', () => {
  const context = setupRemoteHarness();
  try {
    const event = {
      session_id: randomUUID(),
      turn: 7,
      call_id: 'command-1',
      event: 'item/commandExecution/updated',
      ts: Date.now(),
      data: { native: 'not exported' },
      display: {
        type: 'activity.command',
        data: {
          itemId: 'command-1',
          command: 'curl --token top-secret',
          cwd: '/Users/example/private',
          status: 'success',
          stdout: 'read /Users/example/private/file.txt',
          exitCode: 0,
        },
      },
    } satisfies EventEnvelope;

    const projected = context.runtime.projector.projectTranscriptEvent(event);
    assert.deepEqual(projected && {
      kind: projected.kind,
      turn: projected.turn,
      status: projected.kind === 'command' ? projected.status : undefined,
      exit_code: projected.kind === 'command' ? projected.exit_code : undefined,
    }, { kind: 'command', turn: 7, status: 'success', exit_code: 0 });
    assert.equal(JSON.stringify(projected).includes('top-secret'), false);
    assert.equal(JSON.stringify(projected).includes('/Users/example'), false);

    const streamedUpdate = context.runtime.projector.projectTranscriptEvent({
      ...event,
      call_id: 'command-1-update',
      display: {
        ...event.display,
        data: { ...event.display.data, status: 'running' },
      },
    });
    assert.equal(streamedUpdate?.id, projected?.id);

    assert.equal(context.runtime.projector.projectTranscriptEvent({
      ...event,
      call_id: 'turn-started',
      event: 'turn.started',
      display: { type: 'state.turn-started', data: { turnId: randomUUID() } },
    }), null);
  } finally {
    teardownRemoteHarness(context);
  }
});

test('Remote transcript attachments use device-scoped handles for E2EE preview', async () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context);
    const sessionId = (await context.sessions.createSession({
      workspace_id: context.workspaceId,
      agent_id: 'agent-claude-review',
      task_id: context.taskId,
      type: 'subtask',
      name: 'Attachment projection',
    })).id;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const markdown = Buffer.from('# Remote notes\n');
    const pngPath = await writeAttachment(sessionId, png, 'image/png', 'screen.png');
    const markdownPath = await writeAttachment(sessionId, markdown, 'text/markdown', 'notes.md');
    const event = {
      session_id: sessionId,
      turn: 3,
      call_id: 'message-with-files',
      event: 'user_message',
      ts: Date.now(),
      data: {
        text: 'See the attached files.',
        attachments: [
          {
            name: 'screen.png',
            mime: 'image/png',
            url: `/api/sessions/${sessionId}/attachments/${basename(pngPath)}`,
            size: png.length,
          },
          {
            name: 'notes.md',
            mime: 'application/octet-stream',
            url: `/api/sessions/${sessionId}/attachments/${basename(markdownPath)}`,
            size: markdown.length,
          },
        ],
      },
    } satisfies EventEnvelope;

    const projected = context.runtime.projector.projectTranscriptEvent(event, device.id);
    assert.equal(projected?.kind, 'user');
    if (projected?.kind !== 'user') assert.fail('expected a projected user message');
    assert.equal(projected.attachments?.length, 2);
    assert.equal(JSON.stringify(projected).includes(context.dir), false);

    const [imageRef, textRef] = projected.attachments ?? [];
    assert.ok(imageRef);
    assert.ok(textRef);
    assert.equal(imageRef.mime, 'image/png');
    assert.equal(textRef.mime, 'text/markdown');

    const imagePreview = await context.runtime.fileRefs.preview({
      handleId: imageRef.id,
      deviceId: device.id,
      expectedRevision: imageRef.revision,
    });
    assert.equal(imagePreview.file.mime, 'image/png');
    assert.deepEqual(imagePreview.bytes, png);

    const textPreview = await context.runtime.fileRefs.preview({
      handleId: textRef.id,
      deviceId: device.id,
      expectedRevision: textRef.revision,
    });
    assert.equal(textPreview.file.mime, 'text/markdown');
    assert.deepEqual(textPreview.bytes, markdown);
  } finally {
    teardownRemoteHarness(context);
  }
});

test('Remote catalog projection exposes model choices without runtime paths or native config', () => {
  const context = setupRemoteHarness();
  try {
    const projected = context.runtime.projector.projectCatalog({
      workspaces: [{ id: context.workspaceId, name: 'Remote test', path: '/private/workspace' }],
      agents: [{
        id: 'agent-claude-review',
        name: 'Claude Review',
        proxy: 'claude',
        ready: true,
        defaults: { model: 'sonnet', thinking: 'high' },
        models: [{
          id: 'sonnet',
          label: 'Claude Sonnet',
          is_default: true,
          supported_thinking: ['medium', 'high'],
        }],
      }],
      tasks: [],
    });

    assert.deepEqual(projected.agents[0]?.models, [{
      id: 'sonnet',
      label: 'Claude Sonnet',
      is_default: true,
      supported_thinking: ['medium', 'high'],
    }]);
    assert.equal(JSON.stringify(projected).includes('/private/workspace'), false);
    assertNoLeak(projected);
  } finally {
    teardownRemoteHarness(context);
  }
});

test('Remote transcript page caps activity floods without dropping conversation messages', () => {
  const turnId = randomUUID();
  const base = { turn_id: turnId, turn: 4, ts: Date.now() };
  const items = [
    { ...base, id: randomUUID(), kind: 'user' as const, text: 'question' },
    ...Array.from({ length: 300 }, () => ({
      ...base,
      id: randomUUID(),
      kind: 'command' as const,
      status: 'success' as const,
    })),
    { ...base, id: randomUUID(), kind: 'assistant' as const, text: 'answer', delta: false },
    { ...base, id: randomUUID(), kind: 'turn-end' as const, outcome: 'worked' as const },
  ];
  const capped = capRemoteTranscriptItems(items);
  assert.equal(capped.length, 256);
  assert.equal(capped.some(item => item.kind === 'user' && item.text === 'question'), true);
  assert.equal(capped.some(item => item.kind === 'assistant' && item.text === 'answer'), true);
  assert.equal(capped.some(item => item.kind === 'turn-end'), true);
});

test('command.status covers accepted, succeeded, failed, unknown, and expired', async () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context);
    const expiredId = generateUuidV7(Date.now() - 91 * 24 * 60 * 60 * 1000);
    const expired = await context.runtime.commands.execute(device, command('session.send', {
      session_id: randomUUID(),
      text: 'old',
    }, expiredId));
    assert.equal(expired.ok, false);
    assert.equal(expired.error?.code, 'COMMAND_EXPIRED');

    const statusExpired = await context.runtime.commands.execute(device, command('command.status', {
      command_id: expiredId,
    }));
    assert.equal(statusExpired.ok, true);
    assert.equal((statusExpired.data as { state: string }).state, 'expired');

    const missing = await context.runtime.commands.execute(device, command('command.status', {
      command_id: generateUuidV7(),
    }));
    assert.equal((missing.data as { state: string }).state, 'not_seen');

    const created = await context.runtime.commands.execute(device, command('session.create', {
      catalog_revision: context.runtime.projector.catalogRevision(),
      workspace_id: context.workspaceId,
      task_id: context.taskId,
      agent_id: remoteStableUuid('agent', 'agent-claude-review'),
    }));
    assert.equal(created.ok, true, created.error?.message);
    const commandId = generateUuidV7();
    const send = await context.runtime.commands.execute(
      device,
      command('session.send', {
        session_id: (created.data as { id: string }).id,
        text: 'hello remote',
      }, commandId),
    );
    assert.equal(send.ok, true, send.error?.message);
    const replay = await context.runtime.commands.execute(
      device,
      command('session.send', {
        session_id: (created.data as { id: string }).id,
        text: 'hello remote',
      }, commandId),
    );
    assert.equal(replay.ok, true);
    const status = await context.runtime.commands.execute(device, command('command.status', {
      command_id: commandId,
    }));
    assert.equal((status.data as { state: string }).state, 'succeeded');
    assertNoLeak(status.data);
  } finally {
    teardownRemoteHarness(context);
  }
});

test('two devices racing Queue revision leave one mutation', async () => {
  const context = setupRemoteHarness();
  try {
    const a = seedDevice(context, 'A');
    const b = seedDevice(context, 'B');
    const created = await context.runtime.commands.execute(a, command('session.create', {
      catalog_revision: context.runtime.projector.catalogRevision(),
      workspace_id: context.workspaceId,
      task_id: context.taskId,
      agent_id: remoteStableUuid('agent', 'agent-claude-review'),
    }));
    const sessionId = (created.data as { id: string }).id;
    await context.runtime.commands.execute(a, command('session.send', { session_id: sessionId, text: 'busy' }));
    await context.runtime.commands.execute(a, command('session.send', { session_id: sessionId, text: 'queued' }));
    const revision = context.sessions.getQueueRevision(sessionId);
    const queueId = context.sessions.getQueue(sessionId)[0]!.id;
    const first = await context.runtime.commands.execute(a, command('queue.update', {
      session_id: sessionId,
      queue_id: queueId,
      text: 'from-a',
      expected_queue_revision: revision,
    }));
    const second = await context.runtime.commands.execute(b, command('queue.update', {
      session_id: sessionId,
      queue_id: queueId,
      text: 'from-b',
      expected_queue_revision: revision,
    }));
    assert.equal(first.ok, true, first.error?.message);
    assert.equal(second.ok, false);
    assert.equal(second.error?.code, 'PRECONDITION_FAILED');
  } finally {
    teardownRemoteHarness(context);
  }
});

test('catalog revision includes agents and open tasks', async () => {
  const context = setupRemoteHarness();
  try {
    const before = context.runtime.projector.catalogRevision();
    await context.tasks.createTask({ name: 'Remote catalog task' });
    const after = context.runtime.projector.catalogRevision();
    assert.notEqual(after, before);
  } finally {
    teardownRemoteHarness(context);
  }
});

test('interaction.respond rejects unissued action ids and snapshot lists pending actions', async () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context);
    const created = await context.runtime.commands.execute(device, command('session.create', {
      catalog_revision: context.runtime.projector.catalogRevision(),
      workspace_id: context.workspaceId,
      task_id: context.taskId,
      agent_id: remoteStableUuid('agent', 'agent-claude-review'),
    }));
    const sessionId = (created.data as { id: string }).id;
    const turnId = randomUUID();
    void context.approvals.request({
      sessionId,
      turnId,
      category: 'command',
      risk: 'high',
      description: 'run a dangerous command',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const pending = context.approvals.listPending();
    assert.equal(pending.length, 1);
    const snapshot = await context.runtime.commands.execute(device, command('state.refresh', {}));
    const interactions = (snapshot.data as { interactions: Array<{ id: string; presentation: { actions: Array<{ id: string }> } }> }).interactions;
    assert.equal(interactions.length, 1);
    const forged = await context.runtime.commands.execute(device, command('interaction.respond', {
      interaction_id: pending[0]!.id,
      interaction_revision: '0',
      action_id: randomUUID(),
    }));
    assert.equal(forged.ok, false);
    assert.equal(forged.error?.code, 'REMOTE_CAPABILITY_DENIED');
    const allow = remoteActionId(pending[0]!.id, 'allow_once');
    assert.equal(interactions[0]?.presentation.actions.some((action) => action.id === allow), true);
  } finally {
    teardownRemoteHarness(context);
  }
});

test('session.page honors cursor and future command ids expire', async () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context);
    const created = await context.runtime.commands.execute(device, command('session.create', {
      catalog_revision: context.runtime.projector.catalogRevision(),
      workspace_id: context.workspaceId,
      task_id: context.taskId,
      agent_id: remoteStableUuid('agent', 'agent-claude-review'),
    }));
    const sessionId = (created.data as { id: string }).id;
    await context.runtime.commands.execute(device, command('session.send', { session_id: sessionId, text: 'one' }));
    await context.runtime.commands.execute(device, command('session.send', { session_id: sessionId, text: 'two' }));
    const first = await context.runtime.commands.execute(device, command('session.page', {
      session_id: sessionId,
      turns: 1,
    }));
    assert.equal(first.ok, true, first.error?.message);
    const page = first.data as {
      cursor?: string;
      has_more: boolean;
      items: Array<{ kind: string; turn: number; category?: string }>;
    };
    assert.equal(typeof page.has_more, 'boolean');
    assert.equal(page.items.every(item => item.turn > 0), true);
    assert.equal(page.items.every(item => item.category === undefined), true);
    assert.equal(page.items.some(item => item.kind === 'user'), true);
    const cursor = page.cursor;
    if (cursor) {
      const second = await context.runtime.commands.execute(device, command('session.page', {
        session_id: sessionId,
        turns: 1,
        cursor,
      }));
      assert.equal(second.ok, true, second.error?.message);
    }
    const future = generateUuidV7(Date.now() + 60_000);
    const expired = await context.runtime.commands.execute(device, command('session.send', {
      session_id: sessionId,
      text: 'from-the-future',
    }, future));
    assert.equal(expired.ok, false);
    assert.equal(expired.error?.code, 'COMMAND_EXPIRED');
  } finally {
    teardownRemoteHarness(context);
  }
});

test('file_ref and composer reference fail closed unless the handle was Host-issued', async () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context);
    const created = await context.runtime.commands.execute(device, command('session.create', {
      catalog_revision: context.runtime.projector.catalogRevision(),
      workspace_id: context.workspaceId,
      task_id: context.taskId,
      agent_id: remoteStableUuid('agent', 'agent-claude-review'),
    }));
    const sessionId = (created.data as { id: string }).id;
    writeFileSync(join(context.dir, 'notes.md'), '# hello\n');
    const issued = context.runtime.fileRefs.issue({
      deviceId: device.id,
      sessionId,
      relativePath: 'notes.md',
      contentRevision: '1',
    });
    const missing = await context.runtime.commands.execute(device, command('session.send', {
      session_id: sessionId,
      text: 'drop-me',
      context_items: [{ type: 'file_ref', handle_id: generateCanonicalId() }],
    }));
    assert.equal(missing.ok, false);
    assert.equal(missing.error?.code, 'FILE_REFERENCE_EXPIRED');

    const badRef = await context.runtime.commands.execute(device, command('session.send', {
      session_id: sessionId,
      text: 'drop-ref',
      composer_document: {
        type: 'document',
        nodes: [{ type: 'reference', handle_id: generateCanonicalId() }],
      },
    }));
    assert.equal(badRef.ok, false);
    assert.equal(badRef.error?.code, 'FILE_REFERENCE_EXPIRED');

    const ok = await context.runtime.commands.execute(device, command('session.send', {
      session_id: sessionId,
      text: 'keep-me',
      context_items: [{ type: 'file_ref', handle_id: issued.id }],
      composer_document: {
        type: 'document',
        nodes: [
          { type: 'text', text: 'see ' },
          { type: 'reference', handle_id: issued.id },
        ],
      },
    }));
    assert.equal(ok.ok, true, ok.error?.message);
    assert.ok(context.proxy.client.startTurnCalls[0]?.input.some((item) => (
      item.type === 'localFile' && 'path' in item && String(item.path).endsWith('notes.md')
    )));

    const queued = await context.runtime.commands.execute(device, command('session.send', {
      session_id: sessionId,
      text: 'queued-ref',
      busy: 'queue',
      context_items: [{ type: 'file_ref', handle_id: issued.id }],
    }));
    assert.equal(queued.ok, true, queued.error?.message);
    const entry = context.sessions.getQueue(sessionId)[0];
    assert.ok(entry?.items?.some((item) => item.type === 'localFile'));
  } finally {
    teardownRemoteHarness(context);
  }
});

test('command ledger uniqueness is per device so the same command_id cannot collide', async () => {
  const context = setupRemoteHarness();
  try {
    const first = seedDevice(context, 'One');
    const second = seedDevice(context, 'Two');
    const created = await context.runtime.commands.execute(first, command('session.create', {
      catalog_revision: context.runtime.projector.catalogRevision(),
      workspace_id: context.workspaceId,
      task_id: context.taskId,
      agent_id: remoteStableUuid('agent', 'agent-claude-review'),
    }));
    const sessionId = (created.data as { id: string }).id;
    const commandId = generateUuidV7();
    const a = await context.runtime.commands.execute(first, command('session.send', {
      session_id: sessionId,
      text: 'from-a',
    }, commandId));
    const b = await context.runtime.commands.execute(second, command('session.send', {
      session_id: sessionId,
      text: 'from-b',
    }, commandId));
    assert.equal(a.ok, true, a.error?.message);
    assert.equal(b.ok, true, b.error?.message);
    const statusA = await context.runtime.commands.execute(first, command('command.status', { command_id: commandId }));
    const statusB = await context.runtime.commands.execute(second, command('command.status', { command_id: commandId }));
    assert.equal((statusA.data as { state: string }).state, 'succeeded');
    assert.equal((statusB.data as { state: string }).state, 'succeeded');
    const rows = context.db.prepare(
      'SELECT device_id, command_id FROM remote_command_ledger WHERE command_id = ?',
    ).all(commandId) as Array<{ device_id: string }>;
    assert.equal(rows.length, 2);
    assert.deepEqual(new Set(rows.map((row) => row.device_id)), new Set([first.id, second.id]));
  } finally {
    teardownRemoteHarness(context);
  }
});

test('parseRemoteMethodParams rejects unknown session.update fields', () => {
  assert.throws(() => parseRemoteMethodParams('session.update', {
    session_id: '11111111-1111-4111-8111-111111111111',
    session_revision: '1',
    path: '/etc/passwd',
  }));
});

test('Remote standard mode clears the Host fast service tier', () => {
  assert.equal(hostServiceTier('standard'), null);
  assert.equal(hostServiceTier('fast'), 'fast');
});

test('session mutations push control events into the Host replay buffer', async () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context);
    assert.equal(context.runtime.replay.eventSequence, 0);
    const created = await context.runtime.commands.execute(device, command('session.create', {
      catalog_revision: context.runtime.projector.catalogRevision(),
      workspace_id: context.workspaceId,
      task_id: context.taskId,
      agent_id: remoteStableUuid('agent', 'agent-claude-review'),
      name: 'Live session',
    }));
    assert.equal(created.ok, true, created.error?.message);
    assert.ok(context.runtime.replay.eventSequence > 0, 'production path must call replay.push');
    const replayed = context.runtime.replay.replayAfter(-1, context.runtime.replay.currentRevision);
    assert.notEqual(replayed, 'snapshot');
    assert.ok(replayed.some((frame) => (
      frame.message.type === 'event' || frame.message.type === 'state.patch'
    )));

    const sessionId = (created.data as { id: string }).id;
    const other = await context.runtime.commands.execute(device, command('session.create', {
      catalog_revision: context.runtime.projector.catalogRevision(),
      workspace_id: context.workspaceId,
      task_id: context.taskId,
      agent_id: remoteStableUuid('agent', 'agent-claude-review'),
      name: 'Background session',
    }));
    const otherId = (other.data as { id: string }).id;
    await context.runtime.commands.execute(device, command('session.subscribe', {
      session_id: sessionId,
    }));
    const beforeTranscript = context.runtime.replay.eventSequence;
    context.runtime.observeHostBroadcast({
      type: 'event',
      session_id: otherId,
      turn: 1,
      call_id: randomUUID(),
      event: 'output.text',
      ts: Date.now(),
      data: { text: 'other session' },
    });
    context.runtime.observeHostBroadcast({
      type: 'event',
      session_id: sessionId,
      turn: 1,
      call_id: randomUUID(),
      event: 'output.text',
      ts: Date.now(),
      data: { text: 'hello remote' },
    });
    assert.equal(context.runtime.replay.eventSequence, beforeTranscript);
    const after = context.runtime.replay.replayAfter(-1, context.runtime.replay.currentRevision);
    assert.notEqual(after, 'snapshot');
    assert.ok(!after.some((frame) => (
      frame.message.type === 'event'
      && (frame.message as { event?: { kind?: string } }).event?.kind === 'transcript.item'
    )));

    const beforeRemovalSequence = context.runtime.replay.eventSequence;
    const beforeRemovalRevision = context.runtime.replay.currentRevision;
    context.db.prepare('UPDATE sessions SET completed_at = ? WHERE id = ?')
      .run(new Date().toISOString(), otherId);
    context.runtime.observeHostBroadcast({ type: 'session:updated', session: { id: otherId } });
    const removal = context.runtime.replay.replayAfter(
      beforeRemovalSequence - 1,
      beforeRemovalRevision,
    );
    assert.notEqual(removal, 'snapshot');
    assert.ok(removal.some((frame) => (
      frame.message.type === 'state.patch'
      && (frame.message.patch.sessions?.remove_ids ?? []).includes(otherId)
    )));
  } finally {
    teardownRemoteHarness(context);
  }
});
