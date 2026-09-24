import { createHash } from 'node:crypto';
import {
  MAX_ARRAY_ITEMS,
  MAX_ATTACHMENT_BYTES,
  MAX_FILE_PREVIEW_BYTES,
  generateCanonicalId,
  redactRemoteText,
  redactRemoteConversationText,
  type RemoteAttention,
  type RemoteInteraction,
  type RemoteQueueEntry,
  type RemoteSession,
  type RemoteStateSnapshot,
  type RemoteTask,
  type RemoteTranscriptItem,
} from '@gian/remote-protocol';
import {
  stripGianRolePrefix,
  stripManagerSystemPrefix,
  type EventEnvelope,
  type InputItem,
  type MessageContextItem,
  type Session,
  type UserAgent,
} from '@gian/shared';
import type { ApprovalRecord } from '../approval/manager.js';
import type { Db } from '../storage/db.js';
import type { SessionManager } from '../session/manager.js';
import type { TaskManager } from '../task/manager.js';
import type { EffectiveCapabilities } from '@gian/remote-protocol';
import type { QueueEntry } from '../queue/manager.js';
import { previewMimeForAttachment } from '../storage/attachments.js';
import { projectInteraction } from '../tool/projections.js';
import type { RemoteAttachmentService } from './attachment-stream.js';
import type { RemoteFileRefService } from './file-ref.js';

export const UNFILED_WORKSPACE_ID = '00000000-0000-4000-8000-000000000000';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Deterministic Remote DTO id for Host identifiers that are not already UUIDs. */
export function remoteStableUuid(kind: string, raw: string): string {
  if (UUID_RE.test(raw)) return raw;
  const digest = createHash('sha256').update(`gian.remote.${kind}:${raw}`).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const LEAK_KEYS = [
  'path',
  'worktree_path',
  'detected_worktree_path',
  'native_session_id',
  'runtime_profile',
  'runtime_profile_json',
  'cliPath',
  'token',
  'secret',
  'stderr',
  'stack',
];

export interface RemoteProjectionDeps {
  db: Db;
  sessions: SessionManager;
  tasks: TaskManager;
  host: { id: string; name: string; version: string };
  hostGeneration: string;
  listAgents?: () => Array<{
    id: string;
    name?: string;
    proxy?: string;
    defaults?: { model?: string | null; thinking?: string | null };
  }>;
  attachments?: RemoteAttachmentService;
  fileRefs?: RemoteFileRefService;
  workspacePath?: (sessionId: string) => string | null;
}

export function remoteActionId(interactionId: string, key: string): string {
  return remoteStableUuid('action', `${interactionId}:${key}`);
}

/**
 * Translate `interaction.respond` answer keys back to the Host question/input
 * ids. The projection hashes non-UUID question ids (AskUserQuestion rides the
 * full question text as its id) into wire UUIDs, so answers arrive keyed by
 * wire id while the Tool layer validates against the original ids. Keys that
 * match neither the wire nor the original id pass through untouched: dropping
 * them could silently lose an answer, and the Tool validator ignores unknown
 * keys anyway.
 */
export function resolveRemoteAnswerValues(
  record: ApprovalRecord,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const questions = projectInteraction(record).questions ?? [];
  if (questions.length === 0) return values;
  const originalByWireId = new Map(questions.map((question) => [
    UUID_RE.test(question.id) ? question.id : remoteStableUuid('input', `${record.id}:${question.id}`),
    question.id,
  ]));
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    resolved[originalByWireId.get(key) ?? key] = value;
  }
  return resolved;
}

export function resolveRemoteAction(
  record: ApprovalRecord,
  actionId: string,
): { decision?: string; native_option_id?: string } | null {
  const projected = projectInteraction(record);
  if (projected.native_options?.length) {
    const option = projected.native_options.find((item) => (
      remoteActionId(record.id, `native:${item.optionId}`) === actionId
    ));
    return option ? { native_option_id: option.optionId } : null;
  }
  const decision = projected.allowed_decisions.find((item) => remoteActionId(record.id, item) === actionId);
  return decision ? { decision } : null;
}

