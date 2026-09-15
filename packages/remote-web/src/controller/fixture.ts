/**
 * Fixture implementation of `RemoteUiController` — the single driver for all
 * component tests and screenshots. It implements the real contract (mutation
 * state machine, revision preconditions, queue replacement on conflict,
 * per-Host state partitioning) with scripted outcomes instead of a transport.
 *
 * Nothing here fakes a production success path: the production controller
 * (relay/E2EE/cache adapter) is a separate typed integration point.
 *
 * Mutation lifecycle: an action creates a pending command; only
 * `test.resolveNext/resolveAll` settles it (a relay ACK never would). The
 * canonical effect applies at settle time — never optimistically.
 */

import type { MsgItem, TranscriptItem } from '@gian/chat-ui';
import {
  generateCanonicalId,
  type EffectiveCapabilities,
  type RemoteInteraction,
  type RemoteQueueEntry,
  type RemoteSession,
  type RemoteTask,
} from '@gian/remote-protocol';
import type {
  AuthState,
  ConnectionState,
  CreateSessionInput,
  DraftAttachment,
  DraftContextItem,
  DraftDocument,
  FileViewerState,
  InteractionPhase,
  MainView,
  MobilePage,
  PairingFailure,
  RemoteCatalog,
  RemoteFileHandle,
  RemoteHostEntry,
  RemoteUiActions,
  RemoteUiController,
  RemoteUiState,
} from './types.js';
import { emptyDraft, mutationsEnabled } from './types.js';

// ---------------------------------------------------------------------------
// Scenario / scripting
// ---------------------------------------------------------------------------

export type ScriptedOutcome = 'success' | 'error' | 'unknown';

export interface FixtureScenario {
  auth?: AuthState;
  connection?: ConnectionState;
  hosts?: RemoteHostEntry[];
  currentHostId?: string | null;
  /** Per-Host partitioned state; keyed by host id. Hosts without an entry
   *  get a default empty workspace. */
  hostData?: Record<string, HostData>;
  view?: MainView;
  mobilePage?: MobilePage;
  queueNotice?: RemoteUiState['queueNotice'];
  fileViewer?: FileViewerState | null;
  unknownCommandId?: string | null;
  settings?: RemoteUiState['settings'];
  snapshotReceivedAt?: number | null;
}

export interface HostData {
  workspaces?: Array<{ id: string; name: string }>;
  tasks?: RemoteTask[];
  sessions?: RemoteSession[];
  interactions?: RemoteInteraction[];
  interactionPhases?: Record<string, InteractionPhase>;
  capabilities?: EffectiveCapabilities;
  catalogRevision?: string;
  catalog?: RemoteCatalog | null;
  catalogInvalidated?: boolean;
  snapshotReceivedAt?: number | null;
  transcripts?: Record<string, TranscriptItem[]>;
  transcriptsStreaming?: Record<string, boolean>;
}

export interface FixtureTestHooks {
  /** Settle the oldest pending mutation. Without an explicit outcome the
   *  scripted outcome for that command's op kind is used. */
  resolveNext(outcome?: ScriptedOutcome, errorMessage?: string): void;
  resolveAll(outcome?: ScriptedOutcome): void;
  /** Pending command ids, oldest first (assertion aid). */
  pendingCommandIds(): string[];
  /** Make the next queue mutation settle with PRECONDITION_FAILED; the queue
   *  is then replaced wholesale by the Host's canonical queue (§14). */
  failNextQueueMutation(replacement: RemoteQueueEntry[], revision: string): void;
  scriptSend(outcome: ScriptedOutcome): void;
  scriptCreate(outcome: ScriptedOutcome, errorMessage?: string): void;
  scriptRespond(outcome: ScriptedOutcome): void;
  /** Drive connection changes (relay notices / resync lifecycle). */
  setConnection(connection: ConnectionState): void;
  /** Host-side: another device resolved an interaction. */
  resolveInteractionElsewhere(interactionId: string): void;
  /** Host-side: an interaction expired. */
  expireInteraction(interactionId: string): void;
  /** Pairing outcomes while waiting. */
  pairingFail(reason: PairingFailure): void;
  pairingSucceed(): void;
  /** File viewer resolution control (openFile stays 'loading' until called
   *  when `autoResolveFile` is false). */
  resolveFile(viewer: FileViewerState): void;
  setDownload(pct: number): void;
  failDownload(message: string): void;
  /** Catalog invalidation notice from a state.patch. */
  invalidateCatalog(): void;
  refreshCatalogResult(catalog: RemoteCatalog): void;
}

export interface FixtureController extends RemoteUiController {
  readonly test: FixtureTestHooks;
  /** When true (default), openFile resolves immediately to `scriptedFile`. */
  autoResolveFile: boolean;
  scriptedFile: FileViewerState;
}

