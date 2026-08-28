import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { GianToolMethod } from '@gian/shared';
import { openDatabase, type Db } from '../src/storage/db.js';
import { GianToolAccessController } from '../src/tool/access.js';
import {
  GianToolCredentialManager,
  type GianToolActor,
  type GianToolRole,
} from '../src/tool/credentials.js';
import type { GianToolService } from '../src/tool/service.js';

const ALL_METHODS: GianToolMethod[] = [
  'catalog.get_create_options',
  'task.list', 'task.get', 'task.create', 'task.update',
  'session.list', 'session.get', 'session.read', 'session.create', 'session.update',
  'session.assign_task', 'session.set_subtask_state', 'session.archive', 'session.send',
  'session.cancel_delivery', 'session.wait', 'session.stop',
  'worktree.create_and_bind',
  'interaction.list', 'interaction.respond',
];

interface Fixture {
  db: Db;
  dir: string;
  access: GianToolAccessController;
  calls: Array<{ call: Record<string, unknown>; actor: GianToolActor | undefined }>;
}

function actor(input: {
  kind: 'internal_session';
  sessionId: string;
  role?: GianToolRole;
  taskId?: string | null;
} | {
  kind: 'external_controller';
  clientId: string;
  role?: GianToolRole;
}): GianToolActor {
  const base = {
    credentialId: `credential-${input.kind}`,
    callerId: input.kind === 'internal_session'
      ? `internal-session:${input.sessionId}`
      : `external-controller:${input.clientId}`,
    role: input.role ?? 'standard',
    grants: [...ALL_METHODS],
    expiresAt: '2026-08-27T00:00:00.000Z',
  };
  return input.kind === 'internal_session'
    ? {
        ...base,
        kind: 'internal_session',
        sessionId: input.sessionId,
        agentId: 'agent-1',
        workspaceId: 'workspace-1',
        taskId: input.taskId ?? null,
      }
    : { ...base, kind: 'external_controller', clientId: input.clientId };
}

