import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { UserAgent } from '@gian/shared';
import { ApprovalManager } from '../src/approval/index.js';
import type { AgentManager } from '../src/agents/manager.js';
import type { CreateSessionParams } from '../src/proxy/types.js';
import type { ProxyManager } from '../src/proxy/manager.js';
import { ProtocolV2Host } from '../src/proxy/protocol-v2-session-client.js';
import { QueueManager } from '../src/queue/index.js';
import { SessionManager, type SessionAgentResolver } from '../src/session/manager.js';
import { openDatabase } from '../src/storage/db.js';
import { TaskManager } from '../src/task/manager.js';
import { GianToolService } from '../src/tool/service.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';

// Real Tool -> SessionManager -> Host validator -> compiled DSH Proxy stdio.
// Only the native bridge fixture is fake; no Provider CLI, account or model.
test('session.send completes twice in one DSH Session after authenticated reattach', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-dsh-tool-'));
  const db = openDatabase(dir);
  const agent: UserAgent = { id: 'test-dsh', name: 'Test DSH', pluginId: 'ai.deepseek.harness', proxy: 'dsh', cliPath: null, defaults: { model: '', thinking: '', mode: '' } };
  const logs: string[] = [];
  const host = new ProtocolV2Host({
    entry: fileURLToPath(new URL('../../proxies/dsh-proxy/dist/src/cli/spawn.js', import.meta.url)),
    pluginId: agent.pluginId!, pluginVersion: '0.1.7', processScope: 'shared', executor: 'dsh',
    dataDir: dir, hostVersion: '0.5.5', protocolVersions: ['2.1'],
    env: {
      GIAN_DSH_HOST_ENTRY: process.execPath,
      GIAN_DSH_HOST_ARGS: JSON.stringify([fileURLToPath(new URL('../../proxies/dsh-proxy/test/fixtures/fake-dsh-bridge.mjs', import.meta.url))]),
      DSH_FAKE_SCRIPT: 'success-no-claim',
    }, log: value => logs.push(value),
  });
  const clients = new Map<string, ReturnType<ProtocolV2Host['createSessionClient']>>();
  const attachments = new Map<string, CreateSessionParams>();
  const proxy = {
    async getOrCreate(id: string) {
      if (clients.has(id)) return clients.get(id)!;
      const client = host.createSessionClient(id);
      const create = client.createSession.bind(client);
      client.createSession = params => { attachments.set(id, params); return create(params); };
      clients.set(id, client);
      return client;
    },
    get(id: string) { return clients.get(id); },
    async dispose() {}, async forceDispose() {}, async closeAll() { await host.shutdown(); },
  } as unknown as ProxyManager;
  const broadcaster = { broadcast() {}, send() {}, add() {}, remove() {}, size: 0 } as unknown as WsBroadcaster;
  const approvals = new ApprovalManager(broadcaster);
  const resolver: SessionAgentResolver = {
    cliPathForKind: () => null, cliPathForSession: () => null, requireCliPathForSession: () => null,
    agentRuntime: () => ({ agent, cliPath: null }), agentRuntimeProfile: async () => null,
    agentsForKind: () => [agent],
  };
  const sessions = new SessionManager(db, proxy, broadcaster, approvals, new QueueManager(db), dir, null, undefined, undefined, resolver);
  const agents = {
    listAgents: () => [agent], getAgent: () => agent,
    agentStatus: async () => ({ ...agent, ready: true, proxyName: agent.name, cli: { state: 'ready' }, plugin: { state: 'ready', defaults: { model: '', thinking: '', mode: '' } } }),
    agentRuntimePath: () => ({ proxy: 'dsh', cliPath: null }),
  } as unknown as AgentManager;
  const tool = new GianToolService({ db, sessions, tasks: new TaskManager(db), approvals, broadcaster, agents });
  t.after(async () => { tool.close(); await host.shutdown(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const workspaceId = randomUUID();
  db.prepare('INSERT INTO workspaces(id,name,path) VALUES(?,?,?)').run(workspaceId, 'fixture', dir);
  const call = (method: string, params: Record<string, unknown>, key?: string) => tool.call({
    request_id: randomUUID(), caller_id: 'test', method, params, ...(key ? { idempotency_key: key } : {}),
  });
  const created = await call('session.create', { workspace_id: workspaceId, agent_id: agent.id }, 'create');
  assert.equal(created.ok, true, JSON.stringify(created));
  const sessionId = (created.data as { session: { id: string } }).session.id;
  for (const text of ['first', 'follow up']) {
    const sent = await call('session.send', { session_id: sessionId, text }, text);
    assert.equal(sent.ok, true, JSON.stringify(sent));
    const waited = await call('session.wait', { session_id: sessionId, delivery_id: (sent.data as { delivery_id: string }).delivery_id, timeout_ms: 5_000 });
    assert.equal(waited.ok, true, JSON.stringify(waited));
    const turn = db.prepare('SELECT status FROM turns WHERE session_id=? ORDER BY turn_number DESC LIMIT 1').get(sessionId) as { status: string };
    assert.equal(turn.status, 'completed', JSON.stringify(waited));
    await clients.get(sessionId)!.createSession({ ...attachments.get(sessionId)!, nativeSessionId: 'native-1', history: 'none' });
  }
  assert.deepEqual(db.prepare('SELECT status FROM turns WHERE session_id=? ORDER BY turn_number').all(sessionId), [{ status: 'completed' }, { status: 'completed' }]);
  assert.equal((db.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n, 1);
  assert.equal(logs.some(line => /PROTOCOL_VIOLATION|CONFLICT/.test(line)), false, logs.join('\n'));
});
