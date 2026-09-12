import { transcriptItemIdentity } from '@gian/chat-ui';
import type {
  AgentSpawnItem,
  AutoNoticeItem,
  CommandItem,
  MsgItem,
  TranscriptItem,
} from '@gian/chat-ui';
import type {
  CanonicalEvent,
  RemoteInteraction,
  RemoteSession,
  RemoteStatePatch,
  RemoteStateSnapshot,
  RemoteTask,
  RemoteTranscriptItem,
  StatePatch,
} from '@gian/remote-protocol';
import type { Executor } from '@gian/shared';
import type { RemoteHostEntry, RemoteUiState, TranscriptState } from './types.js';

export function applySnapshotToState(
  state: RemoteUiState,
  snapshot: RemoteStateSnapshot,
): RemoteUiState {
  const first = snapshot.sessions[0];
  const sessionIds = new Set(snapshot.sessions.map((session) => session.id));
  const currentView = state.view;
  const keepChat = currentView.kind === 'chat'
    && snapshot.sessions.some((session) => session.id === currentView.sessionId);
  return {
    ...state,
    auth: { kind: 'authenticated' },
    connection: { kind: 'online' },
    hosts: mergeSnapshotHost(state.hosts, snapshot),
    currentHostId: snapshot.host.id,
    workspaces: snapshot.workspaces,
    tasks: snapshot.tasks,
    sessions: snapshot.sessions,
    interactions: snapshot.interactions,
    transcripts: Object.fromEntries(
      Object.entries(state.transcripts).filter(([sessionId]) => sessionIds.has(sessionId)),
    ),
    drafts: Object.fromEntries(
      Object.entries(state.drafts).filter(([sessionId]) => sessionIds.has(sessionId)),
    ),
    ...(state.fileViewer && !sessionIds.has(state.fileViewer.handle.sessionId)
      ? { fileViewer: null, fileDownload: { status: 'idle' as const } }
      : {}),
    capabilities: snapshot.capabilities,
    catalogRevision: snapshot.catalog_revision,
    catalogInvalidated: state.catalog?.catalog_revision !== snapshot.catalog_revision,
    snapshotReceivedAt: Date.now(),
    view: keepChat
      ? state.view
      : first
        ? { kind: 'chat', sessionId: first.id }
        : { kind: 'empty' },
  };
}

export function applyCanonicalEvent(state: RemoteUiState, message: CanonicalEvent): RemoteUiState {
  const event = message.event;
  if (event.kind === 'session.updated') {
    const transcript = state.transcripts[event.session.id];
    return {
      ...state,
      sessions: upsertById(state.sessions, event.session),
      ...(transcript ? {
        transcripts: {
          ...state.transcripts,
          [event.session.id]: {
            ...transcript,
            streaming: state.connection.kind === 'online' && event.session.status === 'running',
          },
        },
      } : {}),
    };
  }
  if (event.kind === 'interaction.updated') {
    return { ...state, interactions: upsertById(state.interactions, event.interaction) };
  }
  if (event.kind === 'transcript.item') {
    const session = state.sessions.find((entry) => entry.id === event.session_id);
    return {
      ...state,
      transcripts: {
        ...state.transcripts,
        [event.session_id]: upsertTranscript(
          state.transcripts[event.session_id],
          event.item,
          executorForSession(session),
        ),
      },
    };
  }
  return state;
}

export function applyStatePatch(state: RemoteUiState, message: StatePatch): RemoteUiState {
  return mergeRemotePatch(state, message.patch);
}

