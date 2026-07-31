/** Build the shared Slack/Discord adapter from Gian's domain services. */

import type { Session, Workspace } from '@gian/shared';
import type { Db } from '../storage/db.js';
import type { SessionManager } from '../session/manager.js';
import type { ApprovalManager, ApprovalRecord } from '../approval/manager.js';
import type {
  AgentExecutor,
  ModelOption,
  PendingApproval,
  ReasoningEffort,
  MessagingSession,
  UserRecord,
  WorkspaceSummary,
} from './types.js';
import type {
  MessagingPlatformOptions,
  MessagingSessionCreateInput,
  MessagingSessionPatch,
} from './messaging/types.js';
import type { DiscordCodingRepository } from './discord/repository.js';
import type { SlackCodingRepository } from './slack/repository.js';
import { decryptDiscordSecret } from './discord/secrets.js';
import { decryptSlackSecret } from './slack/secrets.js';

// ---------------------------------------------------------------------------
// Bot rows retain an owner key for persistence, while Gian runs as one local
// authenticated user.
// ---------------------------------------------------------------------------

export const LOCAL_USER: UserRecord = {
  id: 'local',
  username: 'local',
};

// ---------------------------------------------------------------------------
// Shared projections used by both platform managers.
// ---------------------------------------------------------------------------

export function toMessagingSession(
  s: Session,
  workspacePath = s.workspace_id,
): MessagingSession {
  if (s.executor === 'kimi') {
    throw new Error('Kimi sessions are not exposed through IM.');
  }
  return {
    id: s.id,
    ownerUserId: LOCAL_USER.id,
    ownerUsername: LOCAL_USER.username,
    sessionType: 'code',
    threadId: s.native_session_id ?? s.id,
    activeTurnId: s.status === 'running' || s.status === 'pending'
      ? (s.native_session_id ?? s.id)
      : null,
    title: s.name ?? '(unnamed)',
    autoTitle: !s.name,
    workspace: workspacePath,
    workspaceId: s.workspace_id,
    archivedAt: s.archived === 1 ? s.updated_at : null,
    // IM module's ApprovalMode models only Gian's three interactive modes
    // (plan / ask / auto) — see im/types.ts. Codex-only permission presets
    // have no IM analogue (IM has no approval UI), so narrow them to auto.
    approvalMode: s.approval_mode === 'full-access' || s.approval_mode === 'custom'
      ? 'auto'
      : (s.approval_mode ?? 'ask'),
    status: toMessagingStatus(s.status),
    lastIssue: null,
    model: s.model,
    reasoningEffort: toReasoningEffort(s.thinking_effort),
    executor: s.executor,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  };
}

export function toWorkspaceSummary(w: Workspace): WorkspaceSummary {
  return {
    id: w.id,
    name: w.name,
    path: w.path,
    visible: true,
    sortOrder: w.sort_order,
  };
}

export function toPendingApproval(a: ApprovalRecord, executor: AgentExecutor): PendingApproval {
  return {
    id: a.id,
    sessionId: a.sessionId,
    rpcRequestId: a.id,
    method: a.category,
    title: a.description || a.category,
    risk: a.risk,
    scopeOptions: ['once', 'session'],
    source: executor,
    payload: a.payload ?? null,
    createdAt: new Date(a.createdAt).toISOString(),
  };
}

export function toModelOption(m: {
  id: string;
  model?: string;
  displayName?: string;
  description?: string;
  isDefault?: boolean;
  hidden?: boolean;
  // cc shape
  defaultEffort?: string | null;
  supportedEfforts?: string[];
  // codex shape
  defaultThinking?: string | null;
  supportedThinking?: string[];
}): ModelOption {
  // cc and codex use different field names for the same concept;
  // ProxyCapabilities is a discriminated union, so we accept both here and
  // let whichever is present win.
  const defaultRaw = m.defaultEffort ?? m.defaultThinking ?? null;
  const supportedRaw = m.supportedEfforts ?? m.supportedThinking ?? [];
  return {
    id: m.id,
    displayName: m.displayName ?? m.id,
    model: m.model ?? m.id,
    description: m.description ?? '',
    isDefault: m.isDefault ?? false,
    hidden: m.hidden ?? false,
    defaultReasoningEffort: toReasoningEffort(defaultRaw) ?? 'medium',
    supportedReasoningEfforts: supportedRaw.flatMap(e => {
      const r = toReasoningEffort(e);
      return r ? [r] : [];
    }),
  };
}

