import { basename } from 'node:path';

import { App, LogLevel } from '@slack/bolt';

import type {
  AgentExecutor,
  ApprovalScope,
  CodexThread,
  ModelOption,
  PendingApproval,
  SessionRecord,
  UserRecord,
  WorkspaceSummary,
} from '../types.js';
import { stripJobStatusBlock } from '../app/job-mode.js';
import type {
  InboundPromptInput,
  MessagingPlatform,
  MessagingPlatformOptions,
  MessagingSessionCreateInput,
} from '../messaging/types.js';
import {
  messagingSessionModeFromRecord,
  messagingSessionModePreferences,
} from '../messaging/mode.js';
import { InteractiveFlowManager, type FlowGenerator, type FlowReplyResult } from '../messaging/interactive-flow.js';
import {
  type CommandFlowContext,
  executorLabel,
  newSessionFlow,
  switchSessionFlow,
  alterSessionFlow,
} from '../messaging/command-flows.js';
import { parseSlackCommandAction, registerSlackCommands } from './manifest.js';
import type { SlackBotRecord, SlackCodingRepository } from './repository.js';

const SLACK_MESSAGE_LIMIT = 3900;
const SLACK_RECONNECT_DELAY_MS = 5_000;
const SLACK_REPLY_IGNORE_MESSAGE = '💬 回复消息不会被作为指令处理。请直接发送消息或使用斜杠命令。';

function isBusySession(session: SessionRecord | null) {
  if (!session) {
    return false;
  }
  return Boolean(session.activeTurnId) || session.status === 'running' || session.status === 'needs-approval';
}