export function mergeRemotePatch(state: RemoteUiState, patch: RemoteStatePatch): RemoteUiState {
  let next = { ...state };
  if (patch.workspaces) {
    next = {
      ...next,
      workspaces: upsertRemove(next.workspaces, patch.workspaces.upsert, patch.workspaces.remove_ids),
    };
  }
  if (patch.tasks) {
    next = {
      ...next,
      tasks: upsertRemove(next.tasks, patch.tasks.upsert, patch.tasks.remove_ids),
    };
  }
  if (patch.sessions) {
    const sessions = upsertRemove(next.sessions, patch.sessions.upsert, patch.sessions.remove_ids);
    const sessionIds = new Set(sessions.map((session) => session.id));
    const transcripts = Object.fromEntries(
      Object.entries(next.transcripts).filter(([sessionId]) => sessionIds.has(sessionId)),
    );
    const drafts = Object.fromEntries(
      Object.entries(next.drafts).filter(([sessionId]) => sessionIds.has(sessionId)),
    );
    const currentRemoved = next.view.kind === 'chat' && !sessionIds.has(next.view.sessionId);
    next = {
      ...next,
      sessions,
      transcripts,
      drafts,
      interactions: next.interactions.filter((interaction) => sessionIds.has(interaction.session_id)),
      ...(next.fileViewer && !sessionIds.has(next.fileViewer.handle.sessionId)
        ? { fileViewer: null, fileDownload: { status: 'idle' as const } }
        : {}),
      ...(currentRemoved
        ? { view: sessions[0] ? { kind: 'chat' as const, sessionId: sessions[0].id } : { kind: 'empty' as const } }
        : {}),
    };
  }
  if (patch.interactions) {
    next = {
      ...next,
      interactions: upsertRemove(next.interactions, patch.interactions.upsert, patch.interactions.remove_ids),
    };
  }
  if (patch.queues) {
    next = {
      ...next,
      sessions: next.sessions.map((session) => {
        const queue = patch.queues?.find((entry) => entry.session_id === session.id);
        return queue
          ? { ...session, queue: { revision: queue.queue_revision, entries: queue.entries } }
          : session;
      }),
    };
  }
  if (patch.capabilities) {
    next = { ...next, capabilities: patch.capabilities };
  }
  if (patch.catalog_invalidated) {
    next = {
      ...next,
      catalogInvalidated: true,
      catalogRevision: patch.catalog_invalidated.catalog_revision,
    };
  }
  return next;
}

export function applyTranscriptPage(
  state: RemoteUiState,
  sessionId: string,
  items: RemoteTranscriptItem[],
  exec: Executor,
  hasOlder: boolean,
  cursor?: string,
  prepend = false,
): RemoteUiState {
  const mapped = items.reduce<TranscriptItem[]>(
    (current, item) => applyRemoteTranscriptItem(current, item, exec),
    [],
  );
  const previous = state.transcripts[sessionId];
  const combined = prepend
    ? [...mapped, ...(previous?.items ?? [])]
    : mapped;
  const unique = combined.reduce<TranscriptItem[]>(
    (current, item) => upsertDisplayItem(current, item),
    [],
  );
  return {
    ...state,
    transcripts: {
      ...state.transcripts,
      [sessionId]: {
        items: unique,
        hydrated: true,
        streaming: state.connection.kind === 'online'
          && state.sessions.find((session) => session.id === sessionId)?.status === 'running',
        hasOlder,
        loadingOlder: false,
        ...(cursor ? { cursor } : {}),
        historyError: null,
      },
    },
  };
}

export function beginTranscriptLoad(
  state: RemoteUiState,
  sessionId: string,
  operation: 'initial' | 'older',
): RemoteUiState {
  const previous = state.transcripts[sessionId];
  return {
    ...state,
    transcripts: {
      ...state.transcripts,
      [sessionId]: {
        items: previous?.items ?? [],
        hydrated: operation === 'older' ? (previous?.hydrated ?? false) : false,
        streaming: previous?.streaming ?? false,
        hasOlder: previous?.hasOlder ?? false,
        loadingOlder: operation === 'older',
        ...(previous?.cursor ? { cursor: previous.cursor } : {}),
        historyError: null,
      },
    },
  };
}

export function failTranscriptLoad(
  state: RemoteUiState,
  sessionId: string,
  operation: 'initial' | 'older',
): RemoteUiState {
  const previous = state.transcripts[sessionId];
  return {
    ...state,
    transcripts: {
      ...state.transcripts,
      [sessionId]: {
        items: previous?.items ?? [],
        hydrated: previous?.hydrated ?? false,
        streaming: false,
        hasOlder: previous?.hasOlder ?? false,
        loadingOlder: false,
        ...(previous?.cursor ? { cursor: previous.cursor } : {}),
        historyError: { status: null, operation },
      },
    },
  };
}

