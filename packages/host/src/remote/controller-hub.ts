import {
  RemoteProtocolError, canonicalJson, catalogReadResultSchema, executionSessionSchema,
  executionSyncResultSchema, generateCanonicalId, generateUuidV7, parseClosed,
  type AccountLoginStarted, type ExecutionSession, type CommandStatusResult,
  type RemoteInteraction, type RemoteMethod, type RemoteTranscriptItem,
  type ExecutionHistoryEntry,
  remoteAgentCatalogSchema,
  remoteFileRefSchema,
  commandStatusResultSchema,
  REMOTE_METHOD_RESULTS,
} from '@gian/remote-protocol';
import type { ClientToServerMessage, EventEnvelope, Session, RemoteSettingsSnapshot } from '@gian/shared';
import type { ComposerDocument, InputItem, MessageContextItem } from '@gian/shared';
import { basename } from 'node:path';
import { readBoundedFile, isLikelyBinary } from '../workspace/bounded-file.js';
import { assertLocalFilesBelongToSession } from '../session/input-items.js';
import { compileContextIntoInput, normalizeMessageContextItems, normalizeMessageComposerDocument } from '../session/context-items.js';
import { previewMimeForAttachment } from '../storage/attachments.js';
import { RemoteControllerContent } from './controller-content.js';
import type { Db } from '../storage/db.js';
import { SessionRepository } from '../session/repository.js';
import { compactHistoryEnvelopes, SessionHistoryStore, type EventHistoryPage } from '../session/history-store.js';
import type { WsBroadcaster } from '../web/ws-broadcast.js';
import type { RemoteIdentityMaterial } from './identity.js';
import { RemoteExecutionBindings } from './execution-bindings.js';
import { RemoteExecutionReplicas, localRemoteTurnId } from './execution-journal.js';
import { RemoteControllerClient, type RemoteControllerEnvironment } from './controller-client.js';
import { HttpRemoteServerAuthClient } from './server-client.js';
import { remoteStableUuid } from './projection.js';
import { DEFAULT_TRANSLATION_PREFERENCES } from '@gian/shared';
import { loadConfig } from '../storage/config.js';
import type { TranslationService } from '../translation/service.js';
import { remoteTranslationOrigin, translatedRemoteInput } from '../translation/remote.js';

export interface RemoteSessionCreate {
  environment_id: string;
  workspace_id: string;
  agent_id: string;
  task_id?: string;
  name?: string;
  model?: string | null;
  thinking_effort?: string | null;
  service_tier?: 'fast' | null;
  approval_mode?: string | null;
  session_config?: Record<string, import('@gian/shared').ConfigValue>;
  turn_config?: Record<string, import('@gian/shared').ConfigValue>;
}

export interface RemoteSessionInput {
  send_id?: string;
  /** Local receipt only; never forwarded to the executing Host. */
  translation_id?: string;
  text: string;
  items?: InputItem[];
  context_items?: MessageContextItem[];
  composer_document?: ComposerDocument;
}

export class RemoteControllerHub {
  readonly bindings: RemoteExecutionBindings;
  readonly replicas: RemoteExecutionReplicas;
  private readonly repository: SessionRepository;
  private readonly clients = new Map<string, RemoteControllerClient>();
  private readonly syncing = new Map<string, Promise<void>>();
  private readonly sending = new Map<string, { input: string; promise: Promise<void> }>();
  private readonly scheduled = new Map<string, { next: number; failures: number }>();
  private readonly availability = new Map<string, 'ready' | 'offline' | 'auth_required' | 'unavailable'>();
  private readonly pendingLogin = new Map<string, { client: HttpRemoteServerAuthClient; started: AccountLoginStarted }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private translations?: TranslationService;
  private onTurnCompleted?: (localId: string, turn: number) => void;

  setTranslationService(service: TranslationService, onTurnCompleted: (localId: string, turn: number) => void): void {
    this.translations = service;
    this.onTurnCompleted = onTurnCompleted;
  }