const PLAN_ACTION_LABELS: Record<string, string> = {
  accept_with_auto: 'Accept, auto-approve edits',
  accept_with_ask: 'Accept, ask before edits',
  keep_planning: 'Keep planning',
};

export function projectRemoteInteraction(record: ApprovalRecord, revision: string): RemoteInteraction {
  const tool = projectInteraction(record);
  const actions = tool.native_options?.length
    ? tool.native_options.map((option) => ({
      id: remoteActionId(record.id, `native:${option.optionId}`),
      label: option.label || option.optionId,
      tone: option.kind.startsWith('reject') ? 'danger' as const : 'default' as const,
    }))
    : tool.allowed_decisions.map((decision) => ({
      id: remoteActionId(record.id, decision),
      label: PLAN_ACTION_LABELS[decision] ?? decision,
      tone: decision === 'decline' || decision === 'keep_planning' ? 'danger' as const : 'default' as const,
    }));
  return {
    id: record.id,
    revision,
    session_id: record.sessionId,
    turn_id: UUID_RE.test(record.turnId) ? record.turnId : remoteStableUuid('turn', record.turnId),
    kind: tool.kind,
    created_at: new Date(record.createdAt).toISOString(),
    presentation: {
      title: (tool.subject ?? tool.category).slice(0, 256),
      description: tool.description.slice(0, 16_000) || tool.category,
      risk: tool.risk,
      actions,
      ...(tool.subject ? { subject: tool.subject.slice(0, 16_000) } : {}),
      ...(tool.questions?.length ? {
        inputs: tool.questions.map((question) => ({
          id: UUID_RE.test(question.id) ? question.id : remoteStableUuid('input', `${record.id}:${question.id}`),
          label: question.prompt.slice(0, 256),
          type: question.input_type === 'multi_select'
            ? 'multi_select' as const
            : question.input_type === 'single_select'
              ? 'single_select' as const
              : 'text' as const,
          ...(question.options?.length ? {
            options: question.options.map((option) => ({
              value: option.value,
              label: option.label,
              ...(option.description ? { description: option.description } : {}),
            })),
          } : {}),
        })),
      } : {}),
    },
  };
}

/** Remote is intentionally a narrow Doing view, not a second full archive. */
export function isRemoteSessionVisible(db: Db, session: Session): boolean {
  if (session.archived === 1 || session.completed_at != null || !session.task_id) return false;
  const task = db.prepare('SELECT status FROM tasks WHERE id = ?')
    .get(session.task_id) as { status: string } | undefined;
  return task?.status === 'open';
}

export class RemoteProjector {
  constructor(private readonly deps: RemoteProjectionDeps) {}

  catalogRevision(): string {
    const workspaces = this.deps.db.prepare(
      'SELECT id, name FROM workspaces ORDER BY id',
    ).all() as Array<{ id: string; name: string }>;
    const agents = (this.deps.listAgents?.() ?? []).map((agent) => ({
      id: agent.id,
      name: agent.name ?? null,
      proxy: agent.proxy ?? null,
      defaults: agent.defaults ?? null,
    }));
    const tasks = this.deps.tasks.listTasks()
      .filter((task) => task.status === 'open')
      .map((task) => ({ id: task.id, name: task.name }));
    return createHash('sha256').update(JSON.stringify({ workspaces, agents, tasks })).digest('hex').slice(0, 32);
  }

  revision(deviceId?: string): string {
    return this.stateRevision(this.visibleSessions(deviceId));
  }