export function applyRemoteTranscriptItem(
  items: TranscriptItem[],
  item: RemoteTranscriptItem,
  exec: Executor,
): TranscriptItem[] {
  if (item.kind === 'user') {
    return upsertDisplayItem(items, {
      kind: 'user', id: item.id, text: item.text, exec, ts: item.ts, turn: item.turn,
      ...(item.attachments?.length ? {
        attachments: item.attachments.map(attachment => ({
          name: attachment.name,
          mime: attachment.mime,
          url: attachment.id,
          size: attachment.size,
        })),
      } : {}),
    });
  }
  if (item.kind === 'assistant') {
    const next: MsgItem = {
      kind: 'assistant', id: item.id, text: item.text, exec, ts: item.ts, turn: item.turn,
    };
    const identity = transcriptItemIdentity(next);
    const index = items.findIndex((entry) => transcriptItemIdentity(entry) === identity);
    if (index < 0) return [...items, next];
    const previous = items[index];
    if (!previous || previous.kind !== 'assistant') return upsertDisplayItem(items, next);
    return replaceAt(items, index, {
      ...previous,
      text: item.delta ? previous.text + item.text : item.text,
      ts: Math.min(previous.ts, item.ts),
    });
  }
  if (item.kind === 'command') {
    const previous = findDisplayItem<CommandItem>(items, item, 'command');
    return upsertDisplayItem(items, {
      kind: 'command',
      id: item.id,
      command: previous?.command ?? 'Command',
      status: item.status,
      ...(item.exit_code !== undefined ? { exitCode: item.exit_code } : {}),
      stdout: previous?.stdout ?? '',
      ts: previous?.ts ?? item.ts,
      turn: item.turn,
    });
  }
  if (item.kind === 'file-change') {
    return upsertDisplayItem(items, {
      kind: 'tool', id: item.id, name: 'Files changed',
      summary: `${item.file_count} ${item.file_count === 1 ? 'file' : 'files'}`,
      status: 'success', ts: item.ts, turn: item.turn,
    });
  }
  if (item.kind === 'file-read') {
    return upsertDisplayItem(items, {
      kind: 'file-read', id: item.id, path: 'File', ts: item.ts, turn: item.turn,
    });
  }
  if (item.kind === 'file-search') {
    return upsertDisplayItem(items, {
      kind: 'file-search', id: item.id, pattern: 'Files', searchKind: item.search_kind,
      ...(item.match_count !== undefined ? { matchCount: item.match_count } : {}),
      ts: item.ts, turn: item.turn,
    });
  }
  if (item.kind === 'web-search') {
    return upsertDisplayItem(items, {
      kind: 'web-search', id: item.id, query: 'Web search',
      ...(item.result_count !== undefined ? { resultCount: item.result_count } : {}),
      ts: item.ts, turn: item.turn,
    });
  }
  if (item.kind === 'tool') {
    return upsertDisplayItem(items, {
      kind: 'tool', id: item.id, name: item.name, summary: '', status: item.status,
      ts: item.ts, turn: item.turn,
    });
  }
  if (item.kind === 'agent') {
    const previous = findDisplayItem<AgentSpawnItem>(items, item, 'agent-spawn');
    return upsertDisplayItem(items, {
      kind: 'agent-spawn', id: item.id, provider: exec,
      description: item.agent_type ?? 'Sub-agent', status: item.status,
      ...(item.agent_type ? { agentType: item.agent_type } : {}),
      ...(item.model ? { model: item.model } : {}),
      ...(item.background !== undefined ? { background: item.background } : {}),
      startedAt: previous?.startedAt ?? item.started_at,
      updatedAt: item.ts,
      ...(item.completed_at !== undefined ? { completedAt: item.completed_at } : {}),
      ts: previous?.ts ?? item.ts,
      turn: item.turn,
    });
  }
  if (item.kind === 'notice') {
    const notice: AutoNoticeItem = {
      kind: 'auto-notice', id: item.id, variant: 'notice', severity: item.severity,
      title: item.code, consecutive: 0, total: 0,
      ts: item.ts, turn: item.turn,
    };
    return upsertDisplayItem(items, notice);
  }
  if (item.kind === 'classifier-denied') {
    return upsertDisplayItem(items, {
      kind: 'auto-notice', id: item.id, variant: 'classifier-denied',
      action: 'Restricted action', reason: 'Blocked by policy',
      consecutive: item.consecutive, total: item.total, ts: item.ts, turn: item.turn,
    });
  }
  if (item.kind === 'circuit-breaker') {
    return upsertDisplayItem(items, {
      kind: 'auto-notice', id: item.id, variant: 'circuit-breaker', trigger: item.trigger,
      consecutive: item.consecutive, total: item.total, ts: item.ts, turn: item.turn,
    });
  }
  if (item.kind === 'turn-end') {
    return upsertDisplayItem(items, {
      kind: 'turn-end', id: item.id, text: '', outcome: item.outcome,
      turn_id: item.turn_id,
      ...(item.source_turn_id ? { source_turn_id: item.source_turn_id } : {}),
      ts: item.ts, turn: item.turn,
    });
  }
  if (item.kind === 'error') {
    return upsertDisplayItem(items, {
      kind: 'error', id: item.id, text: 'The agent stopped with an error.',
      ts: item.ts, turn: item.turn,
    });
  }
  return items;
}