function setup(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'gian-tool-authz-'));
  const db = openDatabase(dir);
  db.exec(`
    INSERT INTO workspaces(id, name, path, sort_order, hidden, created_at, updated_at)
    VALUES ('workspace-1', 'Workspace', '/tmp/workspace', 0, 0, datetime('now'), datetime('now'));
    INSERT INTO tasks(id, name, status, pinned_at, created_at, updated_at)
    VALUES
      ('task-1', 'One', 'open', 0, datetime('now'), datetime('now')),
      ('task-2', 'Two', 'open', 0, datetime('now'), datetime('now'));
    INSERT INTO sessions
      (id, name, type, task_id, workspace_id,
       created_by_actor_kind, created_by_actor_id, created_by_session_id,
       executor, agent_id, approval_mode, status, archived, unread,
       native_session_id, created_at, updated_at)
    VALUES
      ('session-a', 'A', 'subtask', 'task-1', 'workspace-1',
       NULL, NULL, NULL,
       'codex', 'agent-1', 'ask', 'done', 0, 0, 'native-a', datetime('now'), datetime('now')),
      ('session-b', 'B direct child', 'subtask', 'task-1', 'workspace-1',
       'internal_session', 'session-a', 'session-a',
       'codex', 'agent-1', 'ask', 'done', 0, 0, 'native-b', datetime('now'), datetime('now')),
      ('session-c', 'C grandchild', 'subtask', 'task-1', 'workspace-1',
       'internal_session', 'session-b', 'session-b',
       'codex', 'agent-1', 'ask', 'done', 0, 0, 'native-c', datetime('now'), datetime('now')),
      ('session-d', 'D sibling', 'coding', NULL, 'workspace-1',
       'internal_session', 'someone-else', NULL,
       'codex', 'agent-1', 'ask', 'done', 0, 0, 'native-d', datetime('now'), datetime('now')),
      ('session-e', 'E external child', 'coding', NULL, 'workspace-1',
       'external_controller', 'external-standard', NULL,
       'codex', 'agent-1', 'ask', 'done', 0, 0, 'native-e', datetime('now'), datetime('now')),
      ('session-admin', 'Internal admin', 'coding', NULL, 'workspace-1',
       NULL, NULL, NULL,
       'codex', 'agent-1', 'ask', 'done', 0, 0, 'native-admin', datetime('now'), datetime('now'));
    INSERT INTO tool_requests
      (id, caller_id, idempotency_key, method, input_hash, status, domain_id,
       result_json, error_json, created_at, updated_at)
    VALUES
      ('request-b', 'owner', 'delivery-b', 'session.send', 'hash-b', 'succeeded', 'delivery-b', '{}', NULL, datetime('now'), datetime('now')),
      ('request-d', 'other', 'delivery-d', 'session.send', 'hash-d', 'succeeded', 'delivery-d', '{}', NULL, datetime('now'), datetime('now'));
    INSERT INTO tool_deliveries
      (id, request_id, session_id, state, created_at, updated_at)
    VALUES
      ('delivery-b', 'request-b', 'session-b', 'queued', datetime('now'), datetime('now')),
      ('delivery-d', 'request-d', 'session-d', 'queued', datetime('now'), datetime('now'));
  `);
  const calls: Fixture['calls'] = [];
  const service = {
    call: async (raw: unknown, context?: { actor: GianToolActor }) => {
      const call = raw as Record<string, unknown>;
      calls.push({ call, actor: context?.actor });
      const method = call.method;
      const params = call.params as Record<string, unknown>;
      if (method === 'interaction.list') {
        return {
          ok: true,
          request_id: String(call.request_id),
          data: {
            interactions: ['session-a', 'session-b', 'session-c', 'session-d', 'session-e', 'session-admin']
              .map(session_id => ({ id: `interaction-${session_id}`, session_id })),
          },
        };
      }
      if (method === 'session.get' || method === 'session.wait') {
        return {
          ok: true,
          request_id: String(call.request_id),
          data: { session: { id: params.session_id }, interactions: [{ id: 'pending', session_id: params.session_id }] },
        };
      }
      if (method === 'session.read') {
        if (params.view === 'events') {
          return {
            ok: true,
            request_id: String(call.request_id),
            data: {
              turns: [],
              events: [
                { display: { type: 'interaction.question' } },
                { display: { type: 'interaction.resolved' } },
              ],
            },
          };
        }
        return {
          ok: true,
          request_id: String(call.request_id),
          data: {
            turns: [{ interactions: [
              { id: 'pending', status: 'pending' },
              { id: 'resolved', status: 'resolved' },
            ] }],
          },
        };
      }
      return { ok: true, request_id: String(call.request_id), data: { session: { id: 'created-child' } } };
    },
  } as unknown as GianToolService;
  return { db, dir, access: new GianToolAccessController(service, db), calls };
}

function teardown(fixture: Fixture): void {
  fixture.db.close();
  rmSync(fixture.dir, { recursive: true, force: true });
}

function call(
  fixture: Fixture,
  toolActor: GianToolActor,
  method: GianToolMethod,
  params: Record<string, unknown>,
) {
  return fixture.access.call(toolActor, {
    request_id: `${method}:${fixture.calls.length}`,
    method,
    params,
    ...(method === 'session.create' || method === 'task.create' || method === 'task.update'
      || method === 'session.update' || method === 'session.assign_task'
      || method === 'session.set_subtask_state' || method === 'session.archive'
      || method === 'session.send' || method === 'session.cancel_delivery'
      || method === 'session.stop' || method === 'worktree.create_and_bind'
      || method === 'interaction.respond'
      ? { idempotency_key: `${method}:${fixture.calls.length}` }
      : {}),
  });
}

test('standard internal actors read globally but mutate only direct children', async () => {
  const fixture = setup();
  try {
    const standard = actor({ kind: 'internal_session', sessionId: 'session-a', taskId: 'task-1' });
    assert.equal((await call(fixture, standard, 'session.get', { session_id: 'session-d' })).ok, true);
    assert.equal((await call(fixture, standard, 'session.update', { session_id: 'session-b', name: 'ok' })).ok, true);
    for (const target of ['session-a', 'session-c', 'session-d']) {
      const result = await call(fixture, standard, 'session.update', { session_id: target, name: 'no' });
      assert.equal(result.error?.code, 'PERMISSION_DENIED', target);
    }
    assert.equal((await call(fixture, standard, 'interaction.respond', {
      session_id: 'session-b', interaction_id: 'interaction-session-b', decision: 'decline',
    })).ok, true);
    assert.equal((await call(fixture, standard, 'interaction.respond', {
      session_id: 'session-a', interaction_id: 'self', decision: 'decline',
    })).error?.code, 'PERMISSION_DENIED');
    assert.equal((await call(fixture, standard, 'session.cancel_delivery', {
      delivery_id: 'delivery-b',
    })).ok, true);
    assert.equal((await call(fixture, standard, 'session.cancel_delivery', {
      delivery_id: 'delivery-d',
    })).error?.code, 'PERMISSION_DENIED');
    assert.equal((await call(fixture, standard, 'session.cancel_delivery', {
      delivery_id: 'missing-delivery',
    })).error?.code, 'NOT_FOUND');
  } finally {
    teardown(fixture);
  }
});

