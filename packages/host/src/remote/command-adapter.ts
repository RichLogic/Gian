import {
  COMMAND_RETENTION_MS,
  COMMAND_TIMESTAMP_SKEW_MS,
  REMOTE_METHODS,
  RemoteProtocolError,
  SNAPSHOT_PART_BYTES,
  SNAPSHOT_SPLIT_THRESHOLD_BYTES,
  canonicalJson,
  isRemoteErrorCode,
  parseRemoteMethodParams,
  redactRemoteError,
  splitSnapshotParts,
  uuidV7TimestampMs,
  type CommandRequest,
  type CommandStatusResult,
  type RemoteErrorCode,
  type RemoteMethod,
  type RemoteSession,
  type RemoteStateSnapshot,
  type StateSnapshotPart,
} from '@gian/remote-protocol';
import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type {
  ComposerDocument,
  GianToolCreateOptions,
  GianToolResult,
  InputItem,
  MessageContextItem,
} from '@gian/shared';
import { ensureSessionAttachmentDir } from '../storage/attachments.js';
import type { GianToolAccessController } from '../tool/access.js';
import type { GianToolActor } from '../tool/credentials.js';
import type { GianToolService } from '../tool/service.js';
import type { SessionManager } from '../session/manager.js';
import type { Db } from '../storage/db.js';
import type { RemoteAuditCategory, RemoteMutationAudit } from './audit.js';
import type { RemoteAttachmentService } from './attachment-stream.js';
import type { RemoteDeviceRecord } from './device-store.js';
import type { RemoteFileRefService } from './file-ref.js';
import { RemoteProjector, assertNoLeak, remoteStableUuid, resolveRemoteAction, resolveRemoteAnswerValues } from './projection.js';

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function hostServiceTier(value: 'standard' | 'fast'): 'fast' | null {
  return value === 'fast' ? 'fast' : null;
}

export interface RemoteCommandAdapterDeps {
  db: Db;
  access: GianToolAccessController;
  tool: GianToolService;
  sessions: SessionManager;
  projector: RemoteProjector;
  attachments: RemoteAttachmentService;
  fileRefs: RemoteFileRefService;
  audit: RemoteMutationAudit;
  hostGeneration: string;
  snapshot: (device: RemoteDeviceRecord) => unknown;
  /** Oversized state.refresh payloads follow a pending snapshot receipt. */
  pushSnapshotParts?: (deviceId: string, part: StateSnapshotPart) => Promise<void>;
  listAgents?: () => Array<{ id: string }>;
  onSubscribe?: (deviceId: string, sessionId: string) => void;
}

export class RemoteCommandAdapter {
  constructor(private readonly deps: RemoteCommandAdapterDeps) {}

  async execute(
    device: RemoteDeviceRecord,
    command: CommandRequest,
    hooks?: {
      snapshotParts?: boolean;
      onAccepted?: () => Promise<void>;
      onResultSent?: () => Promise<void>;
    },
  ): Promise<{
    ok: boolean;
    data?: unknown;
    error?: { code: string; message: string };
  }> {
    try {
      const claimed = this.claim(device, command);
      if (claimed.kind === 'done') return claimed.result;
      await hooks?.onAccepted?.();
      const data = await this.dispatch(device, command, claimed.params, hooks);
      assertNoLeak(data);
      if (isMutation(command.method)) {
        this.upsertLedger(device.id, command, 'succeeded', data);
        this.record(device, command, 'succeeded');
      }
      return { ok: true, data };
    } catch (error) {
      const mapped = mapError(error);
      if (isMutation(command.method)) {
        this.upsertLedger(device.id, command, mapped.code === 'UNKNOWN_OUTCOME' ? 'unknown_outcome' : 'failed', undefined, mapped);
        this.record(device, command, categoryFor(mapped.code));
      }
      return { ok: false, error: mapped };
    }
  }