function upsertTranscript(
  current: TranscriptState | undefined,
  item: RemoteTranscriptItem,
  exec: Executor,
): TranscriptState {
  const nextItems = applyRemoteTranscriptItem(current?.items ?? [], item, exec);
  return {
    items: nextItems,
    hydrated: true,
    streaming: item.kind !== 'turn-end' && item.kind !== 'error',
    hasOlder: current?.hasOlder ?? false,
    loadingOlder: false,
    ...(current?.cursor ? { cursor: current.cursor } : {}),
    historyError: null,
  };
}

function upsertDisplayItem(items: TranscriptItem[], item: TranscriptItem): TranscriptItem[] {
  const identity = transcriptItemIdentity(item);
  const index = items.findIndex((entry) => transcriptItemIdentity(entry) === identity);
  return index < 0 ? [...items, item] : replaceAt(items, index, item);
}

function replaceAt<T>(items: T[], index: number, item: T): T[] {
  return [...items.slice(0, index), item, ...items.slice(index + 1)];
}

function findDisplayItem<T extends TranscriptItem>(
  items: TranscriptItem[],
  remote: RemoteTranscriptItem,
  kind: T['kind'],
): T | undefined {
  return items.find((entry) => entry.turn === remote.turn && entry.id === remote.id && entry.kind === kind) as T | undefined;
}

function executorForSession(session: RemoteSession | undefined): Executor {
  return session?.agent.proxy || 'claude';
}

function mergeSnapshotHost(
  hosts: RemoteHostEntry[],
  snapshot: RemoteStateSnapshot,
): RemoteHostEntry[] {
  const previous = hosts.find((host) => host.id === snapshot.host.id);
  const entry: RemoteHostEntry = {
    id: snapshot.host.id,
    name: snapshot.host.name,
    online: true,
    sessionCount: snapshot.sessions.length,
    ...(previous?.lastSeenAt != null ? { lastSeenAt: previous.lastSeenAt } : {}),
    ...(previous?.latencyMs != null ? { latencyMs: previous.latencyMs } : {}),
  };
  const index = hosts.findIndex((host) => host.id === entry.id);
  if (index === -1) return [...hosts, entry];
  return [...hosts.slice(0, index), entry, ...hosts.slice(index + 1)];
}

function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  const index = list.findIndex((entry) => entry.id === item.id);
  if (index === -1) return [...list, item];
  return [...list.slice(0, index), item, ...list.slice(index + 1)];
}

function upsertRemove<T extends { id: string }>(
  list: T[],
  upsert: T[] | undefined,
  removeIds: string[] | undefined,
): T[] {
  const removed = new Set(removeIds ?? []);
  const next = list.filter((item) => !removed.has(item.id));
  for (const item of upsert ?? []) {
    const index = next.findIndex((entry) => entry.id === item.id);
    if (index === -1) next.push(item);
    else next[index] = item;
  }
  return next;
}

export type { RemoteInteraction, RemoteSession, RemoteTask };