test('direct ownership survives credential rotation', async () => {
  const fixture = setup();
  try {
    const manager = new GianToolCredentialManager(fixture.db);
    const first = manager.issueInternalSession({
      sessionId: 'session-a', grants: ['session.update'], ttlMs: 60_000,
    });
    const second = manager.issueInternalSession({
      sessionId: 'session-a', grants: ['session.update'], ttlMs: 60_000,
    });
    assert.notEqual(first.credentialId, second.credentialId);
    assert.equal(first.actor.callerId, second.actor.callerId);
    assert.equal((await call(fixture, second.actor, 'session.update', {
      session_id: 'session-b', name: 'after rotation',
    })).ok, true);
  } finally {
    teardown(fixture);
  }
});

test('standard Session creation and assignment are forced to the creator Task', async () => {
  const fixture = setup();
  try {
    const taskBound = actor({ kind: 'internal_session', sessionId: 'session-a', taskId: 'task-1' });
    const created = await call(fixture, taskBound, 'session.create', {
      workspace_id: 'workspace-1', agent_id: 'agent-1',
    });
    assert.equal(created.ok, true);
    assert.equal((fixture.calls.at(-1)!.call.params as Record<string, unknown>).task_id, 'task-1');
    assert.equal(fixture.calls.at(-1)!.actor, taskBound);

    const wrongTask = await call(fixture, taskBound, 'session.create', {
      workspace_id: 'workspace-1', agent_id: 'agent-1', task_id: 'task-2',
    });
    assert.equal(wrongTask.error?.code, 'PERMISSION_DENIED');
    assert.equal((await call(fixture, taskBound, 'session.assign_task', {
      session_id: 'session-b', task_id: 'task-1',
    })).ok, true);
    assert.equal((await call(fixture, taskBound, 'session.assign_task', {
      session_id: 'session-b', task_id: 'task-2',
    })).error?.code, 'PERMISSION_DENIED');

    const unassigned = actor({ kind: 'internal_session', sessionId: 'session-d' });
    assert.equal((await call(fixture, unassigned, 'session.create', {
      workspace_id: 'workspace-1', agent_id: 'agent-1', task_id: 'task-1',
    })).error?.code, 'PERMISSION_DENIED');
  } finally {
    teardown(fixture);
  }
});

test('interaction.list follows direct ownership and internal admin excludes itself', async () => {
  const fixture = setup();
  try {
    const standard = actor({ kind: 'internal_session', sessionId: 'session-a', taskId: 'task-1' });
    const standardList = await call(fixture, standard, 'interaction.list', {});
    assert.deepEqual(
      (standardList.data as { interactions: Array<{ session_id: string }> }).interactions.map(item => item.session_id),
      ['session-b'],
    );
    assert.equal((await call(fixture, standard, 'interaction.list', {
      session_id: 'session-c',
    })).error?.code, 'PERMISSION_DENIED');

    const admin = actor({ kind: 'internal_session', sessionId: 'session-admin', role: 'admin' });
    const adminList = await call(fixture, admin, 'interaction.list', {});
    assert.deepEqual(
      (adminList.data as { interactions: Array<{ session_id: string }> }).interactions.map(item => item.session_id),
      ['session-a', 'session-b', 'session-c', 'session-d', 'session-e'],
    );
    assert.equal((await call(fixture, admin, 'interaction.list', {
      session_id: 'session-admin',
    })).error?.code, 'PERMISSION_DENIED');
    assert.equal((await call(fixture, admin, 'session.stop', {
      session_id: 'session-admin',
    })).error?.code, 'PERMISSION_DENIED');
    assert.equal((await call(fixture, admin, 'session.stop', {
      session_id: 'session-d',
    })).ok, true);
  } finally {
    teardown(fixture);
  }
});

