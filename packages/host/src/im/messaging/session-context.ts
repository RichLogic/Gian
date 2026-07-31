import type {
  MessagingSession,
  ModelOption,
  UserRecord,
  WorkspaceSummary,
} from '../types.js';
import type { MessagingPlatformOptions } from './types.js';
import type { CommandFlowContext } from './command-flows.js';
import { messagingSessionModePreferences } from './mode.js';

export interface MessagingBotSelection {
  ownerUserId: string;
  selectedWorkspaceId: string | null;
  selectedSessionId: string | null;
}

export type MessagingSelectionPatch = Partial<Pick<
  MessagingBotSelection,
  'selectedWorkspaceId' | 'selectedSessionId'
>>;

export interface CurrentMessagingContext<B extends MessagingBotSelection> {
  bot: B;
  owner: UserRecord | null;
  workspace: WorkspaceSummary | null;
  session: MessagingSession | null;
  sessions: MessagingSession[];
  queuedTurnCount: number;
  workspaceMissing: boolean;
  sessionMissing: boolean;
}

export function ownerForBot<B extends MessagingBotSelection>(
  options: MessagingPlatformOptions,
  bot: B,
): UserRecord | null {
  return options.listUsers().find(entry => entry.id === bot.ownerUserId) ?? null;
}

export function resolveModelOption(
  options: MessagingPlatformOptions,
  query: string | null | undefined,
  executor?: MessagingSession['executor'],
): ModelOption | null {
  if (!query?.trim()) return null;

  const value = query.trim();
  const direct = options.findModelOption(value, executor);
  if (direct) return direct;

  const normalized = value.toLowerCase();
  const models = options.listModelOptions(executor);
  const exact = models.find(entry =>
    entry.model.toLowerCase() === normalized
    || entry.id.toLowerCase() === normalized
    || entry.displayName.toLowerCase() === normalized);
  if (exact) return exact;

  const fuzzy = models.filter(entry =>
    entry.model.toLowerCase().includes(normalized)
    || entry.id.toLowerCase().includes(normalized)
    || entry.displayName.toLowerCase().includes(normalized));
  return fuzzy.length === 1 ? (fuzzy[0] ?? null) : null;
}

export function currentModelOption(
  options: MessagingPlatformOptions,
  session: MessagingSession | null,
): ModelOption | null {
  const executor = session?.executor;
  const requestedModel = session?.model ?? options.currentDefaultModel(executor);
  return resolveModelOption(options, requestedModel, executor)
    ?? options.listModelOptions(executor)[0]
    ?? null;
}

export function currentReasoningEffort(
  options: MessagingPlatformOptions,
  session: MessagingSession | null,
  modelOption: ModelOption | null,
): MessagingSession['reasoningEffort'] {
  if (session?.reasoningEffort) return session.reasoningEffort;
  if (!modelOption) return 'xhigh';
  return options.preferredReasoningEffortForModel(modelOption) ?? 'xhigh';
}

export async function loadCurrentMessagingContext<B extends MessagingBotSelection>(
  options: MessagingPlatformOptions,
  bot: B,
  syncSelection: (bot: B, patch: MessagingSelectionPatch) => Promise<B>,
): Promise<CurrentMessagingContext<B>> {
  const owner = ownerForBot(options, bot);
  if (!owner || !bot.selectedWorkspaceId) {
    return {
      bot,
      owner,
      workspace: null,
      session: null,
      sessions: [],
      queuedTurnCount: 0,
      workspaceMissing: false,
      sessionMissing: false,
    };
  }

  const workspace = await options.getWorkspace(bot.selectedWorkspaceId);
  if (!workspace) {
    const nextBot = await syncSelection(bot, {
      selectedWorkspaceId: null,
      selectedSessionId: null,
    });
    return {
      bot: nextBot,
      owner,
      workspace: null,
      session: null,
      sessions: [],
      queuedTurnCount: 0,
      workspaceMissing: true,
      sessionMissing: false,
    };
  }

  const sessions = await options.listSessionsForWorkspace(workspace.id);
  let nextBot = bot;
  let session = bot.selectedSessionId
    ? await options.getSession(bot.selectedSessionId)
    : null;
  let sessionMissing = false;

  if (session && (session.archivedAt || session.workspaceId !== workspace.id)) {
    session = null;
    sessionMissing = true;
  }
  if (!session && bot.selectedSessionId) sessionMissing = true;
  if (!session && sessions.length === 1) session = sessions[0] ?? null;
  if (nextBot.selectedSessionId !== (session?.id ?? null)) {
    nextBot = await syncSelection(nextBot, { selectedSessionId: session?.id ?? null });
  }

  return {
    bot: nextBot,
    owner,
    workspace,
    session,
    sessions,
    queuedTurnCount: session ? options.getQueueLength(session.id) : 0,
    workspaceMissing: false,
    sessionMissing,
  };
}

export function buildMessagingCommandFlowContext(
  options: MessagingPlatformOptions,
  actions: {
    createSession: CommandFlowContext['createSession'];
    switchToSession: CommandFlowContext['switchToSession'];
    getCurrentSession: () => Promise<MessagingSession | null>;
  },
): CommandFlowContext {
  return {
    availableExecutors: options.availableExecutors(),
    currentSession: null,
    listWorkspaces: () => options.listWorkspaces(),
    listSessions: workspaceId => options.listSessionsForWorkspace(workspaceId),
    listModels: executor => options.listModelOptions(executor),
    currentModelOption: session => currentModelOption(options, session),
    currentReasoningEffort: session => {
      const model = currentModelOption(options, session);
      return currentReasoningEffort(options, session, model) ?? 'xhigh';
    },
    preferredReasoningEffortForModel: model =>
      options.preferredReasoningEffortForModel(model) ?? 'xhigh',
    createSession: actions.createSession,
    switchToSession: actions.switchToSession,
    updateSessionModel: async (model, reasoning) => {
      const session = await actions.getCurrentSession();
      if (session) {
        await options.updateSession(session.id, { model, reasoningEffort: reasoning });
      }
    },
    updateSessionMode: async mode => {
      const session = await actions.getCurrentSession();
      if (session) {
        await options.updateSession(session.id, messagingSessionModePreferences(mode));
      }
    },
    updateSessionReasoning: async level => {
      const session = await actions.getCurrentSession();
      if (session) {
        await options.updateSession(session.id, { reasoningEffort: level });
      }
    },
  };
}
