import { App, LogLevel } from '@slack/bolt';

import type {
  CodexThread,
  PendingApproval,
  MessagingSession,
  WorkspaceSummary,
} from '../types.js';
import type {
  InboundPromptInput,
  MessagingPlatform,
  MessagingPlatformOptions,
  MessagingSessionCreateInput,
} from '../messaging/types.js';
import { messagingSessionModeFromRecord } from '../messaging/mode.js';
import { InteractiveFlowManager, type FlowGenerator } from '../messaging/interactive-flow.js';
import {
  executorLabel,
  newSessionFlow,
  switchSessionFlow,
  alterSessionFlow,
} from '../messaging/command-flows.js';
import {
  approvalMessageBody,
  approvalReplyAction,
  approvalSupportsSessionScope,
  chunkMessage,
  isBusySession,
  isInterruptedMessage,
  sessionDisplayName,
  sessionStatusLabel,
  sessionWorkspaceDisplayName,
  summarizeTurn,
  trimPrompt,
  workspaceDisplayName,
} from '../messaging/presentation.js';
import {
  buildMessagingCommandFlowContext,
  currentModelOption,
  currentReasoningEffort,
  loadCurrentMessagingContext,
  ownerForBot as findOwnerForBot,
} from '../messaging/session-context.js';
import { registerSlackCommands } from './manifest.js';
import type { SlackBotRecord, SlackCodingRepository } from './repository.js';

const SLACK_MESSAGE_LIMIT = 3900;
const SLACK_RECONNECT_DELAY_MS = 5_000;
const SLACK_REPLY_IGNORE_MESSAGE = '💬 回复消息不会被作为指令处理。请直接发送消息或使用斜杠命令。';

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

function slackWorkspaceLine(workspaceName: string) {
  return `工作目录：${workspaceName}`;
}