  snapshot(input: {
    capabilities: EffectiveCapabilities;
    attention: RemoteAttention[];
    deviceId?: string;
    eventSequence?: number;
  }): RemoteStateSnapshot {
    const tasks = this.openTasks();
    const sessions = this.visibleSessions(input.deviceId);
    const visibleSessionIds = new Set(sessions.map((session) => session.id));
    return {
      type: 'state.snapshot',
      snapshot_id: generateCanonicalId(),
      host_generation: this.deps.hostGeneration,
      revision: this.stateRevision(sessions),
      event_sequence: input.eventSequence ?? 0,
      host: {
        id: this.deps.host.id,
        name: this.deps.host.name,
        online: true,
        version: this.deps.host.version,
      },
      workspaces: this.workspaces(sessions),
      tasks,
      sessions,
      interactions: this.pendingInteractions(visibleSessionIds),
      capabilities: input.capabilities,
      attention: input.attention.filter((item) => visibleSessionIds.has(item.session_id)),
      catalog_revision: this.catalogRevision(),
    };
  }

  isSessionVisible(session: Session): boolean {
    return isRemoteSessionVisible(this.deps.db, session);
  }

  isSessionIdVisible(sessionId: string): boolean {
    try {
      return this.isSessionVisible(this.deps.sessions.getSession(sessionId));
    } catch {
      return false;
    }
  }

  projectSession(session: Session, deviceId?: string): RemoteSession {
    const queue = this.deps.sessions.getQueue(session.id);
    const agent = {
      id: remoteStableUuid('agent', session.agent_id ?? session.executor),
      name: session.agent_name ?? session.executor,
      proxy: session.executor,
    };
    const active = this.deps.sessions.getActiveTurn(session.id);
    const projected: RemoteSession = {
      id: session.id,
      revision: this.deps.sessions.getResourceRevision(session.id),
      name: session.name,
      task_id: session.task_id,
      workspace_id: session.workspace_id ?? UNFILED_WORKSPACE_ID,
      agent,
      model: session.model,
      thinking: session.thinking_effort,
      service_tier: session.service_tier,
      approval_mode: session.approval_mode,
      context_tokens_used: session.context_tokens_used ?? null,
      context_window_tokens: session.context_window_tokens ?? null,
      context_usage_updated_at: session.context_usage_updated_at ?? null,
      status: session.status,
      unread: session.unread === 1,
      queue: {
        revision: this.deps.sessions.getQueueRevision(session.id),
        entries: queue.map(entry => this.projectQueueEntry(entry, deviceId)),
      },
      updated_at: session.updated_at,
      ...(active ? { active_turn: { id: active.id, turn_number: active.number } } : {}),
    };
    assertNoLeak(projected);
    return projected;
  }

  projectQueueEntry(entry: QueueEntry, deviceId?: string): RemoteQueueEntry {
    const items = this.projectQueueItems(entry, deviceId);
    const contextItems = this.projectQueueContext(entry.contextItems);
    const document = this.projectQueueDocument(entry.composerDocument);
    return {
      id: entry.id,
      session_id: entry.sessionId,
      text: entry.text,
      created_at: new Date(entry.createdAt).toISOString(),
      ...(items ? { items } : {}),
      ...(contextItems ? { context_items: contextItems } : {}),
      ...(document ? { composer_document: document } : {}),
    };
  }

  projectCatalog(raw: {
    workspaces: Array<{ id: string; name: string; path?: string }>;
    agents: Array<{
      id: string;
      name: string;
      proxy: string | null;
      ready?: boolean;
      defaults?: { model?: string | null; thinking?: string | null };
      models?: Array<{
        id: string;
        label: string;
        is_default: boolean;
        supported_thinking: string[];
      }>;
    }>;
    tasks?: Array<{ id: string; name: string; status?: string }>;
  }): {
    catalog_revision: string;
    workspaces: Array<{ id: string; name: string }>;
    agents: Array<{
      id: string;
      name: string;
      proxy: string;
      readiness: 'ready' | 'unavailable';
      defaults?: { model?: string; thinking?: string };
      models: Array<{
        id: string;
        label: string;
        is_default: boolean;
        supported_thinking: string[];
      }>;
    }>;
    tasks: Array<{ id: string; name: string }>;
  } {
    const projected = {
      catalog_revision: this.catalogRevision(),
      workspaces: raw.workspaces.map(workspace => ({ id: workspace.id, name: workspace.name })),
      agents: raw.agents.map(agent => ({
        id: remoteStableUuid('agent', agent.id),
        name: agent.name,
        proxy: agent.proxy ?? 'unknown',
        readiness: agent.ready === false ? 'unavailable' as const : 'ready' as const,
        ...(agent.defaults?.model || agent.defaults?.thinking ? {
          defaults: {
            ...(agent.defaults.model ? { model: agent.defaults.model } : {}),
            ...(agent.defaults.thinking ? { thinking: agent.defaults.thinking } : {}),
          },
        } : {}),
        models: (agent.models ?? []).slice(0, MAX_ARRAY_ITEMS).map(model => ({
          id: remoteName(model.id),
          label: remoteName(model.label),
          is_default: model.is_default,
          supported_thinking: model.supported_thinking.slice(0, 32).map(remoteName),
        })),
      })),
      tasks: (raw.tasks ?? []).filter(task => task.status === undefined || task.status === 'open')
        .map(task => ({ id: task.id, name: task.name })),
    };
    assertNoLeak(projected);
    return projected;
  }

