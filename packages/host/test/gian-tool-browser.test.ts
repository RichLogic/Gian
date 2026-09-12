import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { GianToolMethod } from '@gian/shared';
import { ApprovalManager } from '../src/approval/index.js';
import { openDatabase } from '../src/storage/db.js';
import { TaskManager } from '../src/task/manager.js';
import { SessionManager } from '../src/session/manager.js';
import { GianToolAccessController } from '../src/tool/access.js';
import { GianToolService } from '../src/tool/service.js';
import type { BrowserToolClient } from '../src/tool/browser-broker.js';
import type { GianToolActor } from '../src/tool/credentials.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';

const BROWSER_METHODS: GianToolMethod[] = [
  'browser.tabs', 'browser.open', 'browser.snapshot', 'browser.click', 'browser.fill',
  'browser.press', 'browser.wait', 'browser.evaluate', 'browser.screenshot',
  'browser.go_back', 'browser.reload', 'browser.close',
];

test('local Browser capture approvals can be resolved only by Gian Web UI', async () => {
  const resolved: unknown[] = [];
  const manager = {
    getSession() { return {}; },
    approvals: {
      getPending() {
        return { sessionId: 'session-1', payload: { localOnly: true } };
      },
      resolve(...args: unknown[]) { resolved.push(args); },
    },
  };
  await assert.rejects(
    SessionManager.prototype.respondApproval.call(
      manager as never,
      'session-1', 'approval-1', 'allow_once', undefined, undefined, 'tool',
    ),
    /must be resolved in Gian Desktop/,
  );
  await SessionManager.prototype.respondApproval.call(
    manager as never,
    'session-1', 'approval-1', 'allow_once', undefined, undefined, 'web',
  );
  assert.deepEqual(resolved, [['approval-1', 'allow_once', 'web']]);
});

function actor(kind: 'internal_session' | 'external_controller'): GianToolActor {
  const common = {
    credentialId: `credential-${kind}`,
    callerId: kind === 'internal_session' ? 'internal-session:session-1' : 'external-controller:test',
    role: 'admin' as const,
    grants: [...BROWSER_METHODS],
    expiresAt: '2027-01-01T00:00:00.000Z',
  };
  return kind === 'internal_session'
    ? {
        ...common,
        kind,
        sessionId: 'session-1',
        agentId: 'agent-1',
        workspaceId: 'workspace-1',
        taskId: null,
      }
    : { ...common, kind, clientId: 'test' };
}

test('Browser tools stay internal, pass trusted Session identity, and gate screenshots on user approval', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-tool-browser-'));
  const db = openDatabase(dir);
  try {
    db.exec(`
      INSERT INTO workspaces(id, name, path) VALUES ('workspace-1', 'Workspace', '/tmp/workspace');
      INSERT INTO sessions
        (id, name, type, workspace_id, executor, status, archived, hidden, native_session_id,
         conversation_usage_complete, created_at, updated_at)
      VALUES
        ('session-1', 'Browser', 'coding', 'workspace-1', 'codex', 'running', 0, 0,
         'native-1', 1, datetime('now'), datetime('now'));
      INSERT INTO turns(id, session_id, turn_number, status, created_at)
      VALUES ('turn-1', 'session-1', 1, 'running', datetime('now'));
    `);
    const messages: unknown[] = [];
    const broadcaster = {
      broadcast(message: unknown) { messages.push(message); },
      add() {}, remove() {}, send() {}, size: 0,
    } as unknown as WsBroadcaster;
    const approvals = new ApprovalManager(broadcaster);
    const calls: Array<{ method: GianToolMethod; actor: { callerId: string; sessionId: string | null } }> = [];
    const browser: BrowserToolClient = {
      async call(method, _params, browserActor) {
        calls.push({ method, actor: browserActor });
        if (method === 'browser.tabs') return { revision: 0, tabs: [] } as never;
        if (method === 'browser.screenshot') {
          return {
            tab_id: 'tab-1', mime_type: 'image/png', base64: 'cG5n', width: 10, height: 10,
          } as never;
        }
        throw new Error('unexpected method');
      },
    };
    const service = new GianToolService({
      db,
      tasks: new TaskManager(db),
      sessions: { setDeliveryLifecycle() {} } as never,
      approvals,
      broadcaster,
      browser,
    });
    const access = new GianToolAccessController(service, db);
    const internal = actor('internal_session');

    const tabs = await access.call(internal, {
      request_id: 'tabs-1', method: 'browser.tabs', params: {},
    });
    assert.equal(tabs.ok, true);
    assert.deepEqual(calls[0], {
      method: 'browser.tabs',
      actor: { callerId: 'internal-session:session-1', sessionId: 'session-1' },
    });

    const denied = await access.call(actor('external_controller'), {
      request_id: 'external-tabs', method: 'browser.tabs', params: {},
    });
    assert.equal(denied.error?.code, 'PERMISSION_DENIED');
    assert.equal(calls.length, 1);

    const pending = access.call(internal, {
      request_id: 'shot-1', method: 'browser.screenshot', params: { tab_id: 'tab-1' },
    });
    await new Promise(resolve => setImmediate(resolve));
    const approval = approvals.listPending()[0];
    assert.equal(approval?.category, 'browser_capture');
    assert.equal(approval?.payload?.['localOnly'], true);
    assert.equal(calls.length, 1, 'pixels are not requested before approval');
    approvals.resolve(approval!.id, 'allow_session', 'web');
    const screenshot = await pending;
    assert.equal(screenshot.ok, true);
    assert.equal(calls.at(-1)?.method, 'browser.screenshot');

    const approvedForSession = await access.call(internal, {
      request_id: 'shot-2', method: 'browser.screenshot', params: { tab_id: 'tab-1' },
    });
    assert.equal(approvedForSession.ok, true);
    assert.equal(approvals.listPending().length, 0);
    assert.equal(messages.some(message => (
      (message as { type?: string }).type === 'approval:created'
    )), true);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