  private claim(
    device: RemoteDeviceRecord,
    command: CommandRequest,
  ):
    | { kind: 'done'; result: { ok: boolean; data?: unknown; error?: { code: string; message: string } } }
    | { kind: 'accepted'; params: unknown } {
    if (device.revokedAt) return { kind: 'done', result: fail('DEVICE_REVOKED', 'device is revoked') };
    if (this.commandExpired(command.command_id)) {
      this.record(device, command, 'expired');
      return { kind: 'done', result: fail('COMMAND_EXPIRED', 'command_id is outside the 90-day window') };
    }
    const prior = this.ledger(device.id, command.command_id);
    if (prior?.state === 'succeeded' || prior?.state === 'failed' || prior?.state === 'unknown_outcome') {
      return { kind: 'done', result: this.reproject(device, prior) };
    }
    const params = parseRemoteMethodParams(command.method, command.params);
    this.rejectCraftedFields(command.params);
    if (command.method !== 'command.status' && command.method !== 'state.refresh' && command.method !== 'catalog.read') {
      this.upsertLedger(device.id, command, 'accepted');
    }
    return { kind: 'accepted', params };
  }

  // A pending receipt is not a replacement snapshot. The client retains its
  // state and command waiter until every part has been verified.
  private async refresh(
    device: RemoteDeviceRecord,
    hooks?: { onResultSent?: () => Promise<void>; snapshotParts?: boolean },
  ): Promise<unknown> {
    const snapshot = this.deps.snapshot(device) as RemoteStateSnapshot;
    const payloadBytes = new TextEncoder().encode(canonicalJson(snapshot)).byteLength;
    if (payloadBytes <= SNAPSHOT_SPLIT_THRESHOLD_BYTES) {
      return snapshot;
    }
    if (hooks?.snapshotParts === false) {
      throw new RemoteProtocolError('PROTOCOL_VERSION_UNSUPPORTED', 'The remote client did not negotiate snapshot parts');
    }
    if (!this.deps.pushSnapshotParts || !hooks) {
      throw new RemoteProtocolError('FRAME_TOO_LARGE', 'snapshot part transport is unavailable');
    }
    const parts = await splitSnapshotParts(snapshot, SNAPSHOT_PART_BYTES);
    hooks.onResultSent = async () => {
      for (const part of parts) {
        await this.deps.pushSnapshotParts!(device.id, part);
      }
    };
    return { type: 'state.snapshot.pending', snapshot_id: snapshot.snapshot_id };
  }

  private async dispatch(
    device: RemoteDeviceRecord,
    command: CommandRequest,
    params: unknown,
    hooks?: {
      snapshotParts?: boolean;
      onAccepted?: () => Promise<void>;
      onResultSent?: () => Promise<void>;
    },
  ): Promise<unknown> {
    const method = command.method;
    switch (method) {
      case 'catalog.read':
        return this.catalog(device, command);
      case 'state.refresh':
        return this.refresh(device, hooks);
      case 'session.subscribe':
        return this.subscribe(device, command, params as { session_id: string });
      case 'session.page':
        return this.page(device, params as { session_id: string; turns?: number; cursor?: string });
      case 'command.status':
        return this.status(device, params as { command_id: string });
      case 'session.create':
        return this.createSession(device, command, params as Record<string, unknown>);
      case 'session.update':
        return this.updateSession(device, command, params as Record<string, unknown>);
      case 'session.send':
        return this.send(device, command, params as Record<string, unknown>);
      case 'session.stop':
        return this.stop(device, command, params as Record<string, unknown>);
      case 'queue.update':
      case 'queue.remove':
      case 'queue.clear':
      case 'queue.send_now':
        return this.queue(device, command, method, params as Record<string, unknown>);
      case 'interaction.respond':
        return this.respond(device, command, params as Record<string, unknown>);
      case 'file.preview':
        return this.preview(device, params as { handle_id: string });
      default: {
        const _exhaustive: never = method;
        throw new RemoteProtocolError('INVALID_FRAME', `unsupported method ${String(_exhaustive)}`);
      }
    }
  }

