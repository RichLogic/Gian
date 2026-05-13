/**
 * Adapter that constructs the rvc-shaped `MessagingPlatformOptions` from
 * Gian's domain services (SessionManager, ApprovalManager, DB). All
 * impedance between Gian's types and rvc's `SessionRecord` /
 * `PendingApproval` / `WorkspaceSummary` / etc. is contained here so the
 * copied IM code can run unchanged.
 *
 * Gian is single-user; rvc has a multi-user model. We hardcode a
 * `LOCAL_USER` constant and ignore userId everywhere it would otherwise
 * filter results.
 */

import { randomUUID } from 'node:crypto';
import type { Session, Workspace } from '@gian/shared';
import type { Db } from '../storage/db.js';
import type { SessionManager } from '../session/manager.js';
import type { ApprovalManager, ApprovalRecord } from '../approval/manager.js';
import type {
  AgentExecutor,
  ApprovalScope,
  ModelOption,
  PendingApproval,
  ReasoningEffort,
  SessionRecord,
  UserRecord,
  WorkspaceSummary,
} from './types.js';
import type {
  MessagingPlatformOptions,
  MessagingSessionCreateInput,
} from './messaging/types.js';
import type { DiscordCodingRepository } from './discord/repository.js';
import type { SlackCodingRepository } from './slack/repository.js';
import { decryptDiscordSecret } from './discord/secrets.js';
import { decryptSlackSecret } from './slack/secrets.js';

// ---------------------------------------------------------------------------
// Single-user placeholder — Gian doesn't have multi-user, so wire a stable
// stub so rvc's per-user routing compiles.
// ---------------------------------------------------------------------------

export const LOCAL_USER: UserRecord = {
  id: 'local',
  username: 'local',
  roles: ['admin', 'developer', 'user'],
  preferredMode: 'developer',
  isAdmin: true,
  allowedSessionTypes: ['code'],
  canUseFullHost: true,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
};

// ---------------------------------------------------------------------------
// Type translators (Gian → rvc). Manager.ts only reads the fields listed in
// the comments next to each helper, so we synthesize sensible defaults for
// the rvc fields Gian doesn't track.
// ---------------------------------------------------------------------------

/** Manager reads: id, threadId, title, workspace, workspaceId, executor,
 *  status, activeTurnId, archivedAt, lastIssue, origin, botId,
 *  executionMode, reasoningEffort, model, approvalMode. */
export function gianSessionToRvcRecord(s: Session): SessionRecord {
  return {
    id: s.id,
    ownerUserId: LOCAL_USER.id,
    ownerUsername: LOCAL_USER.username,
    sessionType: 'code',
    threadId: s.native_session_id ?? s.id,
    activeTurnId: null,
    title: s.name ?? '(unnamed)',
    autoTitle: !s.name,
    workspace: s.workspace_id,
    workspaceId: s.workspace_id,
    archivedAt: s.archived === 1 ? s.updated_at : null,
    securityProfile: 'repo-write',
    // IM module's ApprovalMode is now realigned to Gian's three modes
    // (plan / ask / auto) — see im/types.ts. No translation needed.
    approvalMode: s.approval_mode,
    networkEnabled: true,
    fullHostEnabled: false,
    status: gianSessionStatusToRvc(s.status),
    lastIssue: null,
    hasTranscript: true,
    model: s.model,
    reasoningEffort: gianEffortToRvc(s.thinking_effort),
    executor: s.executor,
    origin: s.active_channel === 'im' ? 'discord' : 'web',
    botId: null,
    executionMode: 'interactive',
    job: null,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  };
}

export function gianWorkspaceToRvcSummary(w: Workspace): WorkspaceSummary {
  return {
    id: w.id,
    name: w.name,
    path: w.path,
    visible: true,
    sortOrder: w.sort_order,
  };
}