function decorateWithWorkspace(heading: string, body: string, workspaceName: string) {
  return `${heading}\n${slackWorkspaceLine(workspaceName)}\n\n${body}`;
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
    return findOwnerForBot(this.options, bot);
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

  private async loadCurrentWorkspaceContext(bot: SlackBotRecord) {
    return loadCurrentMessagingContext(
      this.options,
      bot,
      (current, patch) => this.syncBotSelection(current, patch),
    );
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
    for (const chunk of chunkMessage(content, SLACK_MESSAGE_LIMIT)) {
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
    const session = await this.options.createSession(workspace, input);
    await this.syncBotSelection(bot, {
      selectedWorkspaceId: workspace.id,
      selectedSessionId: session.id,
    });
    return session;
  }

  private buildFlowContext(bot: SlackBotRecord) {
    return buildMessagingCommandFlowContext(this.options, {
      createSession: async (executor, workspace, title) => {
        return this.createSession(bot, workspace, { executor, ...(title ? { title } : {}) });
      },
      switchToSession: async (workspace, session) => {
        await this.syncBotSelection(bot, {
          selectedWorkspaceId: workspace.id,
          selectedSessionId: session.id,
        });
      },
      getCurrentSession: async () => (await this.loadCurrentWorkspaceContext(bot)).session,
    });
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
        const session = await this.options.getSession(replyTarget.sessionId);
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
      await this.options.startTurn(session, prompt);
    } catch (error) {
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
    const ctx = this.buildFlowContext(bot);
    await this.startInteractiveFlow(bot, channelId, app, newSessionFlow(ctx));
  }

  private async handleCommandSwitch(bot: SlackBotRecord, channelId: string, app: App) {
    const owner = this.ownerForBot(bot);
    if (!owner) { await app.client.chat.postMessage({ channel: channelId, text: 'Bot owner no longer exists.' }); return; }
    const ctx = this.buildFlowContext(bot);
    await this.startInteractiveFlow(bot, channelId, app, switchSessionFlow(ctx));
  }

  private async handleCommandAlter(bot: SlackBotRecord, channelId: string, app: App) {
    const owner = this.ownerForBot(bot);
    if (!owner) { await app.client.chat.postMessage({ channel: channelId, text: 'Bot owner no longer exists.' }); return; }
    const context = await this.loadCurrentWorkspaceContext(bot);
    const ctx = this.buildFlowContext(bot);
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
    if (!isBusySession(session) && context.queuedTurnCount === 0) {
      await app.client.chat.postMessage({ channel: channelId, text: '当前没有正在执行的任务。' });
      return;
    }
    // Stop active turn
    if (isBusySession(session)) {
      try {
        await this.options.interruptTurn(session, session.threadId, session.activeTurnId ?? session.id);
      } catch (error) {
        if (!this.options.isThreadUnavailableError(error)) {
          throw error;
        }
      }
    }
    // Clear queue
    if (context.queuedTurnCount > 0) {
      this.options.clearQueue(session.id);
    }
    await app.client.chat.postMessage({ channel: channelId, text: '✅ 已停止所有活动任务，队列已清空。' });
  }

  private async handleCommandStatus(bot: SlackBotRecord, channelId: string, app: App) {
    const context = await this.loadCurrentWorkspaceContext(bot);
    if (!context.owner) {
      await app.client.chat.postMessage({ channel: channelId, text: 'This bot owner no longer exists locally.' });
      return;
    }
    const modelOption = currentModelOption(this.options, context.session);
    const reasoningEffort = currentReasoningEffort(this.options, context.session, modelOption);
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

  async sendTurnCompletion(session: MessagingSession, thread: CodexThread | null, turnId: string | null) {
    if (!turnId || !thread) return;
    const bots = await this.options.repository.listBotRecordsForSession(session.id);
    if (bots.length === 0) return;

    const currentSession = await this.options.getSession(session.id) ?? session;
    const workspaceName = sessionWorkspaceDisplayName(currentSession);
    const summary = summarizeTurn(thread, turnId);
    if (currentSession.status === 'error' && summary.errorMessage) return;

    const currentApproval = this.options.getApprovals(currentSession.id)[0] ?? null;
    let heading = '✅ 已完成';
    let body = summary.assistantText ?? null;
    let outboxTurnId: string | null = turnId;

    if (currentApproval) {
      heading = '⏸️ 等待审批';
      body = approvalMessageBody(currentApproval, body);
      outboxTurnId = approvalMessageTurnId(currentApproval.id);
    } else if (summary.errorMessage) {
      heading = '❌ 执行失败';
      body = summary.errorMessage;
    }

    if (!body?.trim()) return;
    await Promise.all(bots.flatMap(bot => bot.directChannelId
      ? [this.sendText(bot.id, bot.directChannelId, decorateWithWorkspace(heading, body, workspaceName), {
          sessionId: currentSession.id,
          turnId: outboxTurnId,
        })]
      : []));
  }

  async sendApprovalRequested(session: MessagingSession, approval: PendingApproval) {
    const bots = await this.options.repository.listBotRecordsForSession(session.id);
    const currentSession = await this.options.getSession(session.id) ?? session;
    const workspaceName = sessionWorkspaceDisplayName(currentSession);
    await Promise.all(bots.flatMap(bot => bot.directChannelId
      ? [this.sendText(bot.id, bot.directChannelId, decorateWithWorkspace('⏸️ 等待审批', approvalMessageBody(approval), workspaceName), {
          sessionId: currentSession.id,
          turnId: approvalMessageTurnId(approval.id),
        })]
      : []));
  }

  async sendSessionError(session: MessagingSession, message: string) {
    const bots = await this.options.repository.listBotRecordsForSession(session.id);
    const heading = isInterruptedMessage(message) ? '🛑 已停止' : '❌ 执行失败';
    const workspaceName = sessionWorkspaceDisplayName(session);
    await Promise.all(bots.flatMap(bot => bot.directChannelId
      ? [this.sendText(bot.id, bot.directChannelId, decorateWithWorkspace(heading, message, workspaceName), {
          sessionId: session.id,
          turnId: session.activeTurnId,
        })]
      : []));
  }
}