  private async catalog(device: RemoteDeviceRecord, command: CommandRequest): Promise<unknown> {
    const result = await this.toolCall(device, command, 'catalog.get_create_options', {});
    const data = result.data as GianToolCreateOptions;
    const tasks = this.deps.db.prepare(
      `SELECT id, name, status FROM tasks WHERE status = 'open'`,
    ).all() as Array<{ id: string; name: string; status: string }>;
    return this.deps.projector.projectCatalog({ ...data, tasks });
  }

  private subscribe(
    device: RemoteDeviceRecord,
    command: CommandRequest,
    params: { session_id: string },
  ): { session: RemoteSession; cursor: string } {
    this.assertVisibleSession(params.session_id);
    this.deps.db.prepare(
      `DELETE FROM remote_file_refs WHERE device_id = ? AND session_id != ?`,
    ).run(device.id, params.session_id);
    this.deps.onSubscribe?.(device.id, params.session_id);
    void command;
    const session = this.deps.projector.projectSession(this.deps.sessions.getSession(params.session_id));
    return { session, cursor: session.revision };
  }

  private page(
    device: RemoteDeviceRecord,
    params: { session_id: string; turns?: number; cursor?: string },
  ): unknown {
    this.assertVisibleSession(params.session_id);
    return this.deps.projector.transcriptPage(params.session_id, params.turns ?? 3, {
      cursor: params.cursor,
      deviceId: device.id,
    });
  }

  private status(device: RemoteDeviceRecord, params: { command_id: string }): CommandStatusResult {
    if (this.commandExpired(params.command_id)) {
      return { command_id: params.command_id, state: 'expired' };
    }
    const row = this.ledger(device.id, params.command_id);
    if (!row) return { command_id: params.command_id, state: 'not_seen' };
    const projected = this.reproject(device, row);
    return {
      command_id: params.command_id,
      state: row.state === 'accepted' ? 'accepted'
        : row.state === 'succeeded' ? 'succeeded'
          : row.state === 'unknown_outcome' ? 'unknown_outcome'
            : row.state === 'expired' ? 'expired'
              : 'failed',
      ...(projected.ok ? { result: projected.data } : {}),
      ...(projected.error ? { error: asRemoteError(projected.error) } : {}),
    };
  }

  private async createSession(
    device: RemoteDeviceRecord,
    command: CommandRequest,
    params: Record<string, unknown>,
  ): Promise<RemoteSession> {
    if (params['catalog_revision'] !== this.deps.projector.catalogRevision()) {
      throw precondition('catalog_revision', this.deps.projector.catalogRevision());
    }
    const taskId = typeof params['task_id'] === 'string' ? params['task_id'] : null;
    if (!taskId) {
      throw new RemoteProtocolError('REMOTE_CAPABILITY_DENIED', 'Remote sessions require an open Doing Task');
    }
    const task = this.deps.db.prepare('SELECT status FROM tasks WHERE id = ?')
      .get(taskId) as { status: string } | undefined;
    if (!task || task.status !== 'open') {
      throw new RemoteProtocolError('REMOTE_CAPABILITY_DENIED', 'Task is not open');
    }
    const result = await this.toolCall(device, command, 'session.create', {
      workspace_id: params['workspace_id'],
      agent_id: this.resolveAgentId(String(params['agent_id'])),
      task_id: taskId,
      ...(params['name'] ? { name: params['name'] } : {}),
      config: {
        ...(params['model'] ? { model: params['model'] } : {}),
        ...(params['thinking'] ? { thinking_effort: params['thinking'] } : {}),
        ...(params['service_tier'] ? {
          service_tier: hostServiceTier(params['service_tier'] as 'standard' | 'fast'),
        } : {}),
      },
    });
    const sessionId = (result.data as { session: { id: string } }).session.id;
    return this.deps.projector.projectSession(this.deps.sessions.getSession(sessionId));
  }