function toMessagingStatus(s: Session['status']): MessagingSession['status'] {
  switch (s) {
    case 'running': return 'running';
    case 'pending': return 'needs-approval';
    case 'error': return 'error';
    case 'new':
    case 'done':
    default: return 'idle';
  }
}

function toReasoningEffort(value: unknown): ReasoningEffort | null {
  if (typeof value !== 'string') return null;
  switch (value) {
    case 'off': return 'none';
    case 'minimal': return 'minimal';
    case 'low': return 'low';
    case 'medium': return 'medium';
    case 'high': return 'high';
    case 'max':
    case 'xhigh':
      return 'xhigh';
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Dependency bundle
// ---------------------------------------------------------------------------

export interface BuildIMOptionsDeps {
  sessions: SessionManager;
  approvals: ApprovalManager;
  db: Db;
  log?: { info(message: string): unknown; warn(message: string): unknown };
}

export interface IMOptionsBundle {
  /** Common to both platforms — passed to every Manager constructor. */
  shared: MessagingPlatformOptions;
  /** Per-platform extras. Discord just needs a repository; Slack needs the
   *  bot/app token decryptors as well. */
  discordExtras: { repository: DiscordCodingRepository };
  slackExtras: {
    repository: SlackCodingRepository;
    decryptBotToken: (ciphertext: string) => Promise<string>;
    decryptAppToken: (ciphertext: string) => Promise<string>;
  };
}

export function buildIMOptions(
  deps: BuildIMOptionsDeps,
  repos: {
    discord: DiscordCodingRepository;
    slack: SlackCodingRepository;
  },
): IMOptionsBundle {
  const { sessions, approvals, db } = deps;
  const log = deps.log ?? {
    info: (m: string) => console.log(`[im] ${m}`),
    warn: (m: string) => console.warn(`[im] ${m}`),
  };
  const toSession = (session: Session) => {
    const workspace = db.prepare('SELECT path FROM workspaces WHERE id = ?')
      .get(session.workspace_id) as { path: string } | undefined;
    return toMessagingSession(session, workspace?.path);
  };

  const shared: MessagingPlatformOptions = {
    log,

    // Discord uses generic `decryptToken`; Slack ignores this and uses its
    // own pair below.
    decryptToken: decryptDiscordSecret,

    // Single-user stubs — Gian has no multi-user routing.
    listUsers: () => [LOCAL_USER],

    listWorkspaces: async () => {
      const rows = db.prepare('SELECT * FROM workspaces ORDER BY sort_order, name').all() as Workspace[];
      return rows.map(toWorkspaceSummary);
    },

    getWorkspace: async (workspaceId: string) => {
      const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as Workspace | undefined;
      return row ? toWorkspaceSummary(row) : null;
    },

    listSessionsForWorkspace: async (workspaceId: string) => {
      return sessions
        .listSessions()
        .filter(s => s.workspace_id === workspaceId && s.executor !== 'kimi')
        .map(toSession);
    },

    getSession: async (sessionId: string) => {
      const session = trySessionForId(sessions, sessionId);
      return session && session.executor !== 'kimi'
        ? toSession(session)
        : null;
    },

    updateSession: async (sessionId: string, patch: MessagingSessionPatch) => {
      if (patch.model !== undefined && patch.model !== null) {
        sessions.setModel(sessionId, patch.model);
      }
      if (patch.reasoningEffort !== undefined) {
        sessions.setEffort(sessionId, patch.reasoningEffort === 'none'
          ? null
          : patch.reasoningEffort);
      }
      if (patch.approvalMode !== undefined) {
        sessions.setApprovalMode(sessionId, patch.approvalMode);
      }
      if (patch.archivedAt) {
        sessions.archiveSession(sessionId, true);
      }
      if (patch.title) {
        sessions.renameSession(sessionId, patch.title);
      }
      const updated = trySessionForId(sessions, sessionId);
      return updated && updated.executor !== 'kimi'
        ? toSession(updated)
        : null;
    },

    createSession: async (workspace, input?: MessagingSessionCreateInput) => {
      const created = await sessions.createSession({
        workspace_id: workspace.id,
        executor: input?.executor ?? 'claude',
        // IM channels can't surface approvals interactively yet, so default
        // to `auto` regardless of the optional mode hint.
        approval_mode: 'auto',
        ...(input?.title ? { name: input.title } : {}),
      });
      return toSession(created);
    },

    startTurn: async (session, prompt) => {
      await sessions.sendMessage(session.id, prompt ?? '');
    },

    queueTurn: async (session, prompt) => {
      sessions.enqueueMessage(session.id, prompt ?? '');
    },

    getQueueLength: (sessionId) => sessions.getQueueLength(sessionId),

    clearQueue: (sessionId) => sessions.clearQueue(sessionId),

    getApprovals: (sessionId: string) => {
      const session = trySessionForId(sessions, sessionId);
      if (session?.executor === 'kimi') return [];
      const executor = session?.executor ?? 'claude';
      return approvals
        .listPending()
        .filter(a => a.sessionId === sessionId && a.status === 'pending')
        .map(a => toPendingApproval(a, executor));
    },

    resolveApproval: async (session, approvalId, input) => {
      const decision: 'allow_once' | 'allow_session' | 'decline' =
        input.decision === 'decline'
          ? 'decline'
          : input.scope === 'session'
            ? 'allow_session'
            : 'allow_once';
      await sessions.respondApproval(session.id, approvalId, decision);
    },

    // model option lookups: capabilities cache only populates after a proxy
    // has been spawned for that executor in this host process. If empty,
    // kick off warmCapabilities (async, fire-and-forget) so the next call
    // succeeds — and synchronously return whatever's cached (often empty
    // on the first /alter, populated by the time the user retries).
    listModelOptions: (executor) => {
      const exec = (executor ?? 'claude') as 'claude' | 'codex';
      const caps = sessions.getCapabilities(exec);
      if (!caps) {
        void sessions.warmCapabilities(exec).catch(() => undefined);
        return [];
      }
      return caps.models.map(m => toModelOption(m as never));
    },

    currentDefaultModel: (executor) => {
      const exec = (executor ?? 'claude') as 'claude' | 'codex';
      const caps = sessions.getCapabilities(exec);
      if (!caps) {
        void sessions.warmCapabilities(exec).catch(() => undefined);
        return '';
      }
      const def = caps.models.find(m => m.isDefault) ?? caps.models[0];
      return def?.id ?? '';
    },

    findModelOption: (model, executor) => {
      if (!model) return null;
      const exec = (executor ?? 'claude') as 'claude' | 'codex';
      const caps = sessions.getCapabilities(exec);
      if (!caps) {
        void sessions.warmCapabilities(exec).catch(() => undefined);
        return null;
      }
      const m = caps.models.find(x => x.id === model || x.model === model);
      return m ? toModelOption(m as never) : null;
    },

    preferredReasoningEffortForModel: (modelOption) =>
      modelOption.defaultReasoningEffort ?? 'medium',

    interruptTurn: async (session) => {
      await sessions.stopTurn(session.id);
      return null;
    },

    isThreadUnavailableError: (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      return /THREAD_NOT_FOUND|SESSION_NOT_FOUND|stale|not\s+available/i.test(msg);
    },

    errorMessage: (err) =>
      err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err),

    availableExecutors: () => ['claude', 'codex'] as AgentExecutor[],

    normalizeExecutor: (value) =>
      value === 'codex' ? 'codex' : 'claude',
  };

  return {
    shared,
    discordExtras: { repository: repos.discord },
    slackExtras: {
      repository: repos.slack,
      decryptBotToken: decryptSlackSecret,
      decryptAppToken: decryptSlackSecret,
    },
  };
}

function trySessionForId(sessions: SessionManager, sessionId: string): Session | null {
  try {
    return sessions.getSession(sessionId);
  } catch {
    return null;
  }
}

// (No re-exports — translators removed.)