  constructor(private readonly db: Db, private readonly broadcaster: WsBroadcaster, private readonly identity: RemoteIdentityMaterial) {
    this.bindings = new RemoteExecutionBindings(db);
    this.replicas = new RemoteExecutionReplicas(db);
    this.repository = new SessionRepository(db);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.closed) return;
      const rows = this.db.prepare(`SELECT b.local_session_id FROM remote_execution_bindings b
        JOIN sessions s ON s.id = b.local_session_id WHERE s.archived = 0`).all() as Array<{ local_session_id: string }>;
      for (const row of rows) {
        const id = row.local_session_id;
        if (this.syncing.size >= 4) break;
        if (this.syncing.has(id) || (this.scheduled.get(id)?.next ?? 0) > Date.now()) continue;
        void this.sync(id).then(() => {
          if (this.closed) return;
          const active = this.replicas.snapshot(id)?.session.active_turn;
          this.scheduled.set(id, { failures: 0, next: Date.now() + (active ? 1000 : 15_000) });
        }).catch(() => {
          const failures = (this.scheduled.get(id)?.failures ?? 0) + 1;
          this.scheduled.set(id, { failures, next: Date.now() + Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)) });
        });
      }
    }, 1000);
    this.timer.unref();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const client of this.clients.values()) client.close();
    this.clients.clear(); this.pendingLogin.clear();
  }

  owns(sessionId: string): boolean { return this.bindings.get(sessionId) !== null; }

  status(sessionId: string) {
    const session = this.repository.get(sessionId);
    const environment = session.remote_execution?.environment_id;
    const status = this.availability.get(sessionId);
    return { status: status === 'ready' && !this.clients.get(environment ?? '')?.connected ? 'offline' : status ?? 'connecting' };
  }

  listEnvironments() {
    return (this.db.prepare('SELECT * FROM remote_controller_environments ORDER BY created_at').all() as RemoteControllerEnvironment[])
      .map(environment => ({ id: environment.id, name: environment.name, host_id: environment.host_id,
        server_origin: environment.server_origin, pending: environment.pairing_id !== null,
        connected: this.clients.get(environment.id)?.connected === true }));
  }

  async startLogin(origin: string): Promise<RemoteSettingsSnapshot['account']> {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin) throw new Error('invalid_url');
    const client = new HttpRemoteServerAuthClient(origin, this.identity);
    const saved = await client.existingAccount('controller');
    if (saved) {
      this.pendingLogin.delete(origin);
      return { status: 'authorized', server_url: origin, login: saved.accountLogin, expires_at: saved.expiresAt };
    }
    const started = await client.startAccountLogin('controller');
    this.pendingLogin.set(origin, { client, started });
    return { status: 'pending', server_url: origin, user_code: started.user_code,
      verification_uri: started.verification_uri, expires_at: started.expires_at, interval_seconds: started.interval_seconds };
  }

  async pollLogin(origin: string): Promise<RemoteSettingsSnapshot['account']> {
    const pending = this.pendingLogin.get(origin);
    if (!pending) throw new Error('authorization_not_started');
    const result = await pending.client.pollAccountLogin(pending.started);
    if (result.status !== 'pending') this.pendingLogin.delete(origin);
    return { status: result.status, server_url: origin,
      expires_at: result.status === 'authorized' ? result.expires_at : pending.started.expires_at,
      ...(result.status === 'authorized' ? { login: result.account.login } : {}),
      ...(result.status === 'pending' ? { user_code: pending.started.user_code,
        verification_uri: pending.started.verification_uri, interval_seconds: result.interval_seconds } : {}) };
  }

  async pair(input: { origin: string; code: string; name: string }) {
    const environment = await RemoteControllerClient.pair(input, this.identity);
    const old = this.db.prepare('SELECT * FROM remote_controller_environments WHERE server_origin = ? AND host_id = ?')
      .get(environment.server_origin, environment.host_id) as RemoteControllerEnvironment | undefined;
    if (old) {
      if (old.server_identity_fingerprint !== environment.server_identity_fingerprint) {
        throw new RemoteProtocolError('AUTH_REQUIRED', 'Server identity changed; existing execution bindings cannot be replaced');
      }
      environment.id = old.id;
      environment.host_public_key_json = old.host_public_key_json;
      this.clients.get(old.id)?.close(); this.clients.delete(old.id);
    }
    this.db.prepare(`INSERT INTO remote_controller_environments
      (id, name, server_origin, server_identity_fingerprint, host_id, browser_id, device_id,
        crypto_connection_id, host_public_key_json, pairing_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, browser_id = excluded.browser_id, device_id = excluded.device_id,
        crypto_connection_id = excluded.crypto_connection_id, host_public_key_json = excluded.host_public_key_json,
        pairing_id = excluded.pairing_id`)
      .run(environment.id, environment.name, environment.server_origin, environment.server_identity_fingerprint,
        environment.host_id, environment.browser_id, environment.device_id, environment.crypto_connection_id,
        environment.host_public_key_json, environment.pairing_id, environment.created_at);
    return this.listEnvironments().find(item => item.id === environment.id)!;
  }

  removeEnvironment(environmentId: string): void {
    this.clients.get(environmentId)?.close();
    this.clients.delete(environmentId);
    this.availability.delete(environmentId);
    this.db.prepare('DELETE FROM remote_controller_environments WHERE id = ?').run(environmentId);
  }

  async catalog(environmentId: string) {
    return parseClosed(catalogReadResultSchema, await this.client(environmentId).request('catalog.read', {}));
  }

  async listExecutions(environmentId: string, after?: string): Promise<{ sessions: ExecutionSession[]; has_more: boolean }> {
    return await this.client(environmentId).request('execution.list', { ...(after ? { after } : {}) }) as { sessions: ExecutionSession[]; has_more: boolean };
  }

  async agentCatalog(environmentId: string, agentId: string, input?: {
    catalogRevision: string; sessionConfig: Record<string, import('@gian/shared').ConfigValue>;
    turnConfig: Record<string, import('@gian/shared').ConfigValue>;
  }) {
    return parseClosed(remoteAgentCatalogSchema, await this.client(environmentId).request('catalog.agent', {
      agent_id: agentId, ...(input ? { catalog_revision: input.catalogRevision,
        session_config: input.sessionConfig, turn_config: input.turnConfig } : {}),
    }));
  }

  async create(input: RemoteSessionCreate, requestId: string): Promise<Session> {
    if (input.task_id && !this.db.prepare("SELECT 1 FROM tasks WHERE id = ? AND status = 'open'").get(input.task_id)) throw new Error('local Task is not open');
    const client = this.client(input.environment_id);
    const catalog = await this.catalog(input.environment_id);
    const repo = catalog.workspaces.find(item => item.id === input.workspace_id);
    const agentId = input.agent_id.startsWith(`remote:${input.environment_id}:`)
      ? input.agent_id.slice(`remote:${input.environment_id}:`.length) : input.agent_id;
    const agent = catalog.agents.find(item => item.id === agentId);
    if (!repo || !agent || agent.readiness !== 'ready') throw new Error('remote repository or Agent unavailable');
    const serialized = canonicalJson(input);
    const existing = this.db.prepare('SELECT * FROM remote_execution_create_requests WHERE request_id = ?')
      .get(requestId) as { command_id: string; input_json: string; result_json: string | null;
        params_json: string | null; browser_id: string; repository_name: string } | undefined;
    if (existing && existing.input_json !== serialized) throw new Error('creation request changed');
    if (existing && !existing.result_json && existing.browser_id !== client.environment.browser_id) {
      throw new RemoteProtocolError('UNKNOWN_OUTCOME', 'pairing changed; recover the existing remote execution before retrying');
    }
    const commandId = existing?.command_id ?? generateUuidV7();
    if (!existing) this.db.prepare(`INSERT INTO remote_execution_create_requests
      (request_id, environment_id, command_id, input_json, browser_id, repository_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(requestId, input.environment_id, commandId, serialized, client.environment.browser_id, repo.name, Date.now());
    const remote = existing?.result_json ? parseClosed(executionSessionSchema, JSON.parse(existing.result_json))
      : parseClosed(executionSessionSchema, await client.request('execution.create', this.freezeCreateParams(requestId, {
        catalog_revision: catalog.catalog_revision, workspace_id: repo.id, agent_id: agent.id,
        ...(input.name ? { name: input.name } : {}), ...(input.model ? { model: input.model } : {}),
        ...(input.thinking_effort ? { thinking: input.thinking_effort } : {}),
        ...(input.service_tier ? { service_tier: input.service_tier } : {}),
        ...(input.approval_mode ? { approval_mode: input.approval_mode } : {}),
        ...(input.session_config ? { session_config: input.session_config } : {}),
        ...(input.turn_config ? { turn_config: input.turn_config } : {}),
      }), commandId));
    this.db.prepare('UPDATE remote_execution_create_requests SET result_json = ? WHERE request_id = ?').run(JSON.stringify(remote), requestId);
    return this.importSession(input.environment_id, remote, repo.name, input.task_id);
  }

  private freezeCreateParams(requestId: string, params: Record<string, unknown>): Record<string, unknown> {
    this.db.prepare('UPDATE remote_execution_create_requests SET params_json = COALESCE(params_json, ?) WHERE request_id = ?')
      .run(canonicalJson(params), requestId);
    const row = this.db.prepare('SELECT params_json FROM remote_execution_create_requests WHERE request_id = ?')
      .get(requestId) as { params_json: string };
    return JSON.parse(row.params_json) as Record<string, unknown>;
  }

  async takeOver(environmentId: string, remoteSessionId: string, taskId?: string): Promise<Session> {
    const snapshot = parseClosed(executionSyncResultSchema,
      await this.client(environmentId).request('execution.sync', { session_id: remoteSessionId, after: 0 }));
    const catalog = await this.catalog(environmentId);
    const repoName = catalog.workspaces.find(item => item.id === snapshot.session.workspace_id)?.name ?? '';
    return this.importSession(environmentId, snapshot.session, repoName, taskId);
  }

  private async importSession(environmentId: string, remote: ExecutionSession, repositoryName: string, taskId?: string): Promise<Session> {
    const environment = this.client(environmentId).environment;
    const account = await this.identity.getAccountSession?.(environment.server_origin, 'controller');
    if (!account) throw new RemoteProtocolError('AUTH_REQUIRED', 'account required');
    const target = { server_origin: environment.server_origin, server_identity_fingerprint: environment.server_identity_fingerprint,
      account_id: account.accountId, host_id: environment.host_id, remote_session_id: remote.id };
    let bound = this.bindings.find(target);
    if (!bound) {
      if (taskId && !this.db.prepare("SELECT 1 FROM tasks WHERE id = ? AND status = 'open'").get(taskId)) throw new Error('local Task is not open');
      const localId = generateCanonicalId();
      bound = this.db.transaction(() => {
        this.db.prepare(`INSERT INTO sessions
          (id, name, type, task_id, workspace_id, executor, native_session_id, agent_id, agent_name,
            proxy_plugin_id, remote_environment_id, remote_repository_id, remote_repository_name)
          VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(localId, remote.name, taskId ? 'subtask' : 'coding', taskId ?? null, remote.agent.proxy,
            generateCanonicalId(), `remote:${environmentId}:${remote.agent.id}`, remote.agent.name, remote.agent.proxy,
            environmentId, remote.workspace_id, repositoryName);
        return this.bindings.bind({ local_session_id: localId, target });
      })();
    }
    await this.sync(bound.local_session_id);
    return this.repository.get(bound.local_session_id);
  }

  sync(localSessionId: string): Promise<void> {
    const current = this.syncing.get(localSessionId);
    if (current) return current;
    const run = this.syncOnce(localSessionId).then(() => { this.availability.set(localSessionId, 'ready'); }).catch(error => {
      const code = error instanceof RemoteProtocolError ? error.code : '';
      this.availability.set(localSessionId, code === 'AUTH_REQUIRED' ? 'auth_required'
        : code === 'REMOTE_CAPABILITY_DENIED' || code === 'RESOURCE_NOT_FOUND' ? 'unavailable' : 'offline');
      throw error;
    }).finally(() => this.syncing.delete(localSessionId));
    this.syncing.set(localSessionId, run);
    return run;
  }

  private async syncOnce(localId: string): Promise<void> {
    if (this.closed) return;
    const binding = this.bindings.get(localId);
    if (!binding) return;
    const session = this.repository.get(localId);
    const client = this.client(session.remote_execution!.environment_id);
    const credential = await this.identity.getAccountSession?.(binding.target.server_origin, 'controller');
    if (!credential || credential.accountId !== binding.target.account_id) throw new RemoteProtocolError('AUTH_REQUIRED', 'account changed');
    for (let page = 0; page < 16; page += 1) {
      const previous = this.replicas.snapshot(localId);
      const data = await client.request('execution.sync', { session_id: binding.target.remote_session_id,
        after: previous?.cursor ?? 0, ...(previous ? { stream_id: previous.stream_id } : {}) });
      if (this.closed) return;
      const next = this.replicas.apply(binding, data);
      await this.reconcileTranslationReceipts(localId, client, binding.revision);
      this.linkToolDeliveries(localId);
      const remote = next.session;
      this.db.prepare('UPDATE sessions SET remote_worktree_root = ? WHERE id = ?').run(remote.worktree_root, localId);
      this.db.prepare('UPDATE sessions SET executor_config_json = ?, turn_config_json = ?, turn_config_options_json = ? WHERE id = ?')
        .run(JSON.stringify({ schemaVersion: 1, values: remote.session_config }), JSON.stringify(remote.turn_config),
          remote.turn_config_options ? JSON.stringify(remote.turn_config_options) : null, localId);
      this.db.prepare(`UPDATE sessions SET status = ?, model = ?, thinking_effort = ?, service_tier = ?, approval_mode = ?,
        context_tokens_used = ?, context_window_tokens = ?, context_usage_updated_at = ?,
        conversation_input_tokens = ?, conversation_output_tokens = ?, conversation_cached_input_tokens = ?,
        conversation_total_tokens = ?, conversation_usage_complete = ?, updated_at = ?, name = COALESCE(name, ?)
        WHERE id = ?`)
        .run(remote.status, remote.model ?? null, remote.thinking ?? null, remote.service_tier ?? null, remote.approval_mode ?? null,
          remote.context_tokens_used, remote.context_window_tokens, remote.context_usage_updated_at,
          remote.conversation_input_tokens, remote.conversation_output_tokens, remote.conversation_cached_input_tokens,
          remote.conversation_total_tokens, remote.conversation_usage_complete ? 1 : 0, remote.updated_at, remote.name, localId);
      for (const event of next.events) {
        if (event.sequence <= (previous?.cursor ?? 0)) continue;
        this.broadcaster.broadcast({ type: 'event', ...this.historyEvent(localId, event) });
        if (previous && 'item' in event && event.item.kind === 'turn-end' && event.item.outcome === 'worked'
          && this.translations?.shouldReadRemoteEvent(localId, event.sequence)) {
          this.onTurnCompleted?.(localId, event.item.turn);
        }
      }
      for (const interaction of next.interactions) {
        if (previous?.interactions.some(item => item.id === interaction.id && item.revision === interaction.revision)) continue;
        this.broadcaster.broadcast({ type: 'event', ...remoteInteractionEvent(localId, interaction, remote.active_turn?.turn_number ?? 0) });
      }
      if (!previous || canonicalJson(previous.session) !== canonicalJson(remote) || next.events.length) {
        this.broadcaster.broadcast({ type: 'session:updated', session: this.repository.get(localId) });
        this.broadcaster.broadcast({ type: 'queue:updated', session_id: localId,
          queue_revision: remote.queue.revision, queue: this.queue(localId) });
      }
      if (!next.has_more) break;
    }
  }

  async command(localId: string, method: RemoteMethod, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'queue.update') return this.updateTranslatedQueue(localId, params);
    const binding = this.bindings.get(localId);
    if (!binding) throw new Error('remote binding missing');
    const session = this.repository.get(localId);
    const beforeQueue = method === 'queue.clear' ? this.queue(localId).map(entry => entry.id) : [];
    const credential = await this.identity.getAccountSession?.(binding.target.server_origin, 'controller');
    if (!credential || credential.accountId !== binding.target.account_id) throw new RemoteProtocolError('AUTH_REQUIRED', 'account changed');
    if (method === 'session.send') this.bindings.markStarted(localId, binding.revision);
    const result = await this.client(session.remote_execution!.environment_id).request(method,
      { ...params, ...(method === 'interaction.respond' ? {} : { session_id: binding.target.remote_session_id }) });
    this.bindings.assertCurrent(binding);
    if (!['file.resolve', 'file.tree', 'file.list', 'git.read', 'file.preview', 'command.status'].includes(method)) await this.sync(localId);
    const removed = method === 'queue.remove' ? [String(params.queue_id)] : method === 'queue.clear' ? beforeQueue : [];
    for (const id of removed) this.db.prepare(`UPDATE tool_deliveries SET state = 'cancelled', queue_entry_id = NULL, updated_at = ?
      WHERE session_id = ? AND queue_entry_id = ? AND state IN ('pending', 'queued')`).run(new Date().toISOString(), localId, id);
    if (method === 'queue.send_now') {
      const affected = (result as { affected?: Array<{ queue_id: string; turn_number: number; state: string }> }).affected ?? [];
      for (const item of affected) {
        const turnId = localRemoteTurnId(localId, item.turn_number);
        if (!this.db.prepare('SELECT 1 FROM turns WHERE id = ?').get(turnId)) continue;
        this.db.prepare(`UPDATE tool_deliveries SET state = ?, queue_entry_id = NULL, turn_id = ?, updated_at = ?
          WHERE session_id = ? AND queue_entry_id = ? AND state IN ('pending', 'queued')`)
          .run(item.state, turnId, new Date().toISOString(), localId, item.queue_id);
      }
    }
    return result;
  }

  async handleMessage(msg: ClientToServerMessage): Promise<boolean> {
    if (!('session_id' in msg) || typeof msg.session_id !== 'string' || !this.owns(msg.session_id)) return false;
    const localId = msg.session_id;
    if (msg.type === 'events:subscribe') { await this.sync(localId); return true; }
    const snapshot = this.replicas.snapshot(localId);
    if (!snapshot) throw new Error('remote state not loaded');
    switch (msg.type) {
      case 'message:send':
      case 'queue:add':
        await this.send(localId, msg, 'queue'); return true;
      case 'message:steer':
        await this.send(localId, msg, 'steer'); return true;
      case 'session:stop':
        if (this.translations?.cancelSession(localId) && !snapshot.session.active_turn) return true;
        await this.command(localId, 'session.stop', { session_revision: snapshot.session.revision }); return true;
      case 'session:set_model':
        await this.command(localId, 'session.update', { session_revision: snapshot.session.revision, model: msg.model }); return true;
      case 'session:set_effort':
        await this.command(localId, 'session.update', { session_revision: snapshot.session.revision, thinking: msg.effort }); return true;
      case 'session:set_service_tier':
        await this.command(localId, 'session.update', { session_revision: snapshot.session.revision, service_tier: msg.service_tier ?? 'standard' }); return true;
      case 'session:set_mode':
        await this.command(localId, 'session.update', { session_revision: snapshot.session.revision, approval_mode: msg.approval_mode }); return true;
      case 'session:set_native_config':
        await this.command(localId, 'execution.configure', { session_revision: snapshot.session.revision,
          binding: 'session', option_id: msg.config_id, value: msg.value }); return true;
      case 'session:set_turn_config':
        await this.command(localId, 'execution.configure', { session_revision: snapshot.session.revision,
          binding: 'turn', option_id: msg.option_id, value: msg.value }); return true;
      case 'queue:clear':
        await this.command(localId, 'queue.clear', { expected_queue_revision: snapshot.session.queue.revision }); return true;
      case 'queue:send_now':
        await this.command(localId, 'queue.send_now', { expected_queue_revision: snapshot.session.queue.revision }); return true;
      case 'queue:remove':
        await this.command(localId, 'queue.remove', { queue_id: msg.queue_id, expected_queue_revision: snapshot.session.queue.revision }); return true;
      case 'queue:update':
        await this.command(localId, 'queue.update', { queue_id: msg.queue_id, text: msg.text, expected_queue_revision: snapshot.session.queue.revision }); return true;
      case 'approval:resolve': {
        const interaction = snapshot.interactions.find(item => localInteractionId(localId, item.id) === msg.approval_id);
        if (!interaction || !msg.native_option_id || !interaction.presentation.actions.some(item => item.id === msg.native_option_id)) throw new Error('remote interaction changed');
        await this.command(localId, 'interaction.respond', { interaction_id: interaction.id,
          interaction_revision: interaction.revision, action_id: msg.native_option_id, ...(msg.answers ? { values: msg.answers } : {}) });
        return true;
      }
      default:
        if (['session:rename', 'session:archive', 'session:pin', 'session:set_unread', 'session:assign_task', 'session:delete'].includes(msg.type)) return false;
        throw new RemoteProtocolError('REMOTE_CAPABILITY_DENIED', 'remote operation is not supported');
    }
  }

  queue(localId: string): import('../queue/manager.js').QueueEntry[] {
    return (this.replicas.snapshot(localId)?.session.queue.entries ?? []).map(entry => {
      const request = this.db.prepare(`SELECT r.request_id FROM remote_execution_send_requests r
        JOIN tool_requests t ON t.id = r.request_id WHERE r.local_session_id = ? AND json_extract(r.result_json, '$.queue_id') = ?`)
        .get(localId, entry.id) as { request_id: string } | undefined;
      const origin = this.translations ? remoteTranslationOrigin(this.db, this.translations, localId,
        { text: entry.text, queueId: entry.id }) : undefined;
      return { id: entry.id, sessionId: localId, text: origin?.translation.sourceText ?? entry.text, createdAt: Date.parse(entry.created_at),
        ...(request ? { toolRequestId: request.request_id } : {}) };
    });
  }

  private linkToolDeliveries(localId: string): void {
    const links = this.db.prepare(`SELECT r.request_id, h.item_json FROM remote_execution_send_requests r
      JOIN tool_deliveries d ON d.request_id = r.request_id AND d.turn_id IS NULL
      JOIN remote_execution_replica_events h ON h.local_session_id = r.local_session_id
        AND json_extract(h.item_json, '$.item.delivery_id') = json_extract(r.result_json, '$.delivery_id')
      WHERE r.local_session_id = ?`).all(localId) as Array<{ request_id: string; item_json: string }>;
    for (const row of links) {
      const entry = JSON.parse(row.item_json) as ExecutionHistoryEntry;
      if (!('item' in entry) || entry.item.kind !== 'user') continue;
      this.db.prepare('UPDATE turns SET tool_request_id = ? WHERE id = ? AND tool_request_id IS NULL')
        .run(row.request_id, localRemoteTurnId(localId, entry.item.turn));
    }
  }

  async sendForTool(localId: string, input: RemoteSessionInput, requestId: string,
    busy: 'queue' | 'steer' | 'fail' = 'queue') {
    await this.send(localId, { ...input, request_id: requestId }, busy);
    const row = this.db.prepare('SELECT result_json FROM remote_execution_send_requests WHERE request_id = ?')
      .get(requestId) as { result_json: string };
    const result = JSON.parse(row.result_json) as { delivery_id?: string; delivery_state?: string; queue_id?: string;
      turn_number?: number; session: { active_turn?: { turn_number: number } } };
    const number = result.delivery_state === 'queued' ? undefined : result.turn_number ?? result.session.active_turn?.turn_number;
    if (number && result.delivery_state !== 'queued') this.db.prepare(`UPDATE turns SET tool_request_id = ?
      WHERE id = ? AND tool_request_id IS NULL AND EXISTS (SELECT 1 FROM tool_requests WHERE id = ?)`)
      .run(requestId, localRemoteTurnId(localId, number), requestId);
    return { state: result.delivery_state ?? 'unknown', queueId: result.queue_id,
      turnId: number ? localRemoteTurnId(localId, number) : undefined, turnNumber: number };
  }

  private send(localId: string, input: RemoteSessionInput & { request_id?: string }, busy: 'queue' | 'steer' | 'fail'): Promise<void> {
    if (input.send_id !== undefined && (typeof input.send_id !== 'string' || !input.send_id || input.send_id.length > 128)) {
      return Promise.reject(new Error('Invalid local send identity.'));
    }
    const requestId = input.send_id ?? input.request_id ?? generateCanonicalId();
    const { request_id: _correlation, ...submission } = input;
    const serialized = canonicalJson({ localId, input: input.send_id ? submission : input, busy });
    const pending = this.sending.get(requestId);
    if (pending) return pending.input === serialized ? pending.promise : Promise.reject(new Error('send request changed'));
    const promise = this.sendOnce(localId, requestId, serialized, input, busy).finally(() => this.sending.delete(requestId));
    this.sending.set(requestId, { input: serialized, promise });
    return promise;
  }

  private async sendOnce(localId: string, requestId: string, serialized: string, input: RemoteSessionInput,
    busy: 'queue' | 'steer' | 'fail'): Promise<void> {
    const binding = this.bindings.get(localId)!;
    const session = this.repository.get(localId);
    const client = this.client(session.remote_execution!.environment_id);
    const account = await this.identity.getAccountSession?.(binding.target.server_origin, 'controller');
    if (account?.accountId !== binding.target.account_id) throw new RemoteProtocolError('AUTH_REQUIRED', 'account changed');
    const existing = this.db.prepare('SELECT * FROM remote_execution_send_requests WHERE request_id = ?').get(requestId) as {
      local_session_id: string; binding_revision: number; browser_id: string; command_id: string;
      input_json: string; params_json: string; result_json: string | null; method: string;
    } | undefined;
    if (existing && (existing.method !== 'session.send' || existing.input_json !== serialized || existing.local_session_id !== localId
      || existing.binding_revision !== binding.revision)) throw new RemoteProtocolError('PRECONDITION_FAILED', 'send request changed');
    if (existing?.result_json) { await this.sync(localId); this.broadcastTranslatedHistory(localId); return; }
    if (existing && existing.browser_id !== client.environment.browser_id) {
      throw new RemoteProtocolError('UNKNOWN_OUTCOME', 'pairing changed; reconcile execution history before sending again');
    }
    const commandId = existing?.command_id ?? generateUuidV7();
    if (!existing && input.translation_id !== 'original' && !this.translations && (input.translation_id
      || (this.db.prepare('SELECT enabled FROM session_translation_preferences WHERE session_id = ?')
        .get(localId) as { enabled: number } | undefined)?.enabled === 1)) {
      throw new Error('Local translation service is unavailable.');
    }
    const translation = !existing ? await this.translations?.prepareSend(localId,
      { text: input.text, document: input.composer_document, translationId: input.translation_id },
      loadConfig(this.db).translation ?? { ...DEFAULT_TRANSLATION_PREFERENCES }, requestId) : undefined;
    const params = existing ? JSON.parse(existing.params_json) as Record<string, unknown>
      : { ...await this.prepareSend(localId, translation ? translatedRemoteInput(input, translation) : input), session_id: binding.target.remote_session_id, busy };
    this.bindings.assertCurrent(binding);
    if (!existing) this.db.prepare(`INSERT INTO remote_execution_send_requests
      (request_id, local_session_id, binding_revision, browser_id, command_id, input_json, params_json, translation_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(requestId, localId, binding.revision, client.environment.browser_id,
        commandId, serialized, canonicalJson(params), translation?.id ?? null, Date.now());
    this.bindings.markStarted(localId, binding.revision);
    const result = await client.request('session.send', params, commandId);
    this.bindings.assertCurrent(binding);
    this.db.prepare('UPDATE remote_execution_send_requests SET result_json = ? WHERE request_id = ?')
      .run(JSON.stringify(result), requestId);
    this.linkToolDeliveries(localId);
    await this.sync(localId);
    this.broadcastTranslatedHistory(localId);
  }

  private async reconcileTranslationReceipts(localId: string, client: RemoteControllerClient, revision: number): Promise<void> {
    const rows = this.db.prepare(`SELECT request_id, command_id, method FROM remote_execution_send_requests
      WHERE local_session_id = ? AND binding_revision = ? AND browser_id = ?
      AND translation_id IS NOT NULL AND result_json IS NULL LIMIT 8`)
      .all(localId, revision, client.environment.browser_id) as Array<{ request_id: string; command_id: string; method: string }>;
    let changed = false;
    for (const row of rows) {
      // Query-only recovery: never resubmit a command or infer delivery from text.
      let status: CommandStatusResult;
      try {
        status = parseClosed(commandStatusResultSchema,
          await client.request('command.status', { command_id: row.command_id }));
      } catch { continue; }
      if (status.command_id !== row.command_id || status.state !== 'succeeded' || status.result === undefined
        || this.bindings.get(localId)?.revision !== revision || this.closed) continue;
      let result: unknown;
      try {
        if (row.method === 'queue.update') result = parseClosed(REMOTE_METHOD_RESULTS['queue.update'], status.result);
        else if (row.method === 'session.send') {
          const receipt = parseClosed(REMOTE_METHOD_RESULTS['session.send'], status.result);
          if (receipt.session.id !== this.bindings.get(localId)?.target.remote_session_id) continue;
          result = receipt;
        } else continue;
      } catch { continue; }
      this.db.prepare('UPDATE remote_execution_send_requests SET result_json = ? WHERE request_id = ? AND result_json IS NULL')
        .run(JSON.stringify(result), row.request_id);
      changed = true;
    }
    if (changed) this.broadcastTranslatedHistory(localId);
  }

  private async updateTranslatedQueue(localId: string, input: Record<string, unknown>): Promise<unknown> {
    if (typeof input.text !== 'string' || typeof input.queue_id !== 'string' || typeof input.expected_queue_revision !== 'string') {
      throw new Error('Invalid queue update.');
    }
    const binding = this.bindings.get(localId);
    if (!binding) throw new Error('remote binding missing');
    const session = this.repository.get(localId);
    const client = this.client(session.remote_execution!.environment_id);
    const account = await this.identity.getAccountSession?.(binding.target.server_origin, 'controller');
    if (account?.accountId !== binding.target.account_id) throw new RemoteProtocolError('AUTH_REQUIRED', 'account changed');
    const serialized = canonicalJson({ localId, input: { text: input.text }, queueId: input.queue_id, revision: input.expected_queue_revision });
    const requestId = remoteStableUuid('translated-queue-edit', serialized);
    const existing = this.db.prepare('SELECT * FROM remote_execution_send_requests WHERE request_id = ?')
      .get(requestId) as { method: string; input_json: string; params_json: string; result_json: string | null;
        command_id: string; binding_revision: number; browser_id: string } | undefined;
    if (existing && (existing.method !== 'queue.update' || existing.input_json !== serialized || existing.binding_revision !== binding.revision
      || existing.browser_id !== client.environment.browser_id)) throw new RemoteProtocolError('UNKNOWN_OUTCOME', 'queue update binding changed');
    if (existing?.result_json) { await this.sync(localId); return JSON.parse(existing.result_json); }
    if (!existing && !this.translations && (this.db.prepare('SELECT enabled FROM session_translation_preferences WHERE session_id = ?')
      .get(localId) as { enabled: number } | undefined)?.enabled === 1) throw new Error('Local translation service is unavailable.');
    const translation = !existing ? await this.translations?.prepareSend(localId, { text: input.text },
      loadConfig(this.db).translation ?? { ...DEFAULT_TRANSLATION_PREFERENCES }, requestId) : undefined;
    const params = existing ? JSON.parse(existing.params_json) as Record<string, unknown> : {
      session_id: binding.target.remote_session_id, queue_id: input.queue_id,
      expected_queue_revision: input.expected_queue_revision,
      text: translation ? translatedRemoteInput({ text: input.text }, translation).text : input.text,
    };
    const commandId = existing?.command_id ?? generateUuidV7();
    this.bindings.assertCurrent(binding);
    if (!existing) this.db.prepare(`INSERT INTO remote_execution_send_requests
      (request_id, local_session_id, binding_revision, browser_id, command_id, input_json, params_json, translation_id, method, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queue.update', ?)`).run(requestId, localId, binding.revision, client.environment.browser_id,
        commandId, serialized, canonicalJson(params), translation?.id ?? null, Date.now());
    const result = await client.request('queue.update', params, commandId);
    this.bindings.assertCurrent(binding);
    this.db.prepare('UPDATE remote_execution_send_requests SET result_json = ? WHERE request_id = ?').run(JSON.stringify(result), requestId);
    await this.sync(localId);
    this.broadcastTranslatedHistory(localId);
    return result;
  }

  private broadcastTranslatedHistory(localId: string): void {
    for (const entry of this.replicas.items(localId)) {
      if (!('item' in entry) || entry.item.kind !== 'user') continue;
      const event = this.historyEvent(localId, entry);
      if (event.data.translation) this.broadcaster.broadcast({ type: 'event', ...event });
    }
  }

  historyEvent(localId: string, entry: ExecutionHistoryEntry): EventEnvelope {
    const event = remoteHistoryEvent(localId, entry);
    if (!this.translations || !('item' in entry) || entry.item.kind !== 'user') return event;
    const origin = remoteTranslationOrigin(this.db, this.translations, localId,
      { text: entry.item.text, deliveryId: entry.item.delivery_id });
    if (!origin) return event;
    return { ...event, data: { ...event.data, text: origin.translation.sourceText, translation: origin.translation,
      ...(origin.sendId ? { send_id: origin.sendId } : {}),
      ...(origin.document ? { composer_document: origin.document } : {}),
      ...(origin.contextItems ? { context_items: origin.contextItems } : {}) } };
  }

  historyEvents(localId: string): EventEnvelope[] {
    return this.replicas.items(localId).map(entry => this.historyEvent(localId, entry));
  }

  async resolveFile(localId: string, reference: string) {
    return parseClosed(remoteFileRefSchema, await this.command(localId, 'file.resolve', { reference }));
  }

  async readFile(localId: string, reference: string) {
    const file = await this.resolveFile(localId, reference);
    const session = this.repository.get(localId);
    const content = await new RemoteControllerContent(this.client(session.remote_execution!.environment_id)).download(file.id);
    return { ...content, file };
  }

  async tree(localId: string, directory: string, after?: string) {
    return this.command(localId, 'file.tree', { directory, ...(after ? { after } : {}) });
  }

  async directory(localId: string, directory: string) {
    const entries: Array<{ name: string; reference: string; kind: 'directory' | 'file' }> = [];
    let after: string | undefined;
    do {
      const page = await this.tree(localId, directory, after) as { entries: typeof entries; has_more: boolean };
      entries.push(...page.entries);
      const next = page.has_more ? page.entries.at(-1)?.name : undefined;
      if (next && after && next <= after) throw new RemoteProtocolError('INVALID_FRAME', 'directory cursor did not advance');
      after = next;
    } while (after && entries.length < 20_000);
    return entries;
  }

  private async prepareSend(localId: string, input: RemoteSessionInput) {
    assertLocalFilesBelongToSession(localId, input.items);
    const session = this.repository.get(localId);
    const binding = this.bindings.get(localId)!;
    const content = new RemoteControllerContent(this.client(session.remote_execution!.environment_id));
    const contexts: MessageContextItem[] = [];
    if ((input.context_items?.length ?? 0) > 16) throw new Error('too many context items');
    for (const item of input.context_items ?? []) {
      if (item.type === 'file') {
        const read = await this.readFile(localId, item.path);
        const bytes = Buffer.from(read.bytes);
        const text = isLikelyBinary(bytes) ? item.name
          : item.name + '\n' + bytes.subarray(0, 60 * 1024).toString('utf8')
            + (bytes.length > 60 * 1024 ? '\n[truncated]' : '');
        contexts.push(pastedContext(item.id, text));
      } else if (item.type === 'folder') {
        await this.tree(localId, item.path);
        contexts.push(pastedContext(item.id, 'Remote worktree folder: ' + item.path));
      } else if (item.type === 'session') {
        const linked = this.repository.find(item.sessionId);
        const events = linked?.remote_execution ? this.replicas.items(item.sessionId).map(entry => remoteHistoryEvent(item.sessionId, entry))
          : new SessionHistoryStore(this.db).listEvents(item.sessionId);
        const text = events.flatMap(event => event.event === 'user_message' && typeof event.data.text === 'string'
          ? ['User: ' + event.data.text] : event.display?.type === 'message'
            ? ['Assistant: ' + String(event.display.data.text)] : []).join('\n\n');
        contexts.push(pastedContext(item.id, 'Session: ' + item.title + '\n' + text.slice(-48 * 1024)));
      } else contexts.push(item);
    }
    const normalized = normalizeMessageContextItems(contexts);
    const document = normalizeMessageComposerDocument(input.composer_document, input.items, normalized);
    if (!normalized.length && !document && (!input.items?.length
      || (input.items.length === 1 && input.items[0]?.type === 'text' && 'text' in input.items[0] && input.items[0].text === input.text))) {
      return { text: input.text };
    }
    const compiled = compileContextIntoInput(input.text, input.items, normalized, document);
    const items: Array<{ type: 'text'; text: string } | { type: 'attachment' | 'compiled_text'; attachment_id: string }> = [];
    for (const item of compiled) {
      if (item.type === 'text' && 'text' in item) {
        const text = String(item.text);
        if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('compiled context too large');
        if (text.length <= 16000) items.push({ type: 'text', text });
        else {
          const uploaded = await content.upload(binding.target.remote_session_id, 'context.txt', 'text/plain', new TextEncoder().encode(text));
          items.push({ type: 'compiled_text', attachment_id: uploaded.id });
        }
      } else if ((item.type === 'localFile' || item.type === 'localImage') && 'path' in item && typeof item.path === 'string') {
        const bytes = await readBoundedFile(item.path, 20 * 1024 * 1024);
        const uploaded = await content.upload(binding.target.remote_session_id, basename(item.path), previewMimeForAttachment(item.path), bytes);
        items.push({ type: 'attachment', attachment_id: uploaded.id });
      } else throw new RemoteProtocolError('REMOTE_CAPABILITY_DENIED', 'remote input type is not supported');
    }
    this.bindings.assertCurrent(binding);
    return { text: input.text, items };
  }

  historyPage(localId: string, before: number | null, count = 3): EventHistoryPage {
    const stored = this.historyEvents(localId);
    const turns = [...new Set(stored.map(item => item.turn))].filter(turn => before === null || turn < before).sort((a, b) => b - a);
    const selected = turns.slice(0, Math.max(1, Math.min(10, count)));
    const selectedSet = new Set(selected);
    const events = compactHistoryEnvelopes(stored.filter(item => selectedSet.has(item.turn)));
    if (before === null) {
      const snapshot = this.replicas.snapshot(localId);
      for (const interaction of snapshot?.interactions ?? []) events.push(remoteInteractionEvent(localId, interaction, snapshot?.session.active_turn?.turn_number ?? 0));
    }
    return { events, hasMore: turns.length > selected.length, nextCursor: turns.length > selected.length ? selected.at(-1)! : null };
  }

  client(environmentId: string): RemoteControllerClient {
    if (this.closed) throw new RemoteProtocolError('HOST_OFFLINE', 'controller is closed');
    const existing = this.clients.get(environmentId);
    if (existing) return existing;
    const environment = this.db.prepare('SELECT * FROM remote_controller_environments WHERE id = ?')
      .get(environmentId) as RemoteControllerEnvironment | undefined;
    if (!environment) throw new Error('remote environment not found');
    const client = new RemoteControllerClient(environment, this.identity, next => {
      this.db.prepare(`UPDATE remote_controller_environments SET device_id = ?, crypto_connection_id = ?,
        host_public_key_json = ?, pairing_id = ? WHERE id = ?`)
        .run(next.device_id, next.crypto_connection_id, next.host_public_key_json, next.pairing_id, next.id);
    });
    this.clients.set(environmentId, client);
    return client;
  }

  workingTrees() {
    return this.repository.list().flatMap(session => session.remote_execution ? [{
      id: 'remote:' + session.id, kind: 'worktree' as const,
      label: session.remote_execution.environment_name + ' / ' + session.remote_execution.repository_name,
      path: 'gian-remote://' + session.id, branch: null,
      workspace_id: 'remote:' + session.remote_execution.environment_id + ':' + session.remote_execution.repository_id,
      workspace_name: session.remote_execution.environment_name + ' / ' + session.remote_execution.repository_name,
      session_id: session.id, session_name: session.name,
    }] : []);
  }

  async files(localId: string): Promise<string[]> {
    const references: string[] = [];
    let after: string | undefined;
    do {
      const page = await this.command(localId, 'file.list', { ...(after ? { after } : {}) }) as { references: string[]; has_more: boolean };
      references.push(...page.references);
      after = page.has_more ? page.references.at(-1) : undefined;
    } while (after && references.length < 20_000);
    return references.slice(0, 20_000);
  }
}