  private async updateSession(
    device: RemoteDeviceRecord,
    command: CommandRequest,
    params: Record<string, unknown>,
  ): Promise<RemoteSession> {
    this.assertVisibleSession(String(params['session_id']));
    this.assertSessionRevision(String(params['session_id']), String(params['session_revision']));
    await this.toolCall(device, command, 'session.update', {
      session_id: params['session_id'],
      expected_session_revision: params['session_revision'],
      ...(params['name'] !== undefined ? { name: params['name'] } : {}),
      config: {
        ...(params['model'] !== undefined ? { model: params['model'] } : {}),
        ...(params['thinking'] !== undefined ? { thinking_effort: params['thinking'] } : {}),
        ...(params['service_tier'] !== undefined ? {
          service_tier: hostServiceTier(params['service_tier'] as 'standard' | 'fast'),
        } : {}),
        ...(params['approval_mode'] !== undefined ? { approval_mode: params['approval_mode'] } : {}),
      },
    });
    return this.deps.projector.projectSession(this.deps.sessions.getSession(String(params['session_id'])));
  }

  private async send(
    device: RemoteDeviceRecord,
    command: CommandRequest,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    this.assertVisibleSession(String(params['session_id']));
    const sessionId = String(params['session_id']);
    const items = [
      ...(this.resolveItems(device, params['items'], sessionId) ?? []),
      ...await this.resolveContextFiles(device, params['context_items'], sessionId),
    ];
    const contextItems = this.resolveContext(device, params['context_items'], sessionId);
    const document = this.resolveDocument(device, params['composer_document'], sessionId);
    let result;
    try {
      result = await this.toolCall(device, command, 'session.send', {
        session_id: params['session_id'],
        text: params['text'],
        ...(params['busy'] ? { busy: params['busy'] } : {}),
        ...(items.length ? { items } : {}),
        ...(contextItems ? { context_items: contextItems } : {}),
        ...(document ? { composer_document: document } : {}),
      });
    } catch (error) {
      this.unpinResolved(items);
      throw error;
    }
    this.pinResolved(items);
    return {
      session: this.deps.projector.projectSession(this.deps.sessions.getSession(String(params['session_id']))),
      ...((result.data as { delivery_id?: string }).delivery_id
        ? { delivery_id: (result.data as { delivery_id: string }).delivery_id }
        : {}),
    };
  }

  private async stop(
    device: RemoteDeviceRecord,
    command: CommandRequest,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    this.assertVisibleSession(String(params['session_id']));
    this.assertSessionRevision(String(params['session_id']), String(params['session_revision']));
    const result = await this.toolCall(device, command, 'session.stop', {
      session_id: params['session_id'],
      expected_session_revision: params['session_revision'],
    });
    return {
      already_idle: (result.data as { already_idle: boolean }).already_idle,
      session_revision: this.deps.sessions.getResourceRevision(String(params['session_id'])),
    };
  }

  private async queue(
    device: RemoteDeviceRecord,
    command: CommandRequest,
    method: 'queue.update' | 'queue.remove' | 'queue.clear' | 'queue.send_now',
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const sessionId = String(params['session_id']);
    this.assertVisibleSession(sessionId);
    const unpinIds = method === 'queue.remove'
      ? this.queueAttachmentIds(sessionId, String(params['queue_id']))
      : method === 'queue.clear'
        ? this.sessionQueueAttachmentIds(sessionId)
        : [];
    const result = await this.toolCall(device, command, method, {
      ...params,
      expected_queue_revision: params['expected_queue_revision'],
    });
    for (const uploadId of unpinIds) this.deps.attachments.unpin(uploadId);
    const data = result.data as { queue: unknown[]; queue_revision: string; mode?: string };
    return {
      queue: this.deps.sessions.getQueue(sessionId).map(entry => (
        this.deps.projector.projectQueueEntry(entry, device.id)
      )),
      queue_revision: data.queue_revision,
      ...(data.mode ? { mode: data.mode } : {}),
    };
  }