// ---------------------------------------------------------------------------
// Sample data builders (shared by tests and screenshot scenarios)
// ---------------------------------------------------------------------------

let seq = 0;
function id(prefix: string): string {
  seq += 1;
  return `${prefix}-${String(seq).padStart(4, '0')}`;
}

export function sampleHosts(): RemoteHostEntry[] {
  return [
    { id: 'host-home', name: 'MacBook Pro · 家里', online: true, sessionCount: 3, latencyMs: 84 },
    { id: 'host-work', name: 'iMac · 公司', online: true, sessionCount: 3 },
    { id: 'host-lab', name: '旧 ThinkPad · 实验室', online: false, sessionCount: 0, lastSeenAt: Date.now() - 2 * 86400_000 },
  ];
}

export function sampleQueueEntry(text: string, sessionId: string): RemoteQueueEntry {
  return {
    id: id('q'),
    session_id: sessionId,
    text,
    created_at: new Date().toISOString(),
  };
}

export function sampleSession(partial: Partial<RemoteSession> & { id: string }): RemoteSession {
  return {
    revision: 'rev-1',
    name: null,
    task_id: null,
    workspace_id: 'ws-1',
    agent: { id: 'agent-codex', name: 'Codex', proxy: 'codex' },
    model: 'gpt-5.3-codex',
    thinking: 'medium',
    service_tier: null,
    status: 'done',
    unread: false,
    queue: { revision: 'qrev-1', entries: [] },
    updated_at: new Date().toISOString(),
    ...partial,
  };
}

export function sampleTasks(): RemoteTask[] {
  return [
    { id: 'task-1', name: 'Gian 0.5.4 发布', updated_at: new Date().toISOString(), session_ids: ['s-1', 's-2'] },
    { id: 'task-2', name: '数据同步问题排查', updated_at: new Date().toISOString(), session_ids: ['s-3'] },
  ];
}

export function sampleSessions(): RemoteSession[] {
  return [
    sampleSession({
      id: 's-1',
      name: 'pre-push hook 接入 verify:quick',
      task_id: 'task-1',
      status: 'running',
      active_turn: { id: 'turn-1', turn_number: 3 },
      queue: {
        revision: 'qrev-1',
        entries: [
          sampleQueueEntry('hook 里别忘了加 --base 参数', 's-1'),
          sampleQueueEntry('跑完把 README 的「验证」一节也更新一下', 's-1'),
        ],
      },
    }),
    sampleSession({ id: 's-2', name: 'Remote Web 协议 §12 走查', task_id: 'task-1', status: 'pending' }),
    sampleSession({ id: 's-3', name: '模型结果复核', task_id: 'task-2', status: 'done', unread: true }),
  ];
}