test('external standard owns direct children while external admin controls all', async () => {
  const fixture = setup();
  try {
    const standard = actor({ kind: 'external_controller', clientId: 'external-standard' });
    assert.equal((await call(fixture, standard, 'session.update', {
      session_id: 'session-e', name: 'owned',
    })).ok, true);
    assert.equal((await call(fixture, standard, 'session.update', {
      session_id: 'session-b', name: 'not-owned',
    })).error?.code, 'PERMISSION_DENIED');
    const standardList = await call(fixture, standard, 'interaction.list', {});
    assert.deepEqual(
      (standardList.data as { interactions: Array<{ session_id: string }> }).interactions.map(item => item.session_id),
      ['session-e'],
    );

    const admin = actor({ kind: 'external_controller', clientId: 'external-admin', role: 'admin' });
    assert.equal((await call(fixture, admin, 'session.update', {
      session_id: 'session-a', name: 'admin',
    })).ok, true);
    assert.equal((await call(fixture, admin, 'task.create', { name: 'Admin task' })).ok, true);
    const adminList = await call(fixture, admin, 'interaction.list', {});
    assert.equal((adminList.data as { interactions: unknown[] }).interactions.length, 6);
  } finally {
    teardown(fixture);
  }
});

test('worktree self-context allows the bound internal Session but denies external actors', async () => {
  const fixture = setup();
  try {
    const internal = actor({ kind: 'internal_session', sessionId: 'session-admin', role: 'admin' });
    const accepted = await call(fixture, internal, 'worktree.create_and_bind', {
      branch: 'feat/self-context', base_ref: 'HEAD',
    });
    assert.equal(accepted.ok, true);
    assert.equal(fixture.calls.at(-1)?.actor, internal);
    assert.deepEqual(fixture.calls.at(-1)?.call.params, {
      branch: 'feat/self-context', base_ref: 'HEAD',
    });

    const before = fixture.calls.length;
    const external = actor({ kind: 'external_controller', clientId: 'external-admin', role: 'admin' });
    const denied = await call(fixture, external, 'worktree.create_and_bind', {
      branch: 'feat/external',
    });
    assert.equal(denied.error?.code, 'PERMISSION_DENIED');
    assert.equal(fixture.calls.length, before);
  } finally {
    teardown(fixture);
  }
});

test('ordinary reads redact actionable interactions outside management scope', async () => {
  const fixture = setup();
  try {
    const standard = actor({ kind: 'internal_session', sessionId: 'session-a', taskId: 'task-1' });
    const owned = await call(fixture, standard, 'session.get', { session_id: 'session-b' });
    assert.equal((owned.data as { interactions: unknown[] }).interactions.length, 1);
    const sibling = await call(fixture, standard, 'session.get', { session_id: 'session-d' });
    assert.deepEqual((sibling.data as { interactions: unknown[] }).interactions, []);
    const waited = await call(fixture, standard, 'session.wait', { session_id: 'session-d', timeout_ms: 0 });
    assert.deepEqual((waited.data as { interactions: unknown[] }).interactions, []);

    const messages = await call(fixture, standard, 'session.read', {
      session_id: 'session-d', turns: 1, view: 'messages',
    });
    assert.deepEqual(
      (messages.data as { turns: Array<{ interactions: Array<{ id: string }> }> }).turns[0]!.interactions,
      [{ id: 'resolved', status: 'resolved' }],
    );
    const events = await call(fixture, standard, 'session.read', {
      session_id: 'session-d', turns: 1, view: 'events',
    });
    assert.deepEqual(
      (events.data as { events: Array<{ display: { type: string } }> }).events.map(event => event.display.type),
      ['interaction.resolved'],
    );
  } finally {
    teardown(fixture);
  }
});

test('standard actors cannot mutate Tasks even with a crafted grant', async () => {
  const fixture = setup();
  try {
    const standard = actor({ kind: 'internal_session', sessionId: 'session-a', taskId: 'task-1' });
    assert.equal((await call(fixture, standard, 'task.create', { name: 'No' })).error?.code, 'PERMISSION_DENIED');
    assert.equal((await call(fixture, standard, 'task.update', {
      task_id: 'task-1', name: 'No',
    })).error?.code, 'PERMISSION_DENIED');
  } finally {
    teardown(fixture);
  }
});