  private async respond(
    device: RemoteDeviceRecord,
    command: CommandRequest,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const pending = this.deps.sessions.getPendingApproval(String(params['interaction_id']));
    const interaction = this.deps.db.prepare(
      `SELECT session_id, resource_revision FROM proxy_interactions WHERE interaction_id = ?`,
    ).get(params['interaction_id']) as { session_id: string; resource_revision: number } | undefined;
    const sessionId = pending?.sessionId ?? interaction?.session_id;
    if (!sessionId || !pending) {
      throw new RemoteProtocolError('PRECONDITION_FAILED', 'interaction is not pending');
    }
    this.assertVisibleSession(sessionId);
    const currentRevision = String(interaction?.resource_revision ?? 0);
    if (currentRevision !== String(params['interaction_revision'])) {
      throw precondition('interaction_revision', currentRevision);
    }
    const mapped = resolveRemoteAction(pending, String(params['action_id'] ?? ''));
    if (!mapped) {
      throw new RemoteProtocolError('REMOTE_CAPABILITY_DENIED', 'action_id is not an issued interaction action');
    }
    await this.toolCall(device, command, 'interaction.respond', {
      session_id: sessionId,
      interaction_id: params['interaction_id'],
      expected_interaction_revision: params['interaction_revision'],
      ...(mapped.decision && mapped.decision !== 'submit_answers' ? { decision: mapped.decision } : {}),
      ...(mapped.native_option_id ? { native_option_id: mapped.native_option_id } : {}),
      ...(params['values'] && typeof params['values'] === 'object' && !Array.isArray(params['values'])
        ? { answers: resolveRemoteAnswerValues(pending, params['values'] as Record<string, unknown>) }
        : {}),
    });
    return {
      interaction_id: params['interaction_id'],
      revision: this.deps.db.prepare(
        'SELECT resource_revision FROM proxy_interactions WHERE interaction_id = ?',
      ).get(params['interaction_id']) as { resource_revision: number } | undefined
        ? String((this.deps.db.prepare(
          'SELECT resource_revision FROM proxy_interactions WHERE interaction_id = ?',
        ).get(params['interaction_id']) as { resource_revision: number }).resource_revision)
        : '1',
      resolved: true as const,
    };
  }

  private async preview(device: RemoteDeviceRecord, params: { handle_id: string }): Promise<unknown> {
    const preview = await this.deps.fileRefs.preview({ deviceId: device.id, handleId: params.handle_id });
    return {
      transfer_id: preview.transfer_id,
      file: {
        id: preview.file.handle_id,
        session_id: this.deps.fileRefs.get(params.handle_id)!.sessionId,
        name: preview.file.name,
        mime: preview.file.mime,
        size: preview.file.size,
        revision: preview.file.revision,
        previewable: true,
        downloadable: true,
        expires_at: this.deps.fileRefs.get(params.handle_id)!.expiresAt,
      },
      preview_max_bytes: preview.preview_max_bytes,
    };
  }

  private async toolCall(
    device: RemoteDeviceRecord,
    command: CommandRequest,
    method: Parameters<GianToolAccessController['call']>[1]['method'],
    params: Record<string, unknown>,
  ): Promise<GianToolResult> {
    const actor = this.actor(device);
    const result = await this.deps.access.call(actor, {
      request_id: command.attempt_id,
      idempotency_key: command.command_id,
      method,
      params,
    });
    if (!result.ok) {
      const error = result.error ?? { code: 'UNKNOWN_OUTCOME', message: 'tool call failed' };
      throw Object.assign(new Error(error.message), {
        code: error.code,
        details: 'details' in error ? error.details : undefined,
      });
    }
    return result;
  }

  private resolveAgentId(remoteId: string): string {
    const agents = this.deps.listAgents?.() ?? [];
    const match = agents.find(agent => agent.id === remoteId || remoteStableUuid('agent', agent.id) === remoteId);
    if (!match) {
      throw new RemoteProtocolError('REMOTE_CAPABILITY_DENIED', 'agent is not available remotely');
    }
    return match.id;
  }