export function gianApprovalToRvcPending(a: ApprovalRecord, executor: AgentExecutor): PendingApproval {
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

export function gianModelToRvcOption(m: {
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
    defaultReasoningEffort: gianEffortToRvc(defaultRaw) ?? 'medium',
    supportedReasoningEfforts: supportedRaw.flatMap(e => {
      const r = gianEffortToRvc(e);
      return r ? [r] : [];
    }),
  };
}

// Mode translation funcs removed — IM types.ts now uses Gian's
// 'plan' | 'ask' | 'auto' natively, no rvc dialect to translate.

function gianSessionStatusToRvc(s: Session['status']): SessionRecord['status'] {
  switch (s) {
    case 'running': return 'running';
    case 'pending': return 'needs-approval';
    case 'error': return 'error';
    case 'new':
    case 'done':
    default: return 'idle';
  }
}

function gianEffortToRvc(value: unknown): ReasoningEffort | null {
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
// The big one — build all 20+ injection points
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

  const shared: MessagingPlatformOptions = {
    log,

    // Discord uses generic `decryptToken`; Slack ignores this and uses its
    // own pair below.
    decryptToken: decryptDiscordSecret,

    // Single-user stubs — Gian has no multi-user routing.
    listUsers: () => [LOCAL_USER],

    listUserWorkspaces: async () => {
      const rows = db.prepare('SELECT * FROM workspaces ORDER BY sort_order, name').all() as Workspace[];
      return rows.map(gianWorkspaceToRvcSummary);
    },

    getWorkspaceForUser: async (workspaceId: string) => {
      const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as Workspace | undefined;
      return row ? gianWorkspaceToRvcSummary(row) : null;
    },

    listSessionsForWorkspace: async (_userId: string, workspaceId: string) => {
      return sessions
        .listSessions()
        .filter(s => s.workspace_id === workspaceId)
        .map(gianSessionToRvcRecord);
    },

    createSession: async (_user, workspace, _botId, input?: MessagingSessionCreateInput) => {
      const created = await sessions.createSession({
        workspace_id: workspace.id,
        executor: input?.executor ?? 'claude',
        // IM channels can't surface approvals interactively yet, so default
        // to `auto` regardless of the rvc `mode` hint. Phase 8 may revisit.
        approval_mode: 'auto',
        ...(input?.title ? { name: input.title } : {}),
      });
      return gianSessionToRvcRecord(created);
    },

    startTurnWithAutoRestart: async (session, prompt) => {
      await sessions.sendMessage(session.id, prompt ?? '');
      const updated = sessions.getSession(session.id);
      return {
        // rvc treats `turn` as opaque (`unknown`); manager only checks
        // truthiness. Synthesize a minimal placeholder.
        turn: { id: randomUUID(), status: 'running' },
        session: gianSessionToRvcRecord(updated),
      };
    },

    queueTurn: async (session, prompt) => {
      sessions.enqueueMessage(session.id, prompt ?? '');
    },

    getApprovals: (sessionId: string) => {
      const session = trySessionForId(sessions, sessionId);
      const executor = session?.executor ?? 'claude';
      return approvals
        .listPending()
        .filter(a => a.sessionId === sessionId && a.status === 'pending')
        .map(a => gianApprovalToRvcPending(a, executor));
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
      return caps.models.map(m => gianModelToRvcOption(m as never));
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
      return m ? gianModelToRvcOption(m as never) : null;
    },

    normalizeReasoningEffort: gianEffortToRvc,

    preferredReasoningEffortForModel: (modelOption) =>
      modelOption.defaultReasoningEffort ?? 'medium',

    restartSessionThread: async (session) => {
      // rvc concept: rotate the underlying thread but keep the session row.
      // Gian equivalent: send `/clear` which causes cc-proxy to emit
      // `session.rotated` and update native_session_id. Codex sessions don't
      // honor /clear the same way; for them we just no-op (next message
      // reuses the existing thread).
      const gianSession = sessions.getSession(session.id);
      if (gianSession.executor === 'claude') {
        await sessions.sendMessage(session.id, '/clear');
      }
      return gianSessionToRvcRecord(sessions.getSession(session.id));
    },

    interruptTurn: async (session) => {
      await sessions.stopTurn(session.id);
      return null;
    },

    isThreadUnavailableError: (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      return /THREAD_NOT_FOUND|SESSION_NOT_FOUND|stale|not\s+available/i.test(msg);
    },

    staleSessionMessage: 'Session is no longer available. Use /new to start a fresh one.',

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