  transcriptPage(sessionId: string, turns = 3, options: {
    cursor?: string;
    deviceId?: string;
  } = {}): {
    session_id: string;
    cursor?: string;
    has_more: boolean;
    items: RemoteTranscriptItem[];
  } {
    const beforeTurn = options.cursor === undefined ? null : parseTranscriptCursor(options.cursor);
    const page = this.deps.sessions.listEventPage(sessionId, beforeTurn, turns);
    const projectedItems = page.events.flatMap((event) => {
      const projected = this.projectTranscriptEvent(event, options.deviceId);
      return projected ? [projected] : [];
    });
    const items = capRemoteTranscriptItems(projectedItems);
    assertNoLeak(items);
    return {
      session_id: sessionId,
      items,
      has_more: page.hasMore,
      ...(page.nextCursor !== null ? { cursor: String(page.nextCursor) } : {}),
    };
  }

  /**
   * Project one live or persisted Host event into the closed Remote transcript
   * vocabulary. Unknown and non-transcript display events are omitted instead
   * of being mislabeled as generic notices.
   */
  projectTranscriptEvent(event: EventEnvelope, deviceId?: string): RemoteTranscriptItem | null {
    const data = event.display?.data as unknown as Record<string, unknown> | undefined;
    const type = event.display?.type;
    const turn = Number.isSafeInteger(event.turn) && event.turn >= 0 ? event.turn : 0;
    const ts = Number.isSafeInteger(event.ts) && event.ts >= 0 ? event.ts : Date.now();
    const logicalEventId = typeof data?.itemId === 'string' && data.itemId
      ? data.itemId
      : event.call_id;
    const turnIdentity = type === 'state.turn-completed' && typeof data?.turnId === 'string'
      ? data.turnId
      : `${event.session_id}:${turn}`;
    const base = (kind: RemoteTranscriptItem['kind']) => ({
      id: remoteStableUuid('transcript', `${event.session_id}:${turn}:${logicalEventId}:${kind}`),
      turn_id: remoteStableUuid('turn', turnIdentity),
      turn,
      ts,
    });

    if ((event.event === 'user_message' || event.event === 'user.message')
        && typeof event.data.text === 'string') {
      const attachments = this.projectMessageAttachments(event, deviceId);
      const delivery = (typeof event.data.tool_request_id === 'string'
        ? this.deps.db.prepare('SELECT id FROM tool_deliveries WHERE request_id = ? AND session_id = ?')
          .get(event.data.tool_request_id, event.session_id)
        : this.deps.db.prepare(`SELECT d.id FROM turns t JOIN tool_deliveries d ON d.request_id = t.tool_request_id
          WHERE t.session_id = ? AND t.turn_number = ? LIMIT 1`).get(event.session_id, turn)) as { id: string } | undefined;
      return {
        ...base('user'),
        kind: 'user',
        text: redactRemoteConversationText(stripGianRolePrefix(stripManagerSystemPrefix(event.data.text))).slice(0, 16_000),
        ...(delivery ? { delivery_id: delivery.id } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      };
    }
    if (!type || !data) return null;

    switch (type) {
      case 'message': {
        if (typeof data.text !== 'string' || data.text.length === 0) return null;
        return {
          ...base('assistant'),
          kind: 'assistant',
          text: redactRemoteConversationText(data.text).slice(0, 16_000),
          delta: data.delta === true,
        };
      }
      case 'activity.command':
        return {
          ...base('command'),
          kind: 'command',
          status: commandStatus(data.status),
          ...(integerValue(data.exitCode) !== undefined ? { exit_code: integerValue(data.exitCode) } : {}),
        };
      case 'activity.file-change':
        return {
          ...base('file-change'),
          kind: 'file-change',
          file_count: Array.isArray(data.files) ? data.files.length : 0,
        };
      case 'activity.file-read':
        return { ...base('file-read'), kind: 'file-read' };
      case 'activity.file-search':
        return {
          ...base('file-search'),
          kind: 'file-search',
          search_kind: data.kind === 'glob' ? 'glob' : 'grep',
          ...(nonNegativeInteger(data.matchCount) !== undefined
            ? { match_count: nonNegativeInteger(data.matchCount) }
            : {}),
        };
      case 'activity.web-search':
        return {
          ...base('web-search'),
          kind: 'web-search',
          ...(nonNegativeInteger(data.resultCount) !== undefined
            ? { result_count: nonNegativeInteger(data.resultCount) }
            : {}),
        };
      case 'activity.tool': {
        const rawName = typeof data.title === 'string' && data.title !== 'Tool'
          ? data.title
          : typeof data.kind === 'string' ? data.kind : 'Tool';
        return {
          ...base('tool'),
          kind: 'tool',
          name: remoteName(rawName),
          status: toolStatus(data.status),
        };
      }
      case 'agent':
        return {
          ...base('agent'),
          kind: 'agent',
          status: data.status === 'done' || data.status === 'error' ? data.status : 'running',
          ...(typeof data.agentType === 'string' ? { agent_type: remoteName(data.agentType) } : {}),
          ...(typeof data.model === 'string' ? { model: remoteName(data.model) } : {}),
          ...(typeof data.background === 'boolean' ? { background: data.background } : {}),
          started_at: nonNegativeInteger(data.startedAt) ?? ts,
          ...(nonNegativeInteger(data.completedAt) !== undefined
            ? { completed_at: nonNegativeInteger(data.completedAt) }
            : {}),
        };
      case 'activity.notice': {
        const code = typeof data.code === 'string' && data.code ? remoteName(data.code) : undefined;
        if (!code) return null;
        return {
          ...base('notice'),
          kind: 'notice',
          severity: data.severity === 'error' || data.severity === 'warning' ? data.severity : 'info',
          code,
        };
      }
      case 'activity.classifier-denied':
        return {
          ...base('classifier-denied'),
          kind: 'classifier-denied',
          consecutive: nonNegativeInteger(data.consecutive) ?? 0,
          total: nonNegativeInteger(data.total) ?? 0,
        };
      case 'activity.circuit-breaker':
        return {
          ...base('circuit-breaker'),
          kind: 'circuit-breaker',
          trigger: data.trigger === 'total' ? 'total' : 'consecutive',
          consecutive: nonNegativeInteger(data.consecutive) ?? 0,
          total: nonNegativeInteger(data.total) ?? 0,
        };
      case 'state.turn-completed': {
        const status = String(data.status ?? '').toLowerCase();
        return {
          ...base('turn-end'),
          kind: 'turn-end',
          outcome: /interrupt|cancel|stopp/.test(status)
            ? 'stopped'
            : /fail|error/.test(status) ? 'failed' : 'worked',
          ...(typeof data.sourceTurnId === 'string' && data.sourceTurnId
            ? { source_turn_id: remoteText(data.sourceTurnId) }
            : {}),
        };
      }
      case 'state.error':
        return { ...base('error'), kind: 'error' };
      case 'activity.reasoning':
      case 'plan':
      case 'state.turn-started':
      case 'interaction.question':
      case 'interaction.approval':
      case 'interaction.resolved':
        return null;
    }
  }

  private projectMessageAttachments(event: EventEnvelope, deviceId?: string) {
    const fileRefs = this.deps.fileRefs;
    if (!deviceId || !fileRefs || !Array.isArray(event.data.attachments)) return [];
    return event.data.attachments.flatMap((value, index) => {
      if (!value || typeof value !== 'object') return [];
      const attachment = value as Record<string, unknown>;
      if (
        typeof attachment.name !== 'string'
        || typeof attachment.mime !== 'string'
        || typeof attachment.url !== 'string'
      ) return [];
      const prefix = `/api/sessions/${event.session_id}/attachments/`;
      if (!attachment.url.startsWith(prefix)) return [];
      let filename: string;
      try {
        filename = decodeURIComponent(attachment.url.slice(prefix.length));
      } catch {
        return [];
      }
      if (!filename || filename.includes('/')) return [];
      const record = fileRefs.issueSessionAttachment({
        deviceId,
        sessionId: event.session_id,
        filename,
        contentRevision: `${event.call_id}:${index}`,
      });
      const size = nonNegativeInteger(attachment.size);
      const mime = remoteName(previewMimeForAttachment(filename));
      return [{
        id: record.id,
        reference: 'attachment:' + filename,
        session_id: event.session_id,
        name: remoteName(attachment.name),
        mime,
        size: size ?? 0,
        revision: record.contentRevision,
        previewable: (mime.startsWith('image/') || mime !== 'application/octet-stream')
          && (size === undefined || size <= MAX_FILE_PREVIEW_BYTES),
        downloadable: size === undefined || size <= MAX_ATTACHMENT_BYTES,
        expires_at: record.expiresAt,
      }];
    });
  }

  private workspaces(sessions: RemoteSession[]): Array<{ id: string; name: string }> {
    const rows = (this.deps.db.prepare(
      'SELECT id, name FROM workspaces ORDER BY sort_order, created_at',
    ).all() as Array<{ id: string; name: string }>).map(row => ({ id: row.id, name: row.name }));
    if (sessions.some(session => session.workspace_id === UNFILED_WORKSPACE_ID)) {
      rows.push({ id: UNFILED_WORKSPACE_ID, name: 'Unfiled' });
    }
    return rows;
  }

  private openTasks(): RemoteTask[] {
    return this.deps.tasks.listTasks()
      .filter(task => task.status === 'open')
      .map(task => ({
        id: task.id,
        name: task.name,
        updated_at: task.updated_at,
        session_ids: this.deps.sessions.listSessions({ includeArchived: false })
          .filter(session => session.task_id === task.id && this.isSessionVisible(session))
          .map(session => session.id),
      }));
  }

  private visibleSessions(deviceId?: string): RemoteSession[] {
    return this.deps.sessions.listSessions({ includeArchived: false })
      .filter(session => this.isSessionVisible(session))
      .map(session => this.projectSession(session, deviceId));
  }

  private pendingInteractions(visibleSessionIds: Set<string>): RemoteInteraction[] {
    return this.deps.sessions.listPendingApprovals()
      .filter((record) => visibleSessionIds.has(record.sessionId))
      .map((record) => {
        const row = this.deps.db.prepare(
          'SELECT resource_revision FROM proxy_interactions WHERE session_id = ? AND interaction_id = ?',
        ).get(record.sessionId, record.id) as { resource_revision: number } | undefined;
        return projectRemoteInteraction(record, String(row?.resource_revision ?? 0));
      });
  }

  private projectQueueItems(entry: QueueEntry, deviceId?: string): RemoteQueueEntry['items'] {
    if (!entry.items?.length) return undefined;
    const projected = entry.items.flatMap((item) => this.projectInputItem(entry, item, deviceId));
    return projected.length > 0 ? projected : undefined;
  }

  private projectInputItem(
    entry: QueueEntry,
    item: InputItem,
    deviceId?: string,
  ): NonNullable<RemoteQueueEntry['items']> {
    if (item.type === 'text' && 'text' in item && typeof item.text === 'string') {
      if (item.text !== entry.text) return [];
      return [{ type: 'text', text: item.text }];
    }
    if ((item.type === 'localFile' || item.type === 'localImage') && 'path' in item && typeof item.path === 'string') {
      const handle = deviceId
        ? this.deps.attachments?.findHandle(deviceId, entry.sessionId, item.path)
        : null;
      return handle ? [{ type: 'attachment', attachment_id: handle }] : [];
    }
    return [];
  }

  private projectQueueContext(items?: MessageContextItem[]): RemoteQueueEntry['context_items'] {
    if (!items?.length) return undefined;
    const projected = items.flatMap((item) => {
      if (item.type === 'pastedText') {
        return [{ type: 'pasted_text' as const, text: item.text }];
      }
      return [];
    });
    return projected.length > 0 ? projected : undefined;
  }

  private projectQueueDocument(document?: QueueEntry['composerDocument']): RemoteQueueEntry['composer_document'] {
    if (!document?.segments?.length) return undefined;
    const nodes: Array<{ type: 'text'; text: string } | { type: 'reference'; handle_id: string }> = [];
    for (const segment of document.segments) {
      if (segment.type === 'text' && typeof segment.text === 'string') {
        nodes.push({ type: 'text', text: segment.text });
      } else if (segment.type === 'reference') {
        nodes.push({ type: 'reference', handle_id: segment.id });
      }
    }
    return nodes.length > 0 ? { type: 'document', nodes } : undefined;
  }

  private stateRevision(sessions: RemoteSession[]): string {
    return createHash('sha256').update(JSON.stringify(sessions.map(session => [
      session.id,
      session.revision,
      session.queue.revision,
    ]))).digest('hex').slice(0, 32);
  }
}

export function assertNoLeak(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const key of LEAK_KEYS) {
    if (new RegExp(`"${key}"\\s*:`).test(serialized)) {
      throw new Error(`Remote projection leaked field ${key}`);
    }
  }
}