  private actor(device: RemoteDeviceRecord): GianToolActor {
    return {
      kind: 'external_controller',
      credentialId: `remote-device:${device.id}`,
      clientId: `remote:${device.id}`,
      callerId: `remote:${device.id}`,
      role: 'admin',
      grants: [...device.grants],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
  }

  private assertVisibleSession(sessionId: string): void {
    const session = this.deps.sessions.getSession(sessionId);
    if (!this.deps.projector.isSessionVisible(session)) {
      throw new RemoteProtocolError(
        'REMOTE_CAPABILITY_DENIED',
        'only incomplete Sessions in open Doing Tasks are visible remotely',
      );
    }
  }

  private assertSessionRevision(sessionId: string, expected: string): void {
    const current = this.deps.sessions.getResourceRevision(sessionId);
    if (current !== expected) throw precondition('session_revision', current);
  }

  private resolveItems(device: RemoteDeviceRecord, items: unknown, sessionId: string): InputItem[] | undefined {
    if (!Array.isArray(items)) return undefined;
    return items.map(item => {
      const record = item as { type?: string; text?: string; attachment_id?: string };
      if (record.type === 'text' && typeof record.text === 'string') {
        return { type: 'text' as const, text: record.text };
      }
      if (record.type === 'attachment' && record.attachment_id) {
        const resolved = this.deps.attachments.resolveHandle(device.id, record.attachment_id, sessionId);
        if (!resolved) throw new RemoteProtocolError('ATTACHMENT_NOT_FOUND', 'attachment handle is not usable');
        return resolved;
      }
      throw new RemoteProtocolError('INVALID_FRAME', 'Remote send items must be text or Host attachment handles');
    });
  }

  private pinResolved(items: InputItem[]): void {
    for (const handle of this.attachmentIdsFromQueueItems(items)) {
      this.deps.attachments.pin(handle);
    }
  }

  private unpinResolved(items: InputItem[]): void {
    for (const handle of this.attachmentIdsFromQueueItems(items)) {
      this.deps.attachments.unpin(handle);
    }
  }

  private queueAttachmentIds(sessionId: string, queueId: string): string[] {
    const entry = this.deps.sessions.getQueue(sessionId).find((item) => item.id === queueId);
    return this.attachmentIdsFromQueueItems(entry?.items);
  }

  private sessionQueueAttachmentIds(sessionId: string): string[] {
    return this.deps.sessions.getQueue(sessionId).flatMap((entry) => this.attachmentIdsFromQueueItems(entry.items));
  }

  private attachmentIdsFromQueueItems(items?: InputItem[]): string[] {
    if (!items) return [];
    return items.flatMap((item) => {
      if ((item.type === 'localFile' || item.type === 'localImage') && 'path' in item && typeof item.path === 'string') {
        const handle = this.deps.attachments.findHandleByPath(item.path);
        return handle ? [handle] : [];
      }
      return [];
    });
  }

  private commandExpired(commandId: string): boolean {
    if (!UUID_V7_RE.test(commandId)) return true;
    const timestamp = uuidV7TimestampMs(commandId);
    const now = Date.now();
    return now - timestamp > COMMAND_RETENTION_MS || timestamp - now > COMMAND_TIMESTAMP_SKEW_MS;
  }

  private resolveContext(device: RemoteDeviceRecord, items: unknown, sessionId: string): MessageContextItem[] | undefined {
    if (!Array.isArray(items)) return undefined;
    const projected = items.flatMap((item, index) => {
      const record = item as { type?: string; text?: string; handle_id?: string };
      if (record.type === 'pasted_text' && typeof record.text === 'string') {
        const bytes = new TextEncoder().encode(record.text).byteLength;
        return [{
          id: `remote-paste-${index}`,
          type: 'pastedText' as const,
          text: record.text,
          lineCount: record.text.split('\n').length,
          byteSize: bytes,
        }];
      }
      if (record.type === 'file_ref' && record.handle_id) {
        this.requireIssuedHandle(device, record.handle_id, sessionId);
        return [];
      }
      throw new RemoteProtocolError('INVALID_FRAME', 'Remote context items must be pasted_text or Host-issued file_ref handles');
    });
    return projected.length > 0 ? projected : undefined;
  }

  private async resolveContextFiles(device: RemoteDeviceRecord, items: unknown, sessionId: string): Promise<InputItem[]> {
    if (!Array.isArray(items)) return [];
    const resolved: InputItem[] = [];
    for (const item of items) {
      const record = item as { type?: string; handle_id?: string };
      if (record.type !== 'file_ref' || !record.handle_id) continue;
      resolved.push(await this.resolveHandleItem(device, record.handle_id, sessionId));
    }
    return resolved;
  }

  private async resolveHandleItem(device: RemoteDeviceRecord, handleId: string, sessionId: string): Promise<InputItem> {
    const attachment = this.deps.attachments.resolveHandle(device.id, handleId, sessionId);
    if (attachment) return attachment;
    const file = this.deps.fileRefs.get(handleId);
    if (!file || file.deviceId !== device.id || file.sessionId !== sessionId) {
      throw new RemoteProtocolError('FILE_REFERENCE_EXPIRED', 'handle is not a Host-issued file or attachment reference');
    }
    const payload = await this.deps.fileRefs.readBytes({
      deviceId: device.id,
      handleId,
    });
    const dir = await ensureSessionAttachmentDir(sessionId);
    const filename = basename(payload.name).replace(/[^A-Za-z0-9._-]+/g, '_') || 'file.bin';
    const path = join(dir, filename);
    await writeFile(path, payload.bytes);
    return {
      type: 'localFile',
      path,
      name: payload.name,
      mime: payload.mime,
      size: payload.bytes.length,
    };
  }

  private resolveDocument(device: RemoteDeviceRecord, value: unknown, sessionId: string): ComposerDocument | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const nodes = (value as { nodes?: unknown }).nodes;
    if (!Array.isArray(nodes)) return undefined;
    return {
      version: 1,
      segments: nodes.map(node => {
        const record = node as { type?: string; text?: string; handle_id?: string };
        if (record.type === 'text' && typeof record.text === 'string') {
          return { type: 'text' as const, text: record.text };
        }
        if (record.type === 'reference' && record.handle_id) {
          const resolved = this.requireIssuedHandle(device, record.handle_id, sessionId);
          return {
            type: 'reference' as const,
            id: record.handle_id,
            referenceType: resolved.kind,
            label: resolved.label,
          };
        }
        throw new RemoteProtocolError('INVALID_FRAME', 'composer reference nodes must resolve to a Host-issued handle');
      }),
    };
  }