export function sampleCatalog(): RemoteCatalog {
  return {
    catalog_revision: 'cat-1',
    workspaces: [
      { id: 'ws-1', name: '~/Coding/Gian-Dev' },
      { id: 'ws-2', name: '~/Coding/notes' },
    ],
    agents: [
      {
        id: 'agent-codex', name: 'Codex', proxy: 'codex', readiness: 'ready',
        defaults: { model: 'gpt-5.3-codex', thinking: 'medium' },
        models: [
          { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', is_default: true, supported_thinking: ['medium', 'high'] },
          { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', is_default: false, supported_thinking: ['medium', 'high'] },
        ],
      },
      {
        id: 'agent-claude', name: 'Claude', proxy: 'claude', readiness: 'ready',
        defaults: { model: 'claude-sonnet-4.6', thinking: 'high' },
        models: [
          { id: 'claude-sonnet-4.6', label: 'Claude Sonnet 4.6', is_default: true, supported_thinking: ['high'] },
        ],
      },
      { id: 'agent-kimi', name: 'Kimi', proxy: 'kimi', readiness: 'unavailable', models: [] },
    ],
    tasks: [
      { id: 'task-1', name: 'Gian 0.5.4 发布' },
      { id: 'task-2', name: '数据同步问题排查' },
    ],
  };
}

export function sampleCapabilities(): EffectiveCapabilities {
  return {
    'catalog.read': { state: 'supported' },
    'state.refresh': { state: 'supported' },
    'task.read': { state: 'supported' },
    'session.read': { state: 'supported' },
    'session.create': { state: 'supported' },
    'session.update': { state: 'supported' },
    'session.send': { state: 'supported' },
    'session.stop': { state: 'supported' },
    'queue.read': { state: 'supported' },
    'queue.add': { state: 'supported' },
    'queue.update': { state: 'supported' },
    'queue.remove': { state: 'supported' },
    'queue.clear': { state: 'supported' },
    'queue.send_now': { state: 'supported' },
    'turn.steer': { state: 'supported' },
    'interaction.read': { state: 'supported' },
    'interaction.respond': { state: 'supported' },
    'attachment.upload': { state: 'supported' },
    'attachment.read': { state: 'supported' },
    'file.read': { state: 'supported' },
    'file.download': { state: 'supported' },
    'composer.context': { state: 'supported' },
    'composer.document': { state: 'supported' },
  } as EffectiveCapabilities;
}

export function sampleTranscript(): TranscriptItem[] {
  const base = Date.now() - 600_000;
  return [
    {
      kind: 'status',
      id: id('st'),
      text: 'turn started',
      ts: base,
      turn: 1,
    },
    {
      kind: 'user',
      id: id('msg'),
      text: '把 verify:quick 挂到 pre-push hook 上',
      exec: 'codex',
      ts: base + 1_000,
      turn: 1,
    },
    {
      kind: 'assistant',
      id: id('msg'),
      text: '好，先看一下现有的 hook 和 `package.json` 里的脚本定义，然后把 gate 接上。',
      exec: 'codex',
      ts: base + 5_000,
      turn: 1,
    },
    {
      kind: 'tool',
      id: id('tool'),
      name: 'Bash',
      summary: 'ls .husky .git/hooks 2>/dev/null',
      status: 'running',
      ts: base + 8_000,
      turn: 1,
    } satisfies TranscriptItem,
  ];
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{4}-?[0-9A-HJKMNP-TV-Z]{4}$/i;

type QueueOp =
  | { kind: 'edit'; sessionId: string; queueId: string; text: string }
  | { kind: 'remove'; sessionId: string; queueId: string }
  | { kind: 'clear'; sessionId: string }
  | { kind: 'send-now'; sessionId: string };

type Op =
  | ({ op: 'queue' } & QueueOp)
  | { op: 'send'; sessionId: string; text: string; queued: boolean }
  | { op: 'create'; input: CreateSessionInput }
  | { op: 'respond'; interactionId: string }
  | { op: 'stop'; sessionId: string }
  | {
      op: 'session-config';
      sessionId: string;
      config: { model?: string; thinking?: string; service_tier?: 'standard' | 'fast'; approval_mode?: string };
    }
  | { op: 'other' };

export function createFixtureController(scenario: FixtureScenario = {}): FixtureController {
  const listeners = new Set<() => void>();
  let commandSeq = 0;
  const pending = new Map<string, Op>();
  let nextQueueConflict: { entries: RemoteQueueEntry[]; revision: string } | null = null;
  let sendOutcome: ScriptedOutcome = 'success';
  let createOutcome: { outcome: ScriptedOutcome; errorMessage?: string } = { outcome: 'success' };
  let respondOutcome: ScriptedOutcome = 'success';

  const hosts = scenario.hosts ?? sampleHosts();
  const currentHostId = scenario.currentHostId ?? hosts[0]?.id ?? null;
  const hostData = new Map<string, HostData>();
  for (const host of hosts) {
    hostData.set(host.id, scenario.hostData?.[host.id] ?? defaultHostData(host.id));
  }

  function defaultHostData(hostId: string): HostData {
    if (hostId === hosts[0]?.id) {
      return {
        workspaces: sampleCatalog().workspaces,
        tasks: sampleTasks(),
        sessions: sampleSessions(),
        interactions: [],
        capabilities: sampleCapabilities(),
        catalogRevision: 'cat-1',
        catalog: sampleCatalog(),
        snapshotReceivedAt: Date.now(),
        transcripts: { 's-1': sampleTranscript() },
        transcriptsStreaming: { 's-1': true },
      };
    }
    return {
      workspaces: [{ id: `ws-${hostId}`, name: `~/work/${hostId}` }],
      tasks: [],
      sessions: [],
      interactions: [],
      capabilities: sampleCapabilities(),
      catalogRevision: 'cat-1',
      catalog: sampleCatalog(),
      snapshotReceivedAt: Date.now(),
      transcripts: {},
    };
  }

  function loadHost(hostId: string | null): HostData {
    const data = (hostId && hostData.get(hostId)) || {};
    // Fill sane defaults so partial scenario entries stay usable.
    return {
      capabilities: sampleCapabilities(),
      catalog: sampleCatalog(),
      catalogRevision: 'cat-1',
      snapshotReceivedAt: Date.now(),
      ...data,
      workspaces: data.workspaces ?? [],
      tasks: data.tasks ?? [],
      sessions: data.sessions ?? [],
      interactions: data.interactions ?? [],
      transcripts: data.transcripts ?? {},
    };
  }

  const initial = loadHost(currentHostId);

  let state: RemoteUiState = {
    auth: scenario.auth ?? { kind: 'authenticated' },
    connection: scenario.connection ?? { kind: 'online' },
    hosts,
    currentHostId,
    workspaces: initial.workspaces ?? [],
    tasks: initial.tasks ?? [],
    sessions: initial.sessions ?? [],
    interactions: initial.interactions ?? [],
    interactionPhases: initial.interactionPhases ?? {},
    capabilities: initial.capabilities ?? {},
    catalogRevision: initial.catalogRevision ?? '',
    catalog: initial.catalog ?? null,
    catalogInvalidated: initial.catalogInvalidated ?? false,
    snapshotReceivedAt: scenario.snapshotReceivedAt !== undefined
      ? scenario.snapshotReceivedAt
      : initial.snapshotReceivedAt ?? null,
    view: scenario.view ?? (initial.sessions?.length
      ? { kind: 'chat', sessionId: initial.sessions[0]!.id }
      : { kind: 'empty' }),
    mobilePage: scenario.mobilePage ?? 'chat',
    transcripts: transcriptsOf(initial),
    drafts: {},
    queueNotice: scenario.queueNotice ?? null,
    fileViewer: scenario.fileViewer ?? null,
    fileDownload: { status: 'idle' },
    mutations: {},
    unknownCommandId: scenario.unknownCommandId ?? null,
    settings: scenario.settings ?? { theme: 'light', accent: 'plum' },
  };

  function transcriptsOf(data: HostData): RemoteUiState['transcripts'] {
    return Object.fromEntries(
      Object.entries(data.transcripts ?? {}).map(([sid, items]) => [
        sid,
        {
          items,
          hydrated: true,
          streaming: data.transcriptsStreaming?.[sid] ?? false,
          hasOlder: false,
          loadingOlder: false,
          historyError: null,
        },
      ]),
    );
  }

  function update(patch: Partial<RemoteUiState>): void {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }

  function emit(): void {
    for (const listener of listeners) listener();
  }

  function startMutation(label: string, op: Op): string {
    commandSeq += 1;
    const commandId = `cmd-${String(commandSeq).padStart(4, '0')}`;
    pending.set(commandId, op);
    update({
      mutations: {
        ...state.mutations,
        [commandId]: { commandId, label, phase: 'pending', startedAt: Date.now() },
      },
    });
    return commandId;
  }

  function scriptedFor(op: Op): { outcome: ScriptedOutcome; errorMessage?: string } {
    if (op.op === 'send') return { outcome: sendOutcome };
    if (op.op === 'create') return createOutcome;
    if (op.op === 'respond') return { outcome: respondOutcome };
    return { outcome: 'success' };
  }

  /** Canonical settlement — only ever called from the (fixture) transport
   *  side via the test hooks, never optimistically. */
  function settle(commandId: string, outcome: ScriptedOutcome, errorMessage?: string): void {
    const record = state.mutations[commandId];
    const op = pending.get(commandId);
    if (!record || !op) return;
    pending.delete(commandId);

    // Queue conflict: PRECONDITION_FAILED replaces the queue wholesale with
    // the Host's canonical queue and flags the notice (§14).
    if (op.op === 'queue' && nextQueueConflict) {
      const conflict = nextQueueConflict;
      nextQueueConflict = null;
      const session = sessionById(op.sessionId);
      if (session) {
        replaceSession({ ...session, queue: { revision: conflict.revision, entries: conflict.entries } });
      }
      finishRecord(record, 'failed', 'PRECONDITION_FAILED', 'queue revision mismatch');
      update({ queueNotice: { kind: 'replaced-remotely' } });
      return;
    }

    finishRecord(
      record,
      outcome === 'success' ? 'succeeded' : outcome === 'unknown' ? 'unknown' : 'failed',
      outcome === 'error' ? 'COMMAND_FAILED' : outcome === 'unknown' ? 'UNKNOWN_OUTCOME' : undefined,
      errorMessage,
    );
    if (outcome === 'unknown') {
      update({ unknownCommandId: commandId });
    }
    if (outcome !== 'success') {
      if (op.op === 'respond') {
        update({ interactionPhases: { ...state.interactionPhases, [op.interactionId]: 'pending' } });
      }
      return;
    }
    applyCanonicalEffect(op);
  }

  function finishRecord(
    record: { commandId: string; label: string; startedAt: number },
    phase: 'succeeded' | 'failed' | 'unknown',
    errorCode?: string,
    errorMessage?: string,
  ): void {
    update({
      mutations: {
        ...state.mutations,
        [record.commandId]: { ...record, phase, errorCode, errorMessage },
      },
    });
  }

  function applyCanonicalEffect(op: Op): void {
    switch (op.op) {
      case 'queue': {
        const session = sessionById(op.sessionId);
        if (!session) return;
        let entries = session.queue.entries;
        if (op.kind === 'edit') {
          entries = entries.map((e) => (e.id === op.queueId ? { ...e, text: op.text } : e));
        } else if (op.kind === 'remove') {
          entries = entries.filter((e) => e.id !== op.queueId);
        } else if (op.kind === 'clear' || op.kind === 'send-now') {
          entries = [];
        }
        replaceSession({ ...session, queue: { revision: `${session.queue.revision}+1`, entries } });
        update({ queueNotice: null });
        return;
      }
      case 'send': {
        const session = sessionById(op.sessionId);
        if (!session) return;
        if (op.queued) {
          replaceSession({
            ...session,
            queue: {
              revision: `${session.queue.revision}+1`,
              entries: [...session.queue.entries, sampleQueueEntry(op.text, session.id)],
            },
          });
        } else {
          const transcript = state.transcripts[op.sessionId];
          if (transcript) {
            update({
              transcripts: {
                ...state.transcripts,
                [op.sessionId]: {
                  ...transcript,
                  items: [
                    ...transcript.items,
                    {
                      kind: 'user',
                      id: id('msg'),
                      text: op.text,
                      exec: session.agent.proxy as MsgItem['exec'],
                      ts: Date.now(),
                      turn: (session.active_turn?.turn_number ?? 0) + 1,
                    },
                  ],
                },
              },
            });
          }
          replaceSession({
            ...session,
            status: 'running',
            active_turn: { id: id('turn'), turn_number: (session.active_turn?.turn_number ?? 0) + 1 },
          });
        }
        return;
      }
      case 'create': {
        const session = sampleSession({
          id: id('s'),
          name: op.input.name ?? null,
          task_id: op.input.taskId,
          workspace_id: op.input.workspaceId,
          status: 'new',
        });
        // Enter chat only with the canonical Host session in hand.
        update({
          sessions: [...state.sessions, session],
          view: { kind: 'chat', sessionId: session.id },
          mobilePage: 'chat',
        });
        return;
      }
      case 'respond': {
        // The interaction stays in the snapshot with a resolved phase so the
        // transcript can render the compressed resolved line.
        update({
          interactionPhases: { ...state.interactionPhases, [op.interactionId]: 'resolved-here' },
        });
        return;
      }
      case 'stop': {
        const session = sessionById(op.sessionId);
        if (!session) return;
        const next = { ...session, status: 'done' as const };
        delete next.active_turn;
        replaceSession(next);
        return;
      }
      case 'session-config': {
        const session = sessionById(op.sessionId);
        if (!session) return;
        replaceSession({
          ...session,
          revision: `${session.revision}+1`,
          ...(op.config.model !== undefined ? { model: op.config.model } : {}),
          ...(op.config.thinking !== undefined ? { thinking: op.config.thinking } : {}),
          ...(op.config.service_tier !== undefined
            ? { service_tier: op.config.service_tier === 'fast' ? 'fast' : null }
            : {}),
          ...(op.config.approval_mode !== undefined ? { approval_mode: op.config.approval_mode } : {}),
        });
        return;
      }
      case 'other':
        return;
    }
  }

  function sessionById(sessionId: string): RemoteSession | undefined {
    return state.sessions.find((s) => s.id === sessionId);
  }

  function replaceSession(session: RemoteSession): void {
    update({ sessions: state.sessions.map((s) => (s.id === session.id ? session : s)) });
  }

  /** Mutations require an online connection (§7.4). The UI disables controls
   *  up-front; reaching this guard means a crafted/stale call and the action
   *  refuses without side effects. */
  function guardMutation(): boolean {
    return mutationsEnabled(state.connection);
  }

  function capability(capId: keyof EffectiveCapabilities): boolean {
    return state.capabilities[capId]?.state === 'supported';
  }

  const actions: RemoteUiActions = {
    restoreBrowserSession() {},

    selectHost(hostId) {
      if (hostId === state.currentHostId || !hostData.has(hostId)) return;
      const data = loadHost(hostId);
      // Per-Host partitioning: pending mutations, drafts, caches and the
      // queue notice never cross a Host switch (§5.9).
      pending.clear();
      const host = hosts.find((h) => h.id === hostId);
      state = {
        ...state,
        currentHostId: hostId,
        workspaces: data.workspaces ?? [],
        tasks: data.tasks ?? [],
        sessions: data.sessions ?? [],
        interactions: data.interactions ?? [],
        interactionPhases: data.interactionPhases ?? {},
        capabilities: data.capabilities ?? {},
        catalogRevision: data.catalogRevision ?? '',
        catalog: data.catalog ?? null,
        catalogInvalidated: data.catalogInvalidated ?? false,
        snapshotReceivedAt: data.snapshotReceivedAt ?? null,
        transcripts: transcriptsOf(data),
        drafts: {},
        queueNotice: null,
        fileViewer: null,
        fileDownload: { status: 'idle' },
        mutations: {},
        unknownCommandId: null,
        view: data.sessions?.length ? { kind: 'chat', sessionId: data.sessions[0]!.id } : { kind: 'empty' },
        mobilePage: 'chat',
        connection: host?.online
          ? { kind: 'online' }
          : { kind: 'host_offline', lastSeenAt: host?.lastSeenAt ?? Date.now() },
      };
      emit();
    },

    selectSession(sessionId) {
      if (!sessionById(sessionId)) return;
      update({ view: { kind: 'chat', sessionId }, mobilePage: 'chat', fileViewer: null });
    },

    openNewChat(presetTaskId) {
      update({ view: { kind: 'new-chat', presetTaskId }, mobilePage: 'new-chat' });
    },

    openSettings() {
      update({ view: { kind: 'settings' }, mobilePage: 'settings' });
    },

    openMobilePage(page) {
      update({ mobilePage: page });
    },

    backToChat() {
      const view: MainView = state.view.kind === 'chat'
        ? state.view
        : state.sessions.length
          ? { kind: 'chat', sessionId: state.sessions[0]!.id }
          : { kind: 'empty' };
      update({ view, mobilePage: 'chat', fileViewer: null });
    },

    refreshCatalog() {
      if (!guardMutation() || !capability('catalog.read')) return;
      update({ catalogInvalidated: false });
    },

    createSession(input) {
      if (!guardMutation() || !capability('session.create')) return;
      if (!input.workspaceId || !input.agentId) return;
      if (state.catalogInvalidated) return;
      if (!state.catalog?.tasks.some((task) => task.id === input.taskId)) return;
      const agent = state.catalog?.agents.find((a) => a.id === input.agentId);
      if (!agent || agent.readiness !== 'ready') return;
      startMutation('session.create', { op: 'create', input });
    },

    setDraftText(sessionId, text) {
      const draft = state.drafts[sessionId] ?? emptyDraft();
      update({ drafts: { ...state.drafts, [sessionId]: { ...draft, text } } });
    },
    addDraftAttachment(sessionId, attachment: DraftAttachment) {
      const draft = state.drafts[sessionId] ?? emptyDraft();
      update({ drafts: { ...state.drafts, [sessionId]: { ...draft, attachments: [...draft.attachments, attachment] } } });
    },
    uploadDraftAttachment(sessionId, file) {
      actions.addDraftAttachment(sessionId, {
        id: generateCanonicalId(),
        name: file.name,
        mime: file.mime,
        size: file.size,
      });
    },
    addDraftContextItem(sessionId, item: DraftContextItem) {
      const draft = state.drafts[sessionId] ?? emptyDraft();
      update({ drafts: { ...state.drafts, [sessionId]: { ...draft, contextItems: [...draft.contextItems, item] } } });
    },
    setDraftDocument(sessionId, doc: DraftDocument | null) {
      const draft = state.drafts[sessionId] ?? emptyDraft();
      update({ drafts: { ...state.drafts, [sessionId]: { ...draft, document: doc } } });
    },
    removeDraftAttachment(sessionId, attachmentId) {
      const draft = state.drafts[sessionId] ?? emptyDraft();
      update({ drafts: { ...state.drafts, [sessionId]: { ...draft, attachments: draft.attachments.filter((a) => a.id !== attachmentId) } } });
    },
    removeDraftContextItem(sessionId, itemId) {
      const draft = state.drafts[sessionId] ?? emptyDraft();
      update({ drafts: { ...state.drafts, [sessionId]: { ...draft, contextItems: draft.contextItems.filter((c) => c.id !== itemId) } } });
    },

    sendDraft(sessionId) {
      if (!guardMutation() || !capability('session.send')) return;
      const session = sessionById(sessionId);
      const draft = state.drafts[sessionId] ?? emptyDraft();
      if (!session) return;
      if (draft.text.trim() === '' && draft.attachments.length === 0 && draft.contextItems.length === 0 && !draft.document) return;
      const queued = Boolean(session.active_turn);
      startMutation('session.send', { op: 'send', sessionId, text: draft.text, queued });
      // The draft clears once the command is accepted for transport; the
      // canonical result settles the mutation later.
      update({ drafts: { ...state.drafts, [sessionId]: emptyDraft() } });
    },

    stopSession(sessionId) {
      if (!guardMutation() || !capability('session.stop')) return;
      const session = sessionById(sessionId);
      if (!session?.active_turn) return;
      startMutation('session.stop', { op: 'stop', sessionId });
    },

    updateSessionConfig(sessionId, config) {
      if (!guardMutation() || !capability('session.update')) return;
      // Match production: keep the visible Session unchanged until the
      // canonical command result arrives from the Host.
      if (!sessionById(sessionId)) return;
      startMutation('session.update', { op: 'session-config', sessionId, config });
    },

    retryTranscript() {},

    loadOlderTranscript() {},

    editQueueEntry(sessionId, queueId, text) {
      if (!guardMutation() || !capability('queue.update')) return;
      if (!sessionById(sessionId)?.queue.entries.some((e) => e.id === queueId)) return;
      startMutation('queue.update', { op: 'queue', kind: 'edit', sessionId, queueId, text });
    },

    removeQueueEntry(sessionId, queueId) {
      if (!guardMutation() || !capability('queue.remove')) return;
      startMutation('queue.remove', { op: 'queue', kind: 'remove', sessionId, queueId });
    },

    clearQueue(sessionId) {
      if (!guardMutation() || !capability('queue.clear')) return;
      startMutation('queue.clear', { op: 'queue', kind: 'clear', sessionId });
    },

    sendQueueNow(sessionId) {
      if (!guardMutation() || !capability('queue.send_now')) return;
      startMutation('queue.send_now', { op: 'queue', kind: 'send-now', sessionId });
    },

    respondToInteraction(interactionId, actionId, values) {
      if (!guardMutation() || !capability('interaction.respond')) return;
      const interaction = state.interactions.find((i) => i.id === interactionId);
      if (!interaction) return;
      // Crafted-callback guard: the action id must be one the Host offered,
      // and a non-pending card never responds twice.
      if (!interaction.presentation.actions.some((a) => a.id === actionId)) return;
      const phase = state.interactionPhases[interactionId] ?? 'pending';
      if (phase !== 'pending') return;
      void values;
      startMutation('interaction.respond', { op: 'respond', interactionId });
      update({ interactionPhases: { ...state.interactionPhases, [interactionId]: 'responding' } });
    },

    openFile(handle: RemoteFileHandle) {
      if (!capability('file.read')) return;
      update({
        fileViewer: { status: 'loading', handle },
        mobilePage: state.mobilePage === 'chat' || state.mobilePage === 'file' ? 'file' : state.mobilePage,
        fileDownload: { status: 'idle' },
      });
      if (controller.autoResolveFile) {
        update({ fileViewer: { ...controller.scriptedFile, handle } as FileViewerState });
      }
    },

    closeFile() {
      update({
        fileViewer: null,
        fileDownload: { status: 'idle' },
        mobilePage: state.mobilePage === 'file' ? 'chat' : state.mobilePage,
      });
    },

    reloadFile() {
      const viewer = state.fileViewer;
      if (!viewer) return;
      update({ fileViewer: { status: 'loading', handle: viewer.handle } });
      if (controller.autoResolveFile) {
        update({ fileViewer: { ...controller.scriptedFile, handle: viewer.handle } as FileViewerState });
      }
    },

    downloadFile() {
      if (!state.fileViewer || !capability('file.download')) return;
      update({ fileDownload: { status: 'downloading', pct: 0 } });
    },

    refreshState() {
      if (!capability('state.refresh')) return;
      // Fixture: a refresh settles unknown outcomes against the canonical
      // state; it never retries the command.
      update({ unknownCommandId: null });
    },

    dismissUnknown(commandId) {
      update({ unknownCommandId: state.unknownCommandId === commandId ? null : state.unknownCommandId });
    },

    setTheme(theme) {
      update({ settings: { ...state.settings, theme } });
    },
    setAccent(accent) {
      update({ settings: { ...state.settings, accent } });
    },

    disconnectHost(hostId) {
      const remaining = state.hosts.filter((h) => h.id !== hostId);
      hostData.delete(hostId);
      if (state.currentHostId === hostId) {
        const next = remaining.find((h) => h.online) ?? remaining[0];
        update({ hosts: remaining });
        if (next) actions.selectHost(next.id);
        else update({
          currentHostId: null,
          auth: { kind: 'pairing', pairing: { kind: 'enter-code', attemptsLeft: 5 } },
        });
      } else {
        update({ hosts: remaining });
      }
    },

    logoutBrowser() {
      // Ends only this browser's refresh family + decrypted caches; the
      // Host-scoped pairing keys remain, so re-entry is a device-key
      // challenge login, not a new pairing (§5.6).
      update({ auth: { kind: 'challenge-login', hosts: state.hosts } });
    },

    submitPairingCode(code) {
      if (state.auth.kind !== 'pairing') return;
      const pairing = state.auth.pairing;
      if (pairing.kind !== 'enter-code') return;
      if (!CROCKFORD.test(code.trim())) {
        const attemptsLeft = pairing.attemptsLeft - 1;
        update({
          auth: {
            kind: 'pairing',
            pairing: attemptsLeft <= 0
              ? { kind: 'failed', reason: 'attempt-limit' }
              : { kind: 'failed', reason: 'invalid' },
          },
        });
        return;
      }
      update({
        auth: {
          kind: 'pairing',
          pairing: { kind: 'waiting', deviceName: 'This browser', expiresAt: Date.now() + 300_000 },
        },
      });
    },

    setPairingDeviceName(name) {
      if (state.auth.kind === 'pairing' && state.auth.pairing.kind === 'qr-confirm') {
        update({ auth: { kind: 'pairing', pairing: { ...state.auth.pairing, deviceName: name } } });
      }
    },

    confirmQrPairing() {
      if (state.auth.kind === 'pairing' && state.auth.pairing.kind === 'qr-confirm') {
        const { deviceName } = state.auth.pairing;
        update({
          auth: { kind: 'pairing', pairing: { kind: 'waiting', deviceName, expiresAt: Date.now() + 300_000 } },
        });
      }
    },

    cancelPairing() {
      if (state.auth.kind === 'pairing') {
        update({ auth: { kind: 'pairing', pairing: { kind: 'failed', reason: 'cancelled' } } });
      }
    },

    restartPairing() {
      update({ auth: { kind: 'pairing', pairing: { kind: 'enter-code', attemptsLeft: 5 } } });
    },

    challengeLogin(hostId) {
      if (state.auth.kind !== 'challenge-login') return;
      update({ auth: { kind: 'authenticated' } });
      if (hostId !== state.currentHostId) actions.selectHost(hostId);
    },
  };

  const controller: FixtureController = {
    autoResolveFile: true,
    scriptedFile: {
      status: 'ready',
      handle: { id: 'file-1', sessionId: 's-1', label: 'pre-push', dirLabel: '.husky/' },
      text: '#!/bin/sh\n# GianDev: push 前跑快速回归门\nset -e\n\npnpm verify:quick -- --base origin/main\n',
      sizeLabel: '128 B',
    },
    test: {
      resolveNext(outcome, errorMessage) {
        const [commandId, op] = pending.entries().next().value ?? [];
        if (!commandId || !op) throw new Error('no pending mutation to resolve');
        const scripted = scriptedFor(op);
        settle(commandId, outcome ?? scripted.outcome, errorMessage ?? scripted.errorMessage);
        if (op.op === 'send') sendOutcome = 'success';
        if (op.op === 'create') createOutcome = { outcome: 'success' };
        if (op.op === 'respond') respondOutcome = 'success';
      },
      resolveAll(outcome) {
        while (pending.size > 0) {
          const [commandId, op] = pending.entries().next().value as [string, Op];
          const scripted = scriptedFor(op);
          settle(commandId, outcome ?? scripted.outcome, scripted.errorMessage);
        }
      },
      pendingCommandIds() {
        return [...pending.keys()];
      },
      failNextQueueMutation(entries, revision) {
        nextQueueConflict = { entries, revision };
      },
      scriptSend(outcome) {
        sendOutcome = outcome;
      },
      scriptCreate(outcome, errorMessage) {
        createOutcome = { outcome, errorMessage };
      },
      scriptRespond(outcome) {
        respondOutcome = outcome;
      },
      setConnection(connection) {
        update({ connection });
      },
      resolveInteractionElsewhere(interactionId) {
        update({
          interactionPhases: { ...state.interactionPhases, [interactionId]: 'resolved-elsewhere' },
        });
      },
      expireInteraction(interactionId) {
        update({
          interactionPhases: { ...state.interactionPhases, [interactionId]: 'expired' },
        });
      },
      pairingFail(reason) {
        if (state.auth.kind !== 'pairing') return;
        update({ auth: { kind: 'pairing', pairing: { kind: 'failed', reason } } });
      },
      pairingSucceed() {
        update({ auth: { kind: 'authenticated' } });
      },
      resolveFile(viewer) {
        update({ fileViewer: viewer });
      },
      setDownload(pct) {
        update({ fileDownload: { status: 'downloading', pct } });
      },
      failDownload(message) {
        update({ fileDownload: { status: 'error', message } });
      },
      invalidateCatalog() {
        update({ catalogInvalidated: true });
      },
      refreshCatalogResult(catalog) {
        update({ catalog, catalogRevision: catalog.catalog_revision, catalogInvalidated: false });
      },
    },
    get state() {
      return state;
    },
    actions,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return controller;
}