function pastedContext(id: string, text: string): MessageContextItem {
  const bytes = Buffer.from(text);
  const bounded = bytes.length <= 64 * 1024 ? text : bytes.subarray(0, 60 * 1024).toString('utf8') + '\n[truncated]';
  return { type: 'pastedText', id, text: bounded, byteSize: Buffer.byteLength(bounded), lineCount: bounded.split('\n').length };
}

export function localInteractionId(localId: string, remoteId: string): string {
  return remoteStableUuid('remote-interaction', `${localId}:${remoteId}`);
}

function remoteInteractionEvent(localId: string, interaction: RemoteInteraction, turn: number): EventEnvelope {
  const p = interaction.presentation;
  return { session_id: localId, turn, call_id: localInteractionId(localId, interaction.id), event: 'remote.interaction',
    ts: Date.parse(interaction.created_at), data: {}, display: {
      type: interaction.kind === 'question' ? 'interaction.question' : 'interaction.approval',
      data: { approvalId: localInteractionId(localId, interaction.id),
        category: interaction.kind === 'question' ? 'question' : interaction.kind === 'exit_plan_mode' ? 'exit_plan_mode' : 'command',
        title: p.title, description: p.description, subject: p.subject, risk: p.risk, scopeOptions: ['once'],
        actions: p.actions.map(action => ({ id: action.id, label: action.label, style: action.tone === 'danger' ? 'danger' : 'secondary' })),
        inputs: p.inputs?.map(input => ({ id: input.id, type: input.type, label: input.label, required: false,
          choices: input.options?.map(option => ({ value: option.value, displayName: option.label })) })),
      },
    } };
}