function trimPrompt(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function workspaceDisplayName(workspace: Pick<WorkspaceSummary, 'name' | 'path'>) {
  return workspace.name || basename(workspace.path) || workspace.path;
}

function sessionWorkspaceDisplayName(session: Pick<SessionRecord, 'workspace'>) {
  return basename(session.workspace) || session.workspace;
}

function sessionDisplayName(session: Pick<SessionRecord, 'title' | 'id'>) {
  const title = session.title.trim();
  return title || `Session ${session.id.slice(0, 8)}`;
}

function sessionStatusLabel(session: SessionRecord | null) {
  return session?.status ?? 'not-started';
}

function approvalMessageTurnId(approvalId: string) {
  return `approval:${approvalId}`;
}

function approvalIdFromOutboxTurnId(turnId: string | null | undefined) {
  if (!turnId?.startsWith('approval:')) {
    return null;
  }
  const approvalId = turnId.slice('approval:'.length).trim();
  return approvalId || null;
}

function assistantTextFromTurn(thread: CodexThread, turnId: string) {
  const turn = thread.turns.find((entry) => entry.id === turnId);
  if (!turn) {
    return null;
  }

  const text = turn.items
    .filter((item): item is Extract<typeof turn.items[number], { type: 'agentMessage' }> => item.type === 'agentMessage')
    .map((item) => item.text)
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n\n')
    .trim();
  const visibleText = stripJobStatusBlock(text);
  return visibleText || null;
}

function summarizeTurn(thread: CodexThread, turnId: string) {
  const turn = thread.turns.find((entry) => entry.id === turnId);
  if (!turn) {
    return { assistantText: null as string | null, errorMessage: null as string | null };
  }
  return {
    assistantText: assistantTextFromTurn(thread, turnId),
    errorMessage: turn.error?.message ?? null,
  };
}

function chunkSlackMessage(content: string) {
  const normalized = content.trim();
  if (normalized.length <= SLACK_MESSAGE_LIMIT) {
    return [normalized];
  }

  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > SLACK_MESSAGE_LIMIT) {
    const boundary = remaining.lastIndexOf('\n', SLACK_MESSAGE_LIMIT);
    const nextIndex = boundary > Math.floor(SLACK_MESSAGE_LIMIT * 0.5)
      ? boundary
      : SLACK_MESSAGE_LIMIT;
    chunks.push(remaining.slice(0, nextIndex).trimEnd());
    remaining = remaining.slice(nextIndex).trimStart();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

function isInterruptedMessage(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return normalized.includes('interrupt')
    || normalized.includes('stopped')
    || normalized.includes('cancelled')
    || normalized.includes('canceled')
    || normalized.includes('停止')
    || normalized.includes('中断')
    || normalized.includes('取消');
}

function approvalSupportsSessionScope(approval: Pick<PendingApproval, 'scopeOptions'>) {
  return approval.scopeOptions.includes('session');
}

function approvalReplyAction(prompt: string): { decision: 'approve' | 'decline'; scope?: ApprovalScope } | null {
  const trimmed = prompt.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
  switch (normalized) {
    case '1': case 'a': return { decision: 'approve', scope: 'once' };
    case '2': case 'b': return { decision: 'approve', scope: 'session' };
    case '3': case 'c': return { decision: 'decline', scope: 'once' };
    default: return null;
  }
}

function approvalInstructionLines(approval: Pick<PendingApproval, 'scopeOptions'>) {
  const lines = ['回复 1 或 a：批准一次'];
  if (approvalSupportsSessionScope(approval)) {
    lines.push('回复 2 或 b：当前 session 持续批准');
  }
  lines.push('回复 3 或 c：拒绝');
  return lines;
}

function approvalMessageBody(approval: PendingApproval, summary?: string | null) {
  const nextSummary = summary?.trim() ?? '';
  const title = approval.title.trim();
  const risk = approval.risk.trim();
  const lines: string[] = [];

  if (nextSummary && nextSummary !== risk) {
    lines.push(nextSummary);
  }
  if (title) {
    lines.push(`审批请求：${title}`);
  }
  if (risk && risk !== title) {
    lines.push(risk);
  }
  lines.push('', ...approvalInstructionLines(approval));
  return lines.join('\n').trim();
}

function slackWorkspaceLine(workspaceName: string) {
  return `工作目录：${workspaceName}`;
}

function decorateWithWorkspace(heading: string, body: string, workspaceName: string) {
  return `${heading}\n${slackWorkspaceLine(workspaceName)}\n\n${body}`;
}

function canAttachSessionToBot(session: SessionRecord, botId: string) {
  return session.botId === botId || !isBusySession(session);
}

interface SlackCodingManagerOptions extends MessagingPlatformOptions {
  repository: SlackCodingRepository;
  decryptBotToken: (ciphertext: string) => Promise<string>;
  decryptAppToken: (ciphertext: string) => Promise<string>;
}

export class SlackCodingManager implements MessagingPlatform {
  readonly platformId = 'slack' as const;

  private readonly apps = new Map<string, App>();
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();
  private readonly flows = new InteractiveFlowManager();

  constructor(private readonly options: SlackCodingManagerOptions) {}

  private clearReconnectTimer(botId: string) {
    const timer = this.reconnectTimers.get(botId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(botId);
    }
  }

  private scheduleReconnect(botId: string, reason: string, delayMs = SLACK_RECONNECT_DELAY_MS) {
    if (this.reconnectTimers.has(botId)) {
      return;
    }
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(botId);
      void this.syncBot(botId);
    }, delayMs);
    this.reconnectTimers.set(botId, timer);
    this.options.log.warn(`Slack bot reconnect scheduled for ${botId} in ${delayMs}ms: ${reason}`);
  }

  private async markBotConnectionState(
    botId: string,
    patch: Partial<Pick<SlackBotRecord, 'status' | 'lastError' | 'lastConnectedAt' | 'updatedAt'>>,
  ) {
    await this.options.repository.updateBot(botId, patch).catch(() => undefined);
  }

  private ownerForBot(bot: SlackBotRecord) {
    return this.options.listUsers().find((entry) => entry.id === bot.ownerUserId) ?? null;
  }

  private async syncBotSelection(
    bot: SlackBotRecord,
    patch: Partial<Pick<SlackBotRecord, 'selectedWorkspaceId' | 'selectedSessionId'>>,
  ) {
    return (await this.options.repository.updateBot(bot.id, {
      ...patch,
      updatedAt: new Date().toISOString(),
    })) ?? { ...bot, ...patch };
  }

  private async attachSessionToBot(bot: SlackBotRecord, session: SessionRecord) {
    if (session.botId === bot.id) {
      return session;
    }
    return (await this.options.repository.updateSession(session.id, {
      botId: bot.id,
      updatedAt: new Date().toISOString(),
    })) ?? { ...session, botId: bot.id };
  }

  private resolveModelOption(query: string | null | undefined, executor?: SessionRecord['executor']) {
    if (!query?.trim()) {
      return null;
    }
    const direct = this.options.findModelOption(query.trim(), executor);
    if (direct) {
      return direct;
    }
    const normalizedQuery = query.trim().toLowerCase();
    const models = this.options.listModelOptions(executor);
    const exact = models.find((e) => (
      e.model.toLowerCase() === normalizedQuery
      || e.id.toLowerCase() === normalizedQuery
      || e.displayName.toLowerCase() === normalizedQuery
    ));
    if (exact) {
      return exact;
    }
    const fuzzy = models.filter((e) => (
      e.model.toLowerCase().includes(normalizedQuery)
      || e.id.toLowerCase().includes(normalizedQuery)
      || e.displayName.toLowerCase().includes(normalizedQuery)
    ));
    return fuzzy.length === 1 ? (fuzzy[0] ?? null) : null;
  }

  private currentModelOption(session: SessionRecord | null) {
    const executor = session?.executor;
    const requestedModel = session?.model ?? this.options.currentDefaultModel(executor);
    return this.resolveModelOption(requestedModel, executor)
      ?? this.options.listModelOptions(executor)[0]
      ?? null;
  }

  private currentReasoningEffort(session: SessionRecord | null, modelOption: ModelOption | null) {
    if (session?.reasoningEffort) {
      return session.reasoningEffort;
    }
    if (!modelOption) {
      return 'xhigh';
    }
    return this.options.preferredReasoningEffortForModel(modelOption);
  }

  private async loadCurrentWorkspaceContext(bot: SlackBotRecord) {
    const owner = this.ownerForBot(bot);
    if (!owner || !bot.selectedWorkspaceId) {
      return {
        bot, owner,
        workspace: null as WorkspaceSummary | null,
        session: null as SessionRecord | null,
        sessions: [] as SessionRecord[],
        queuedTurnCount: 0,
        workspaceMissing: false,
        sessionMissing: false,
      };
    }

    const workspace = await this.options.getWorkspaceForUser(bot.selectedWorkspaceId, owner.id);
    if (!workspace) {
      const nextBot = await this.syncBotSelection(bot, { selectedWorkspaceId: null, selectedSessionId: null });
      return {
        bot: nextBot, owner,
        workspace: null as WorkspaceSummary | null,
        session: null as SessionRecord | null,
        sessions: [] as SessionRecord[],
        queuedTurnCount: 0,
        workspaceMissing: true,
        sessionMissing: false,
      };
    }

    const sessions = await this.options.repository.listSessionsForOwnerWorkspace(owner.id, workspace.id);
    let nextBot = bot;
    let session = bot.selectedSessionId
      ? (await this.options.repository.getSessionForUser(bot.selectedSessionId, owner.id))
      : null;
    let sessionMissing = false;

    if (session && (session.archivedAt || session.workspaceId !== workspace.id)) {
      session = null;
      sessionMissing = true;
    }
    if (!session && bot.selectedSessionId) {
      sessionMissing = true;
    }
    if (session && canAttachSessionToBot(session, bot.id)) {
      session = await this.attachSessionToBot(bot, session);
    } else if (session && session.botId !== bot.id) {
      session = null;
    }
    if (!session && sessions.length === 1) {
      const candidate = sessions[0] ?? null;
      if (candidate && canAttachSessionToBot(candidate, bot.id)) {
        session = await this.attachSessionToBot(bot, candidate);
      }
    }
    if (nextBot.selectedSessionId !== (session?.id ?? null)) {
      nextBot = await this.syncBotSelection(nextBot, { selectedSessionId: session?.id ?? null });
    }

    const queuedTurnCount = session ? await this.options.repository.countQueuedTurns(session.id) : 0;
    return { bot: nextBot, owner, workspace, session, sessions, queuedTurnCount, workspaceMissing: false, sessionMissing };
  }

  private async ensureBotDirectChannel(bot: SlackBotRecord, channelId: string | null | undefined) {
    const nextChannelId = channelId?.trim() ?? null;
    if (!nextChannelId || bot.directChannelId === nextChannelId) {
      return bot;
    }
    return (await this.options.repository.updateBot(bot.id, {
      directChannelId: nextChannelId,
      updatedAt: new Date().toISOString(),
    })) ?? bot;
  }

  private async sendText(
    botId: string,
    channelId: string | null | undefined,
    content: string,
    options?: {
      sessionId?: string | null;
      turnId?: string | null;
    },
  ) {
    if (!channelId) return null;
    const app = this.apps.get(botId);
    if (!app) return null;

    let sentTs: string | null = null;
    for (const chunk of chunkSlackMessage(content)) {
      const outbox = await this.options.repository.createOutboxMessage({
        botId,
        channelId,
        content: chunk,
        sessionId: options?.sessionId ?? null,
        turnId: options?.turnId ?? null,
      });
      try {
        const result = await app.client.chat.postMessage({
          channel: channelId,
          text: chunk,
        });
        sentTs = result.ts ?? null;
        await this.options.repository.markOutboxSent(outbox.id, sentTs);
      } catch (error) {
        const message = this.options.errorMessage(error);
        await this.options.repository.markOutboxError(outbox.id, message);
        return null;
      }
    }
    return sentTs;
  }

  private async createSession(bot: SlackBotRecord, workspace: WorkspaceSummary, input?: MessagingSessionCreateInput) {
    const owner = this.ownerForBot(bot);
    if (!owner) {
      throw new Error('Bot owner no longer exists locally.');
    }
    const session = await this.options.createSession(owner, workspace, bot.id, input);
    await this.syncBotSelection(bot, {
      selectedWorkspaceId: workspace.id,
      selectedSessionId: session.id,
    });
    return session;
  }

  private buildFlowContext(bot: SlackBotRecord, owner: UserRecord): CommandFlowContext {
    return {
      availableExecutors: this.options.availableExecutors(),
      currentSession: null, // overridden by alter handler
      listWorkspaces: () => this.options.listUserWorkspaces(owner.username, owner.id),
      listSessions: (wsId) => this.options.listSessionsForWorkspace(owner.id, wsId),
      listModels: (executor) => this.options.listModelOptions(executor),
      currentModelOption: (session) => this.currentModelOption(session),
      currentReasoningEffort: (session) => {
        const model = this.currentModelOption(session);
        return this.currentReasoningEffort(session, model) ?? 'xhigh';
      },
      preferredReasoningEffortForModel: (model) => this.options.preferredReasoningEffortForModel(model) ?? 'xhigh',
      createSession: async (executor, workspace, title) => {
        return this.createSession(bot, workspace, { executor, ...(title ? { title } : {}) });
      },
      switchToSession: async (workspace, session) => {
        if (canAttachSessionToBot(session, bot.id)) {
          await this.attachSessionToBot(bot, session);
        }
        await this.syncBotSelection(bot, {
          selectedWorkspaceId: workspace.id,
          selectedSessionId: session.id,
        });
      },
      updateSessionModel: async (model, reasoning) => {
        const context = await this.loadCurrentWorkspaceContext(bot);
        if (context.session) {
          await this.options.repository.updateSession(context.session.id, {
            model,
            reasoningEffort: reasoning,
            updatedAt: new Date().toISOString(),
          });
        }
      },
      updateSessionMode: async (mode) => {
        const context = await this.loadCurrentWorkspaceContext(bot);
        if (context.session) {
          const prefs = messagingSessionModePreferences(mode);
          await this.options.repository.updateSession(context.session.id, {
            ...prefs,
            job: null,
            updatedAt: new Date().toISOString(),
          });
        }
      },
      updateSessionReasoning: async (level) => {
        const context = await this.loadCurrentWorkspaceContext(bot);
        if (context.session) {
          await this.options.repository.updateSession(context.session.id, {
            reasoningEffort: level,
            updatedAt: new Date().toISOString(),
          });
        }
      },
    };
  }

  private async handleInboundPrompt(input: InboundPromptInput) {
    let bot = await this.options.repository.getBotRecord(input.botId);
    if (!bot || !bot.enabled) return;

    if (!(await this.options.repository.recordInboundEvent({
      id: input.messageId,
      botId: input.botId,
      kind: 'message',
      channelId: input.channelId,
      authorId: input.authorId,
    }))) {
      return;
    }

    bot = await this.ensureBotDirectChannel(bot, input.channelId);
    if (bot.allowedSlackUserId && bot.allowedSlackUserId !== input.authorId) {
      await input.reply('This bot is not configured for your Slack account.');
      return;
    }

    const prompt = trimPrompt(input.content);
    if (!prompt) {
      await input.reply('Only plain-text prompts are supported right now.');
      return;
    }

    // -- Reply handling: flow replies, approval replies, or ignore ----------
    if (input.threadTs) {
      // 1. Check if it's a flow reply
      const hasActive = this.flows.hasActiveFlow(input.botId, input.channelId);
      const isFlowMsg = this.flows.isFlowMessage(input.threadTs);
      this.options.log.info(`Thread reply: threadTs=${input.threadTs} hasActiveFlow=${hasActive} isFlowMessage=${isFlowMsg}`);
      const flowResult = await this.flows.handleReply(input.threadTs, prompt);
      if (flowResult) {
        await input.reply(flowResult.message);
        return;
      }

      // 2. Check if it's an approval reply
      const replyTarget = await this.options.repository.getOutboxMessageBySentMessageId(input.botId, input.threadTs);
      const explicitApprovalId = approvalIdFromOutboxTurnId(replyTarget?.turnId);
      if (explicitApprovalId && replyTarget?.sessionId) {
        const session = await this.options.repository.getSession(replyTarget.sessionId);
        if (!session) {
          await input.reply('⚠️ 这条线程关联的 Session 已不存在。');
          return;
        }
        const approval = this.options.getApprovals(session.id).find((a) => a.id === explicitApprovalId) ?? null;
        if (!approval) {
          const workspaceName = sessionWorkspaceDisplayName(session);
          await input.reply(`⚠️ 这条线程关联的审批已经结束，请回到主聊天继续。\n${slackWorkspaceLine(workspaceName)}`);
          return;
        }
        const action = approvalReplyAction(prompt);
        if (!action) {
          const hint = approvalSupportsSessionScope(approval) ? '请回复 1/a、2/b 或 3/c。' : '请回复 1/a 或 3/c。';
          await input.reply(hint);
          return;
        }
        if (action.scope === 'session' && !approvalSupportsSessionScope(approval)) {
          await input.reply('⚠️ 当前审批不支持 session 持续批准，请回复 1/a 或 3/c。');
          return;
        }
        try {
          await this.options.resolveApproval(session, approval.id, action);
        } catch (error) {
          await input.reply(`❌ 审批处理失败\n${this.options.errorMessage(error)}`);
          return;
        }
        const confirmation = action.decision === 'decline'
          ? '🛑 已拒绝审批请求。'
          : action.scope === 'session'
            ? '✅ 已批准，并记住当前 session 的审批选择。'
            : '✅ 已批准一次，继续执行。';
        await input.reply(confirmation);
        return;
      }

      // 3. Not a flow or approval reply — ignore
      await input.reply(SLACK_REPLY_IGNORE_MESSAGE);
      return;
    }

    // -- Normal message (not a reply) — send as prompt to agent -------------
    if (input.attachmentCount > 0) {
      await input.reply('Slack attachments are not supported in coding mode yet.');
      return;
    }

    const context = await this.loadCurrentWorkspaceContext(bot);
    if (!context.owner) {
      await input.reply('This bot owner no longer exists locally.');
      return;
    }
    if (!context.workspace) {
      await input.reply('没有选中的 Workspace。请先使用 /new 创建或 /switch 切换 Session。');
      return;
    }
    if (!context.session) {
      await input.reply('没有选中的 Session。请先使用 /new 创建或 /switch 切换 Session。');
      return;
    }

    const workspace = context.workspace;
    const session = context.session;
    const workspaceName = workspaceDisplayName(workspace);

    // If session is waiting for approval, remind user
    if (session.status === 'needs-approval') {
      const pendingApproval = this.options.getApprovals(session.id)[0] ?? null;
      if (pendingApproval) {
        const hint = approvalSupportsSessionScope(pendingApproval) ? '请回复 1/a、2/b 或 3/c。' : '请回复 1/a 或 3/c。';
        await input.reply(`⏸️ 当前 session 正在等待审批，${hint}\n${slackWorkspaceLine(workspaceName)}`);
        return;
      }
      await input.reply(`⏸️ 当前 session 正在等待审批，请先处理审批后再发送新任务。\n${slackWorkspaceLine(workspaceName)}`);
      return;
    }

    try {
      if (isBusySession(session)) {
        await this.options.queueTurn(session, prompt);
        await input.reply(`⏳ 已收到，当前正在执行任务，已经帮你排队。\n${slackWorkspaceLine(workspaceName)}`);
        return;
      }
      if (context.queuedTurnCount > 0) {
        await this.options.queueTurn(session, prompt);
        await input.reply(`⏳ 已收到，当前前面还有 ${context.queuedTurnCount} 个待执行任务，已加入队列。\n${slackWorkspaceLine(workspaceName)}`);
        return;
      }
      await input.reply(`🛠️ 正在处理...\n${slackWorkspaceLine(workspaceName)}`);
      await this.options.startTurnWithAutoRestart(session, prompt, []);
    } catch (error) {
      if (!session.activeTurnId) {
        await this.options.repository.updateSession(session.id, {
          activeTurnId: null, status: 'idle', lastIssue: this.options.errorMessage(error), updatedAt: new Date().toISOString(),
        });
      }
      await input.reply(`❌ 启动失败\n${slackWorkspaceLine(workspaceName)}\n\n${this.options.errorMessage(error)}`);
    }
  }

  // ---- Slash command handlers (interactive flow-based) --------------------

  private async startInteractiveFlow(
    bot: SlackBotRecord,
    channelId: string,
    app: App,
    generator: FlowGenerator,
  ) {
    const result = await this.flows.startFlow({
      botId: bot.id,
      channelId,
      userId: bot.ownerUserId,
      generator,
      onExpire: () => {
        void app.client.chat.postMessage({ channel: channelId, text: '⏰ 操作已超时，已取消。' }).catch(() => undefined);
      },
    });
    const sent = await app.client.chat.postMessage({ channel: channelId, text: result.message });
    this.options.log.info(`Flow started: type=${result.type} sentTs=${sent.ts} botId=${bot.id} channel=${channelId}`);
    if (result.type === 'prompt' && sent.ts) {
      this.flows.registerFlowMessage(bot.id, channelId, sent.ts);
    }
  }

  private async handleCommandNew(bot: SlackBotRecord, channelId: string, app: App) {
    const owner = this.ownerForBot(bot);
    if (!owner) { await app.client.chat.postMessage({ channel: channelId, text: 'Bot owner no longer exists.' }); return; }
    const ctx = this.buildFlowContext(bot, owner);
    await this.startInteractiveFlow(bot, channelId, app, newSessionFlow(ctx));
  }

  private async handleCommandSwitch(bot: SlackBotRecord, channelId: string, app: App) {
    const owner = this.ownerForBot(bot);
    if (!owner) { await app.client.chat.postMessage({ channel: channelId, text: 'Bot owner no longer exists.' }); return; }
    const ctx = this.buildFlowContext(bot, owner);
    await this.startInteractiveFlow(bot, channelId, app, switchSessionFlow(ctx));
  }

  private async handleCommandAlter(bot: SlackBotRecord, channelId: string, app: App) {
    const owner = this.ownerForBot(bot);
    if (!owner) { await app.client.chat.postMessage({ channel: channelId, text: 'Bot owner no longer exists.' }); return; }
    const context = await this.loadCurrentWorkspaceContext(bot);
    const ctx = this.buildFlowContext(bot, owner);
    ctx.currentSession = context.session;
    await this.startInteractiveFlow(bot, channelId, app, alterSessionFlow(ctx));
  }

  private async handleCommandStop(bot: SlackBotRecord, channelId: string, app: App) {
    const context = await this.loadCurrentWorkspaceContext(bot);
    if (!context.owner || !context.workspace || !context.session) {
      await app.client.chat.postMessage({ channel: channelId, text: '没有活动的 Session。' });
      return;
    }
    const session = context.session;
    if (!session.activeTurnId && context.queuedTurnCount === 0) {
      await app.client.chat.postMessage({ channel: channelId, text: '当前没有正在执行的任务。' });
      return;
    }
    // Stop active turn
    if (session.activeTurnId) {
      try {
        await this.options.interruptTurn(session, session.threadId, session.activeTurnId);
        await this.options.repository.updateSession(session.id, {
          activeTurnId: null, status: 'idle', lastIssue: 'Stopped by user.', updatedAt: new Date().toISOString(),
        });
      } catch (error) {
        if (this.options.isThreadUnavailableError(error)) {
          await this.options.repository.updateSession(session.id, {
            activeTurnId: null, status: 'stale', lastIssue: this.options.staleSessionMessage,
            networkEnabled: false, updatedAt: new Date().toISOString(),
          });
        }
      }
    }
    // Clear queue
    if (context.queuedTurnCount > 0) {
      await this.options.repository.deleteAllQueuedTurns(session.id);
    }
    await app.client.chat.postMessage({ channel: channelId, text: '✅ 已停止所有活动任务，队列已清空。' });
  }

  private async handleCommandStatus(bot: SlackBotRecord, channelId: string, app: App) {
    const context = await this.loadCurrentWorkspaceContext(bot);
    if (!context.owner) {
      await app.client.chat.postMessage({ channel: channelId, text: 'This bot owner no longer exists locally.' });
      return;
    }
    const modelOption = this.currentModelOption(context.session);
    const reasoningEffort = this.currentReasoningEffort(context.session, modelOption);
    const lines = [
      `Bot: ${context.bot.status}`,
      `Workspace: ${context.workspace ? workspaceDisplayName(context.workspace) : 'not selected'}`,
      `Session: ${context.session ? `${sessionDisplayName(context.session)} [${sessionStatusLabel(context.session)}]` : 'not selected'}`,
      `Agent: ${context.session ? executorLabel(context.session.executor) : 'not selected'}`,
      `Mode: ${context.session ? messagingSessionModeFromRecord(context.session) : 'not selected'}`,
      `Model: ${modelOption?.model ?? this.options.currentDefaultModel(context.session?.executor)}${context.session?.model ? '' : ' (default)'}`,
      `Thinking: ${reasoningEffort}${context.session?.reasoningEffort ? '' : ' (default)'}`,
      `Queue: ${context.queuedTurnCount}`,
    ];
    if (context.session?.lastIssue) {
      lines.push(`Last issue: ${context.session.lastIssue}`);
    }
    await app.client.chat.postMessage({ channel: channelId, text: lines.join('\n') });
  }

  // ---- Bot lifecycle ----

  private async startBot(bot: SlackBotRecord) {
    await this.stopBot(bot.id);
    this.clearReconnectTimer(bot.id);

    const botToken = await this.options.decryptBotToken(bot.botTokenCiphertext);
    const appToken = await this.options.decryptAppToken(bot.appTokenCiphertext);

    const app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.WARN,
    });

    // DM messages can either start a new prompt or reply to a bot thread.
    app.message(async ({ message }) => {
      if (message.subtype || !('text' in message) || !message.text || ('bot_id' in message && message.bot_id)) {
        return;
      }
      const channelType = (message as unknown as Record<string, unknown>).channel_type;
      if (channelType !== 'im') {
        return;
      }
      await this.handleInboundPrompt({
        botId: bot.id,
        messageId: ('client_msg_id' in message && typeof message.client_msg_id === 'string') ? message.client_msg_id : `${message.ts}-${message.channel}`,
        channelId: message.channel,
        authorId: ('user' in message && typeof message.user === 'string') ? message.user : '',
        content: message.text,
        attachmentCount: ('files' in message && Array.isArray(message.files)) ? message.files.length : 0,
        threadTs: ('thread_ts' in message && typeof message.thread_ts === 'string') ? message.thread_ts : null,
        reply: async (content) => {
          const result = await app.client.chat.postMessage({
            channel: message.channel,
            text: content,
            ...(typeof message.thread_ts === 'string' ? { thread_ts: message.thread_ts } : {}),
          });
          return { messageId: result.ts ?? null };
        },
      });
    });

    // Register individual /{prefix}-{action} slash command handlers
    const prefix = bot.commandPrefix?.trim() ?? null;
    if (prefix) {
      const actions = ['new', 'switch', 'alter', 'stop', 'status'] as const;
      for (const action of actions) {
        app.command(`/${prefix}-${action}`, async ({ command, ack }) => {
          await ack();
          try {
            if (bot.allowedSlackUserId && bot.allowedSlackUserId !== command.user_id) {
              await app.client.chat.postMessage({ channel: command.channel_id, text: 'This bot is not configured for your Slack account.' });
              return;
            }
            const latestBot = await this.options.repository.getBotRecord(bot.id);
            if (!latestBot || !latestBot.enabled) return;

            switch (action) {
              case 'new': await this.handleCommandNew(latestBot, command.channel_id, app); break;
              case 'switch': await this.handleCommandSwitch(latestBot, command.channel_id, app); break;
              case 'alter': await this.handleCommandAlter(latestBot, command.channel_id, app); break;
              case 'stop': await this.handleCommandStop(latestBot, command.channel_id, app); break;
              case 'status': await this.handleCommandStatus(latestBot, command.channel_id, app); break;
            }
          } catch (error) {
            const msg = this.options.errorMessage(error);
            this.options.log.warn(`Slack /${prefix}-${action} failed for ${bot.ownerUsername}: ${msg}`);
            await app.client.chat.postMessage({ channel: command.channel_id, text: `❌ 命令处理失败：${msg}` }).catch(() => undefined);
          }
        });
      }
    }

    this.apps.set(bot.id, app);
    await this.markBotConnectionState(bot.id, { status: 'connecting', lastError: null, updatedAt: new Date().toISOString() });

    try {
      await app.start();
      const authResult = await app.client.auth.test({ token: botToken });
      await this.options.repository.updateBot(bot.id, {
        botUserId: (authResult.user_id as string) ?? null,
        teamId: (authResult.team_id as string) ?? null,
        status: 'connected',
        lastError: null,
        lastConnectedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      this.options.log.info(`Slack bot connected for ${bot.ownerUsername}`);

      // Auto-register slash commands via Manifest API
      if (prefix && bot.configTokenCiphertext) {
        try {
          const configToken = await this.options.decryptToken(bot.configTokenCiphertext);
          // auth.test does not return app_id; fetch it via bots.info instead
          const botId = authResult.bot_id as string | undefined;
          let appId: string | undefined;
          if (botId) {
            const botsInfoRes = await app.client.bots.info({ token: botToken, bot: botId });
            appId = (botsInfoRes.bot as Record<string, unknown> | undefined)?.app_id as string | undefined;
          }
          if (appId) {
            await registerSlackCommands({ configToken, appId, prefix, log: this.options.log });
          } else {
            this.options.log.warn(`Slack bot ${bot.id}: cannot auto-register commands — app_id not available`);
          }
        } catch (error) {
          this.options.log.warn(`Slack command registration failed for ${bot.ownerUsername}: ${this.options.errorMessage(error)}`);
        }
      }
    } catch (error) {
      this.apps.delete(bot.id);
      await app.stop().catch(() => undefined);
      const message = this.options.errorMessage(error);
      await this.options.repository.updateBot(bot.id, {
        status: 'error', lastError: message, updatedAt: new Date().toISOString(),
      });
      this.scheduleReconnect(bot.id, message);
      throw error;
    }
  }

  async syncBot(botId: string) {
    const bot = await this.options.repository.getBotRecord(botId);
    if (!bot || !bot.enabled) {
      await this.stopBot(botId);
      return;
    }
    try {
      await this.startBot(bot);
    } catch (error) {
      this.options.log.warn(`Slack bot start failed for ${bot.ownerUsername}: ${this.options.errorMessage(error)}`);
    }
  }

  async startAll() {
    const bots = await this.options.repository.listEnabledBotRecords();
    await Promise.all(bots.map(async (bot) => {
      await this.syncBot(bot.id);
    }));
  }

  async stopBot(botId: string) {
    this.clearReconnectTimer(botId);
    const existing = this.apps.get(botId);
    this.apps.delete(botId);
    if (existing) {
      await existing.stop().catch(() => undefined);
    }
    await this.options.repository.updateBot(botId, {
      status: 'disabled', updatedAt: new Date().toISOString(),
    }).catch(() => undefined);
  }

  async shutdown() {
    this.flows.shutdown();
    await Promise.all([...this.apps.keys()].map(async (botId) => {
      const app = this.apps.get(botId);
      this.apps.delete(botId);
      this.clearReconnectTimer(botId);
      if (app) {
        await app.stop().catch(() => undefined);
      }
    }));
  }

  // ---- MessagingPlatform event hooks ----

  async sendTurnCompletion(session: SessionRecord, thread: CodexThread | null, turnId: string | null) {
    if (session.origin !== 'slack' || !session.botId || !turnId) return;
    const bot = await this.options.repository.getBotRecord(session.botId);
    if (!bot?.directChannelId || !thread) return;

    const currentSession = await this.options.repository.getSession(session.id) ?? session;
    const workspaceName = sessionWorkspaceDisplayName(currentSession);
    const summary = summarizeTurn(thread, turnId);
    if (currentSession.status === 'error' && summary.errorMessage) return;

    const currentJob = currentSession.job;
    const currentApproval = this.options.getApprovals(currentSession.id)[0] ?? null;
    let heading = '✅ 已完成';
    let body = currentJob?.finalOutput ?? summary.assistantText ?? null;
    let outboxTurnId: string | null = turnId;

    if (currentJob) {
      switch (currentJob.state) {
        case 'waiting-approval':
          if (!currentApproval) return;
          heading = '⏸️ 等待审批';
          body = approvalMessageBody(currentApproval, currentJob.waitingReason ?? body);
          outboxTurnId = approvalMessageTurnId(currentApproval.id);
          break;
        case 'waiting-input': heading = '⏸️ 需要补充信息'; body = currentJob.waitingReason ?? body; break;
        case 'budget-exhausted': heading = '⚠️ 已达到轮数上限'; body = currentJob.waitingReason ?? currentJob.finalOutput ?? body; break;
        case 'failed': heading = '❌ 执行失败'; body = currentJob.waitingReason ?? currentJob.finalOutput ?? summary.errorMessage ?? body; break;
        case 'completed': heading = '✅ 已完成'; body = currentJob.finalOutput ?? body; break;
        default: break;
      }
    } else if (summary.errorMessage) {
      heading = '❌ 执行失败';
      body = summary.errorMessage;
    }

    if (!body?.trim()) return;
    await this.sendText(bot.id, bot.directChannelId, decorateWithWorkspace(heading, body, workspaceName), {
      sessionId: currentSession.id,
      turnId: outboxTurnId,
    });
  }

  async sendApprovalRequested(session: SessionRecord, approval: PendingApproval) {
    if (session.origin !== 'slack' || !session.botId || (session.executionMode ?? 'interactive') === 'job') return;
    const bot = await this.options.repository.getBotRecord(session.botId);
    if (!bot?.directChannelId) return;
    const currentSession = await this.options.repository.getSession(session.id) ?? session;
    const workspaceName = sessionWorkspaceDisplayName(currentSession);
    await this.sendText(bot.id, bot.directChannelId, decorateWithWorkspace('⏸️ 等待审批', approvalMessageBody(approval), workspaceName), {
      sessionId: currentSession.id,
      turnId: approvalMessageTurnId(approval.id),
    });
  }

  async sendSessionError(session: SessionRecord, message: string) {
    if (session.origin !== 'slack' || !session.botId) return;
    const bot = await this.options.repository.getBotRecord(session.botId);
    if (!bot?.directChannelId) return;
    const heading = isInterruptedMessage(message) ? '🛑 已停止' : '❌ 执行失败';
    const workspaceName = sessionWorkspaceDisplayName(session);
    await this.sendText(bot.id, bot.directChannelId, decorateWithWorkspace(heading, message, workspaceName), {
      sessionId: session.id,
      turnId: session.activeTurnId,
    });
  }
}