  private requireIssuedHandle(
    device: RemoteDeviceRecord,
    handleId: string,
    sessionId: string,
  ): { kind: 'attachment' | 'context'; label: string } {
    const file = this.deps.fileRefs.get(handleId);
    if (file && file.deviceId === device.id && file.sessionId === sessionId) {
      return { kind: 'attachment', label: file.relativePath.split('/').pop() ?? file.relativePath };
    }
    const attachment = this.deps.attachments.resolveHandle(device.id, handleId, sessionId);
    if (attachment && 'name' in attachment && typeof attachment.name === 'string') {
      return { kind: 'attachment', label: attachment.name };
    }
    throw new RemoteProtocolError('FILE_REFERENCE_EXPIRED', 'handle is not a Host-issued file or attachment reference');
  }

  private rejectCraftedFields(params: unknown): void {
    if (!params || typeof params !== 'object') return;
    const record = params as Record<string, unknown>;
    // approval_mode is a legitimate session config field (2026-09-15 audit-
    // mode sync) — only genuinely privileged/crafted keys stay blocked.
    for (const key of ['role', 'grants', 'caller_id', 'client_id', 'session', 'path', 'native_session_id']) {
      if (key in record) {
        throw new RemoteProtocolError('INVALID_FRAME', `crafted field ${key} is not accepted`);
      }
    }
  }

  private ledger(deviceId: string, commandId: string): LedgerRow | null {
    const row = this.deps.db.prepare(
      `SELECT * FROM remote_command_ledger WHERE device_id = ? AND command_id = ?`,
    ).get(deviceId, commandId) as LedgerRow | undefined;
    return row ?? null;
  }