function parseTranscriptCursor(cursor: string): number {
  const value = Number(cursor);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('invalid transcript cursor');
  return value;
}

function integerValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const number = integerValue(value);
  return number !== undefined && number >= 0 ? number : undefined;
}

function remoteText(value: string): string {
  return redactRemoteText(value).slice(0, 16_000);
}

function remoteName(value: string): string {
  return remoteText(value).slice(0, 256) || 'Unknown';
}

function commandStatus(value: unknown): 'running' | 'success' | 'error' {
  return value === 'success' || value === 'error' ? value : 'running';
}

function toolStatus(value: unknown): 'pending' | 'running' | 'success' | 'error' {
  return value === 'pending' || value === 'success' || value === 'error' ? value : 'running';
}

/** Keep the conversational spine intact when one turn contains hundreds of
 * activity updates. The closed protocol caps a page at MAX_ARRAY_ITEMS; user
 * and assistant messages plus terminal state always win over activity rows. */
export function capRemoteTranscriptItems(
  items: RemoteTranscriptItem[],
  limit = MAX_ARRAY_ITEMS,
): RemoteTranscriptItem[] {
  if (items.length <= limit) return items;
  const essential = new Set<number>();
  for (let index = 0; index < items.length; index += 1) {
    const kind = items[index]?.kind;
    if (kind === 'user' || kind === 'assistant' || kind === 'turn-end' || kind === 'error') {
      essential.add(index);
    }
  }
  if (essential.size >= limit) {
    const retained = [...essential].slice(-limit);
    return retained.map(index => items[index]!).filter(Boolean);
  }
  let remaining = limit - essential.size;
  for (let index = items.length - 1; index >= 0 && remaining > 0; index -= 1) {
    if (essential.has(index)) continue;
    essential.add(index);
    remaining -= 1;
  }
  return items.filter((_item, index) => essential.has(index));
}

export type { UserAgent };