export function remoteItemEvent(localId: string, item: RemoteTranscriptItem): EventEnvelope {
  const base = { session_id: localId, turn: item.turn, call_id: item.id, ts: item.ts, data: {} };
  if (item.kind === 'user') return { ...base, event: 'user_message', data: { text: item.text,
    ...(item.attachments ? { attachments: item.attachments.map(file => ({ name: file.name, mime: file.mime, size: file.size,
      url: `/api/remote/sessions/${localId}/files/${encodeURIComponent(file.reference ?? file.id)}` })) } : {}) } };
  if (item.kind === 'assistant') return { ...base, event: 'remote.message', display: { type: 'message', data: { text: item.text, delta: item.delta, itemId: item.id } } };
  if (item.kind === 'turn-end') return { ...base, event: 'turn_completed', display: { type: 'state.turn-completed',
    data: { turnId: localRemoteTurnId(localId, item.turn), status: item.outcome === 'worked' ? 'completed' : item.outcome === 'stopped' ? 'stopped' : 'error' } } };
  if (item.kind === 'error') return { ...base, event: 'session_error', display: { type: 'state.error', data: { message: 'Remote execution failed', retryable: false } } };
  return { ...base, event: 'remote.activity', display: { type: 'activity.notice', data: { code: item.kind,
    severity: 'info', title: item.kind, message: item.kind } } };
}

export function remoteHistoryEvent(localId: string, entry: ExecutionHistoryEntry): EventEnvelope {
  if ('item' in entry) return remoteItemEvent(localId, entry.item);
  if ('interaction' in entry) return remoteInteractionEvent(localId, entry.interaction, entry.turn);
  const resolution = entry.resolution;
  const id = localInteractionId(localId, resolution.interaction_id);
  return { session_id: localId, turn: resolution.turn, call_id: id, event: 'remote.interaction.resolved',
    ts: resolution.ts, data: {}, display: { type: 'interaction.resolved',
      data: { approvalId: id, decision: resolution.decision, auto: resolution.auto,
        ...(resolution.answers ? { answers: resolution.answers } : {}) } } };
}