  private upsertLedger(
    deviceId: string,
    command: CommandRequest,
    state: LedgerRow['state'],
    data?: unknown,
    error?: { code: string; message: string },
  ): void {
    const now = new Date().toISOString();
    this.deps.db.prepare(
      `INSERT INTO remote_command_ledger
        (command_id, device_id, method, attempt_id, state, tool_result_json, error_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id, command_id) DO UPDATE SET
         attempt_id = excluded.attempt_id,
         state = excluded.state,
         tool_result_json = excluded.tool_result_json,
         error_json = excluded.error_json,
         updated_at = excluded.updated_at`,
    ).run(
      command.command_id,
      deviceId,
      command.method,
      command.attempt_id,
      state,
      data === undefined ? null : JSON.stringify(data),
      error ? JSON.stringify(error) : null,
      now,
      now,
    );
  }

  private reproject(device: RemoteDeviceRecord, row: LedgerRow): { ok: boolean; data?: unknown; error?: { code: string; message: string } } {
    void device;
    if (row.tool_result_json) {
      const data = JSON.parse(row.tool_result_json) as unknown;
      assertNoLeak(data);
      return { ok: true, data };
    }
    return {
      ok: false,
      error: row.error_json
        ? JSON.parse(row.error_json) as { code: string; message: string }
        : { code: 'UNKNOWN_OUTCOME', message: 'command outcome is unknown' },
    };
  }

  private record(device: RemoteDeviceRecord, command: CommandRequest, category: RemoteAuditCategory): void {
    if (!isMutation(command.method)) return;
    this.deps.audit.write({
      deviceId: device.id,
      method: command.method,
      commandId: command.command_id,
      resultCategory: category,
    });
  }
}

interface LedgerRow {
  command_id: string;
  device_id: string;
  method: RemoteMethod;
  attempt_id: string;
  state: 'accepted' | 'succeeded' | 'failed' | 'unknown_outcome' | 'expired';
  tool_result_json: string | null;
  error_json: string | null;
}

function isMutation(method: RemoteMethod): boolean {
  return method === 'session.create'
    || method === 'session.update'
    || method === 'session.send'
    || method === 'session.stop'
    || method === 'queue.update'
    || method === 'queue.remove'
    || method === 'queue.clear'
    || method === 'queue.send_now'
    || method === 'interaction.respond';
}

function asRemoteError(error: { code: string; message: string }): { code: RemoteErrorCode; message: string } {
  if (isRemoteErrorCode(error.code)) return { code: error.code, message: error.message };
  if (error.code === 'PERMISSION_DENIED' || error.code === 'FORBIDDEN') {
    return { code: 'REMOTE_CAPABILITY_DENIED', message: error.message };
  }
  if (error.code === 'NOT_FOUND') return { code: 'ATTACHMENT_NOT_FOUND', message: error.message };
  return { code: 'INVALID_FRAME', message: error.message };
}

function fail(code: string, message: string): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code, message } };
}

function precondition(field: string, current: string): RemoteProtocolError {
  return new RemoteProtocolError('PRECONDITION_FAILED', `${field} mismatch`, {
    [field]: current,
  });
}

function mapError(error: unknown): { code: string; message: string } {
  if (error instanceof RemoteProtocolError) {
    return { code: error.code, message: redactRemoteError(error.message) };
  }
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : 'INVALID_FRAME';
  const message = error instanceof Error ? error.message : String(error);
  return { code, message: redactRemoteError(message) };
}

function categoryFor(code: string): RemoteAuditCategory {
  if (code === 'COMMAND_EXPIRED') return 'expired';
  if (code === 'PERMISSION_DENIED' || code === 'REMOTE_CAPABILITY_DENIED') return 'denied';
  if (code === 'PRECONDITION_FAILED') return 'precondition_failed';
  if (code === 'UNKNOWN_OUTCOME') return 'unknown_outcome';
  return 'failed';
}

void REMOTE_METHODS;
