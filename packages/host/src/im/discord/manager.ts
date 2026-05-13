import { basename } from 'node:path';

import {
  ActivityType,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  SlashCommandBuilder,
  Status,
  type ChatInputCommandInteraction,
  type Message,
} from 'discord.js';

import type {
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
import { InteractiveFlowManager, type FlowGenerator } from '../messaging/interactive-flow.js';
import {
  type CommandFlowContext,
  executorLabel,
  newSessionFlow,
  switchSessionFlow,
  alterSessionFlow,
} from '../messaging/command-flows.js';
import type { DiscordBotRecord, DiscordCodingRepository } from './repository.js';

const DISCORD_MESSAGE_LIMIT = 1900;
const DISCORD_TYPING_HEARTBEAT_MS = 8_000;
const DISCORD_STATUS_ROTATION_MS = 4_000;
const DISCORD_PRESENCE_NAME_LIMIT = 120;
const DISCORD_RECONNECT_DELAY_MS = 5_000;
const DISCORD_RECONNECT_STALE_DELAY_MS = 20_000;
const DISCORD_HEALTH_CHECK_INTERVAL_MS = 60_000;
const DISCORD_HEALTH_CHECK_GRACE_MS = 90_000;
const DISCORD_HEALTH_PING_LIMIT_MS = 30_000;
const DISCORD_NO_SESSION_MESSAGE = '没有选中的 Session。请先使用 /new 创建或 /switch 切换 Session。';
const DISCORD_RUNNING_STATUSES = [
  '📖 正在阅读代码',
  '🌐 正在查资料',
  '🛠️ 正在处理',
  '🔨 正在修改',
  '🧪 正在跑检查',
  '📦 正在整理改动',
  '✍️ 正在整理结果',
] as const;
const NEW_COMMAND = new SlashCommandBuilder()
  .setName('new')
  .setDescription('创建新 Session。');

const SWITCH_COMMAND = new SlashCommandBuilder()
  .setName('switch')
  .setDescription('切换到已有 Session。');

const ALTER_COMMAND = new SlashCommandBuilder()
  .setName('alter')
  .setDescription('修改当前 Session 设置。');

const STOP_COMMAND = new SlashCommandBuilder()
  .setName('stop')
  .setDescription('停止当前任务并清空队列。');

const STATUS_COMMAND = new SlashCommandBuilder()
  .setName('status')
  .setDescription('显示当前状态。');

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

function discordWorkspaceLine(workspaceName: string) {
  return `工作目录：${workspaceName}`;
}

function decorateDiscordStatusWithWorkspace(status: string, workspaceName: string) {
  return `${status}\n${discordWorkspaceLine(workspaceName)}`;
}

function decorateDiscordMessageWithWorkspace(
  heading: string,
  body: string,
  workspaceName: string,
) {
  return `${heading}\n${discordWorkspaceLine(workspaceName)}\n\n${body}`;
}

function interactionCommandLabel(interaction: ChatInputCommandInteraction) {
  const parts = [interaction.commandName];
  try {
    const subcommand = interaction.options.getSubcommand(false);
    if (subcommand) {
      parts.push(subcommand);
    }
  } catch {
    // Commands without subcommands throw here.
  }
  return `/${parts.join(' ')}`;
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
    return {
      assistantText: null as string | null,
      errorMessage: null as string | null,
    };
  }

  return {
    assistantText: assistantTextFromTurn(thread, turnId),
    errorMessage: turn.error?.message ?? null,
  };
}

function chunkDiscordMessage(content: string) {
  const normalized = content.trim();
  if (normalized.length <= DISCORD_MESSAGE_LIMIT) {
    return [normalized];
  }

  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > DISCORD_MESSAGE_LIMIT) {
    const boundary = remaining.lastIndexOf('\n', DISCORD_MESSAGE_LIMIT);
    const nextIndex = boundary > Math.floor(DISCORD_MESSAGE_LIMIT * 0.5)
      ? boundary
      : DISCORD_MESSAGE_LIMIT;
    chunks.push(remaining.slice(0, nextIndex).trimEnd());
    remaining = remaining.slice(nextIndex).trimStart();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

function discordGatewayCloseReason(closeEvent: { code: number }) {
  return `Discord gateway disconnected (code=${closeEvent.code}).`;
}

export function isDiscordGatewayHandshakeTimeoutError(error: unknown) {
  return error instanceof Error
    && error.message.includes('Opening handshake has timed out')
    && error.stack?.includes('/node_modules/ws/lib/websocket.js') === true;
}

function truncateDiscordPresenceName(value: string) {
  const normalized = value.trim();
  if (normalized.length <= DISCORD_PRESENCE_NAME_LIMIT) {
    return normalized;
  }
  return `${normalized.slice(0, DISCORD_PRESENCE_NAME_LIMIT - 1).trimEnd()}…`;
}

function isInterruptedMessage(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return normalized.includes('interrupt')
    || normalized.includes('interrupted')
    || normalized.includes('stopped')
    || normalized.includes('cancelled')
    || normalized.includes('canceled')
    || normalized.includes('停止')
    || normalized.includes('中断')
    || normalized.includes('取消');
}

function sessionStatusLabel(session: SessionRecord | null) {
  return session?.status ?? 'not-started';
}

function sessionDisplayName(session: Pick<SessionRecord, 'title' | 'id'>) {
  const title = session.title.trim();
  return title || `Session ${session.id.slice(0, 8)}`;
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
    case '1':
    case 'a':
      return { decision: 'approve', scope: 'once' };
    case '2':
    case 'b':
      return { decision: 'approve', scope: 'session' };
    case '3':
    case 'c':
      return { decision: 'decline', scope: 'once' };
    default:
      return null;
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

function canAttachSessionToBot(session: SessionRecord, botId: string) {
  return session.botId === botId || !isBusySession(session);
}

function selectionDisplayName(
  workspace: Pick<WorkspaceSummary, 'name' | 'path'> | null,
  session: Pick<SessionRecord, 'title' | 'id'> | null,
) {
  if (workspace && session) {
    return `${workspaceDisplayName(workspace)} / ${sessionDisplayName(session)}`;
  }
  if (workspace) {
    return workspaceDisplayName(workspace);
  }
  return 'workspace not selected';
}

async function isDirectMessage(message: Message) {
  if (message.guildId) {
    return false;
  }

  try {
    const channel = message.channel.partial
      ? await message.channel.fetch()
      : message.channel;
    return channel.type === ChannelType.DM;
  } catch {
    return false;
  }
}

interface DiscordCodingManagerOptions extends MessagingPlatformOptions {
  repository: DiscordCodingRepository;
}

interface RawDiscordMessageCreate {
  id: string;
  channel_id: string;
  guild_id?: string;
  content?: string;
  attachments?: unknown[] | Record<string, unknown> | null;
  author?: {
    id: string;
    bot?: boolean;
  } | null;
  message_reference?: {
    message_id?: string;
  } | null;
}

export class DiscordCodingManager implements MessagingPlatform {
  readonly platformId = 'discord' as const;
  private readonly clients = new Map<string, Client>();
  private readonly flows = new InteractiveFlowManager();
  private readonly runIndicators = new Map<string, {
    botId: string;
    channelId: string;
    messageId: string | null;
    phaseIndex: number;
    typingTimer: NodeJS.Timeout;
    statusTimer: NodeJS.Timeout | null;
  }>();
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();
  private readonly healthCheckTimers = new Map<string, NodeJS.Timeout>();
  private readonly unhealthySinceByBot = new Map<string, number>();

  constructor(private readonly options: DiscordCodingManagerOptions) {}

  private clearReconnectTimer(botId: string) {
    const timer = this.reconnectTimers.get(botId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.reconnectTimers.delete(botId);
  }

  private clearHealthCheck(botId: string) {
    const timer = this.healthCheckTimers.get(botId);
    if (timer) {
      clearInterval(timer);
      this.healthCheckTimers.delete(botId);
    }
    this.unhealthySinceByBot.delete(botId);
  }

  private startHealthCheck(botId: string, client: Client) {
    this.clearHealthCheck(botId);
    const timer = setInterval(() => {
      void this.runHealthCheck(botId, client);
    }, DISCORD_HEALTH_CHECK_INTERVAL_MS);
    this.healthCheckTimers.set(botId, timer);
  }

  private gatewayHealthIssue(client: Pick<Client, 'isReady' | 'ws'>) {
    if (!client.isReady()) {
      return 'Discord gateway health check failed: client is not ready.';
    }
    if (client.ws.status !== Status.Ready) {
      return `Discord gateway health check failed: websocket status is ${Status[client.ws.status] ?? client.ws.status}.`;
    }
    const ping = client.ws.ping;
    if (!Number.isFinite(ping) || ping < 0) {
      return `Discord gateway health check failed: websocket ping is ${String(ping)}.`;
    }
    if (ping > DISCORD_HEALTH_PING_LIMIT_MS) {
      return `Discord gateway health check failed: websocket ping ${Math.round(ping)}ms exceeded ${DISCORD_HEALTH_PING_LIMIT_MS}ms.`;
    }
    return null;
  }

  private async runHealthCheck(botId: string, client: Client) {
    if (this.clients.get(botId) !== client) {
      this.clearHealthCheck(botId);
      return;
    }

    const issue = this.gatewayHealthIssue(client);
    if (!issue) {
      this.unhealthySinceByBot.delete(botId);
      return;
    }

    const unhealthySince = this.unhealthySinceByBot.get(botId);
    if (unhealthySince === undefined) {
      this.unhealthySinceByBot.set(botId, Date.now());
      this.options.log.warn(`${issue} Waiting for recovery before reconnecting.`);
      return;
    }
    if ((Date.now() - unhealthySince) < DISCORD_HEALTH_CHECK_GRACE_MS) {
      return;
    }

    this.unhealthySinceByBot.delete(botId);
    await this.markBotConnectionState(botId, {
      status: 'connecting',
      lastError: issue,
      updatedAt: new Date().toISOString(),
    });
    await this.stopBot(botId, null);
    this.scheduleReconnect(botId, issue);
  }

  private scheduleReconnect(botId: string, reason: string, delayMs = DISCORD_RECONNECT_DELAY_MS) {
    if (this.reconnectTimers.has(botId)) {
      return;
    }

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(botId);
      void this.syncBot(botId);
    }, delayMs);
    this.reconnectTimers.set(botId, timer);
    this.options.log.warn(`Discord bot reconnect scheduled for ${botId} in ${delayMs}ms: ${reason}`);
  }

  private async markBotConnectionState(
    botId: string,
    patch: Partial<Pick<DiscordBotRecord, 'status' | 'lastError' | 'lastConnectedAt' | 'updatedAt'>>,
  ) {
    await this.options.repository.updateBot(botId, patch).catch(() => undefined);
  }

  async recoverGatewayTimeout(reason = 'Discord websocket handshake timed out.') {
    const bots = await this.options.repository.listEnabledBotRecords();
    for (const [index, bot] of bots.entries()) {
      this.scheduleReconnect(bot.id, reason, DISCORD_RECONNECT_DELAY_MS + (index * 500));
    }
  }

  private async sendInteractionReply(interaction: ChatInputCommandInteraction, content: string) {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(content);
      return;
    }
    await interaction.reply(content);
  }

  private async ensureInteractionDeferred(interaction: ChatInputCommandInteraction) {
    if (interaction.deferred || interaction.replied) {
      return;
    }
    await interaction.deferReply();
  }

  private ownerForBot(bot: DiscordBotRecord) {
    return this.options.listUsers().find((entry) => entry.id === bot.ownerUserId) ?? null;
  }

  private async syncBotSelection(
    bot: DiscordBotRecord,
    patch: Partial<Pick<DiscordBotRecord, 'selectedWorkspaceId' | 'selectedSessionId'>>,
  ) {
    const nextBot = (await this.options.repository.updateBot(bot.id, {
      ...patch,
      updatedAt: new Date().toISOString(),
    })) ?? {
      ...bot,
      ...patch,
    };
    await this.syncBotPresence(nextBot);
    return nextBot;
  }

  private async attachSessionToBot(bot: DiscordBotRecord, session: SessionRecord) {
    if (session.botId === bot.id) {
      return session;
    }
    return (await this.options.repository.updateSession(session.id, {
      botId: bot.id,
      updatedAt: new Date().toISOString(),
    })) ?? {
      ...session,
      botId: bot.id,
    };
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
    const exact = models.find((entry) => (
      entry.model.toLowerCase() === normalizedQuery
      || entry.id.toLowerCase() === normalizedQuery
      || entry.displayName.toLowerCase() === normalizedQuery
    ));
    if (exact) {
      return exact;
    }

    const fuzzy = models.filter((entry) => (
      entry.model.toLowerCase().includes(normalizedQuery)
      || entry.id.toLowerCase().includes(normalizedQuery)
      || entry.displayName.toLowerCase().includes(normalizedQuery)
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

  private async loadCurrentWorkspaceContext(bot: DiscordBotRecord) {
    const owner = this.ownerForBot(bot);
    if (!owner || !bot.selectedWorkspaceId) {
      return {
        bot,
        owner,
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
      const nextBot = await this.syncBotSelection(bot, {
        selectedWorkspaceId: null,
        selectedSessionId: null,
      });
      return {
        bot: nextBot,
        owner,
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
      nextBot = await this.syncBotSelection(nextBot, {
        selectedSessionId: session?.id ?? null,
      });
    }

    const queuedTurnCount = session
      ? await this.options.repository.countQueuedTurns(session.id)
      : 0;
    return {
      bot: nextBot,
      owner,
      workspace,
      session,
      sessions,
      queuedTurnCount,
      workspaceMissing: false,
      sessionMissing,
    };
  }

  private async syncBotPresence(bot: DiscordBotRecord) {
    const client = this.clients.get(bot.id);
    if (!client?.user) {
      return;
    }

    const workspace = bot.selectedWorkspaceId
      ? await this.options.getWorkspaceForUser(bot.selectedWorkspaceId, bot.ownerUserId)
      : null;
    const session = bot.selectedSessionId
      ? await this.options.repository.getSessionForBot(bot.id, bot.selectedSessionId)
      : null;
    const activeSession = session && !session.archivedAt && (!workspace || session.workspaceId === workspace.id)
      ? session
      : null;
    const activityName = selectionDisplayName(workspace, activeSession);

    client.user.setPresence({
      status: 'online',
      activities: [{
        type: ActivityType.Watching,
        name: truncateDiscordPresenceName(activityName),
      }],
    });
  }

  private async syncLiveBotPresence(botId: string, fallbackBot: DiscordBotRecord) {
    const bot = (await this.options.repository.getBotRecord(botId)) ?? fallbackBot;
    try {
      await this.syncBotPresence(bot);
    } catch (error) {
      this.options.log.warn(`Discord bot presence sync failed for ${bot.ownerUsername}: ${this.options.errorMessage(error)}`);
    }
  }

  private async ensureBotDirectChannel(bot: DiscordBotRecord, channelId: string | null | undefined) {
    const nextChannelId = channelId?.trim() ?? null;
    if (!nextChannelId || bot.directChannelId === nextChannelId) {
      return bot;
    }
    return (await this.options.repository.updateBot(bot.id, {
      directChannelId: nextChannelId,
      updatedAt: new Date().toISOString(),
    })) ?? bot;
  }

  private async fetchSendableChannel(botId: string, channelId: string | null | undefined) {
    if (!channelId) {
      return null;
    }
    const client = this.clients.get(botId);
    if (!client) {
      return null;
    }
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !('send' in channel)) {
      return null;
    }
    return channel as {
      send(options: string | { content: string; reply?: { messageReference: string; failIfNotExists?: boolean } }): Promise<{ id: string }>;
      sendTyping(): Promise<void>;
      messages?: {
        fetch(messageId: string): Promise<{
          id: string;
          edit(options: string | { content: string; flags?: number }): Promise<{ id: string }>;
          react(emoji: string): Promise<unknown>;
        }>;
      };
    };
  }

  private async sendText(
    botId: string,
    channelId: string | null | undefined,
    content: string,
    options?: { replyToMessageId?: string | null },
  ) {
    if (!channelId) {
      return null;
    }
    const channel = await this.fetchSendableChannel(botId, channelId);
    if (!channel) {
      return null;
    }

    const outbox = await this.options.repository.createOutboxMessage({
      botId,
      channelId,
      content,
    });

    try {
      let sentMessageId: string | null = null;
      for (const chunk of chunkDiscordMessage(content)) {
        const sent = await channel.send(
          options?.replyToMessageId
            ? {
              content: chunk,
              reply: {
                messageReference: options.replyToMessageId,
                failIfNotExists: false,
              },
            }
            : chunk,
        );
        sentMessageId = sent.id;
      }
      await this.options.repository.markOutboxSent(outbox.id, sentMessageId);
      return sentMessageId;
    } catch (error) {
      const message = this.options.errorMessage(error);
      await this.options.repository.markOutboxError(outbox.id, message);
      await this.options.repository.updateBot(botId, {
        lastError: message,
        updatedAt: new Date().toISOString(),
      });
      return null;
    }
  }

  private async reactToMessage(botId: string, channelId: string, messageId: string, emoji: string) {
    const channel = await this.fetchSendableChannel(botId, channelId);
    const message = await channel?.messages?.fetch(messageId);
    if (!message) {
      return;
    }
    await message.react(emoji);
  }

  private async editChannelMessage(botId: string, channelId: string, messageId: string, content: string) {
    const channel = await this.fetchSendableChannel(botId, channelId);
    const message = await channel?.messages?.fetch(messageId);
    if (!message) {
      return false;
    }
    await message.edit({
      content,
      flags: MessageFlags.SuppressEmbeds,
    });
    return true;
  }

  private async sendTyping(botId: string, channelId: string) {
    const channel = await this.fetchSendableChannel(botId, channelId);
    await channel?.sendTyping();
  }

  private buildRunningStatus(phaseIndex: number, workspaceName: string | null = null) {
    const phase = DISCORD_RUNNING_STATUSES[phaseIndex % DISCORD_RUNNING_STATUSES.length] ?? DISCORD_RUNNING_STATUSES[0];
    const status = `${phase}...`;
    return workspaceName ? decorateDiscordStatusWithWorkspace(status, workspaceName) : status;
  }

  private async startRunIndicator(session: SessionRecord, channelId: string, statusMessageId: string | null) {
    if (!session.botId) {
      return;
    }
    await this.finishRunIndicator(session.id, null);

    const botId = session.botId;
    const workspaceName = sessionWorkspaceDisplayName(session);
    const indicator = {
      botId,
      channelId,
      messageId: statusMessageId,
      phaseIndex: 0,
      typingTimer: setInterval(() => {
        void this.sendTyping(botId, channelId).catch(() => undefined);
      }, DISCORD_TYPING_HEARTBEAT_MS),
      statusTimer: null as NodeJS.Timeout | null,
    };

    void this.sendTyping(botId, channelId).catch(() => undefined);
    if (indicator.messageId) {
      const statusMessageId = indicator.messageId;
      indicator.statusTimer = setInterval(() => {
        indicator.phaseIndex = (indicator.phaseIndex + 1) % DISCORD_RUNNING_STATUSES.length;
        void this.editChannelMessage(
          botId,
          channelId,
          statusMessageId,
          this.buildRunningStatus(indicator.phaseIndex, workspaceName),
        ).catch(() => undefined);
      }, DISCORD_STATUS_ROTATION_MS);
    }

    this.runIndicators.set(session.id, indicator);
  }

  private async finishRunIndicator(sessionId: string, finalContent: string | null) {
    const indicator = this.runIndicators.get(sessionId);
    if (!indicator) {
      return;
    }
    clearInterval(indicator.typingTimer);
    if (indicator.statusTimer) {
      clearInterval(indicator.statusTimer);
    }
    this.runIndicators.delete(sessionId);
    if (finalContent && indicator.messageId) {
      await this.editChannelMessage(indicator.botId, indicator.channelId, indicator.messageId, finalContent).catch(() => undefined);
    }
  }

  // ---- Flow infrastructure --------------------------------------------------

  private buildFlowContext(bot: DiscordBotRecord, owner: UserRecord): CommandFlowContext {
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

  private async startInteractiveFlow(
    bot: DiscordBotRecord,
    channelId: string,
    generator: FlowGenerator,
  ) {
    const result = await this.flows.startFlow({
      botId: bot.id,
      channelId,
      userId: bot.ownerUserId,
      generator,
      onExpire: () => {
        void this.sendText(bot.id, channelId, '⏰ 操作已超时，已取消。').catch(() => undefined);
      },
    });
    const sentMessageId = await this.sendText(bot.id, channelId, result.message);
    if (result.type === 'prompt' && sentMessageId) {
      this.flows.registerFlowMessage(bot.id, channelId, sentMessageId);
    }
  }

  // ---- Slash command handlers (interactive flow-based) --------------------

  private async handleCommandNew(bot: DiscordBotRecord, channelId: string) {
    const owner = this.ownerForBot(bot);
    if (!owner) { await this.sendText(bot.id, channelId, 'Bot owner no longer exists.'); return; }
    const ctx = this.buildFlowContext(bot, owner);
    await this.startInteractiveFlow(bot, channelId, newSessionFlow(ctx));
  }

  private async handleCommandSwitch(bot: DiscordBotRecord, channelId: string) {
    const owner = this.ownerForBot(bot);
    if (!owner) { await this.sendText(bot.id, channelId, 'Bot owner no longer exists.'); return; }
    const ctx = this.buildFlowContext(bot, owner);
    await this.startInteractiveFlow(bot, channelId, switchSessionFlow(ctx));
  }

  private async handleCommandAlter(bot: DiscordBotRecord, channelId: string) {
    const owner = this.ownerForBot(bot);
    if (!owner) { await this.sendText(bot.id, channelId, 'Bot owner no longer exists.'); return; }
    const context = await this.loadCurrentWorkspaceContext(bot);
    const ctx = this.buildFlowContext(bot, owner);
    ctx.currentSession = context.session;
    await this.startInteractiveFlow(bot, channelId, alterSessionFlow(ctx));
  }

  private async handleCommandStop(bot: DiscordBotRecord, channelId: string) {
    const context = await this.loadCurrentWorkspaceContext(bot);
    if (!context.owner || !context.workspace || !context.session) {
      await this.sendText(bot.id, channelId, '没有活动的 Session。');
      return;
    }
    const session = context.session;
    if (!session.activeTurnId && context.queuedTurnCount === 0) {
      await this.sendText(bot.id, channelId, '当前没有正在执行的任务。');
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
    await this.sendText(bot.id, channelId, '✅ 已停止所有活动任务，队列已清空。');
  }

  private async handleCommandStatus(bot: DiscordBotRecord, channelId: string) {
    const context = await this.loadCurrentWorkspaceContext(bot);
    if (!context.owner) {
      await this.sendText(bot.id, channelId, 'This bot owner no longer exists locally.');
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
    await this.sendText(bot.id, channelId, lines.join('\n'));
  }

  private async handleInteraction(botId: string, interaction: ChatInputCommandInteraction) {
    let bot = await this.options.repository.getBotRecord(botId);
    if (!bot || !bot.enabled) {
      return;
    }

    if (interaction.guildId) {
      await interaction.reply('This bot only accepts Discord DM commands.');
      return;
    }

    if (!(await this.options.repository.recordInboundEvent({
      id: interaction.id,
      botId,
      kind: 'interaction',
      channelId: interaction.channelId,
      authorId: interaction.user.id,
    }))) {
      return;
    }

    bot = await this.ensureBotDirectChannel(bot, interaction.channelId);
    if (bot.allowedDiscordUserId && bot.allowedDiscordUserId !== interaction.user.id) {
      await interaction.reply('This bot is not configured for your Discord account.');
      return;
    }

    // Acknowledge immediately, then dispatch to flow-based handlers
    await this.ensureInteractionDeferred(interaction);
    const latestBot = (await this.options.repository.getBotRecord(botId)) ?? bot;

    switch (interaction.commandName) {
      case 'new':
        await this.handleCommandNew(latestBot, interaction.channelId);
        break;
      case 'switch':
        await this.handleCommandSwitch(latestBot, interaction.channelId);
        break;
      case 'alter':
        await this.handleCommandAlter(latestBot, interaction.channelId);
        break;
      case 'stop':
        await this.handleCommandStop(latestBot, interaction.channelId);
        break;
      case 'status':
        await this.handleCommandStatus(latestBot, interaction.channelId);
        break;
      default:
        await this.sendInteractionReply(interaction, 'Unknown command.');
        return;
    }
    // Send a minimal deferred reply acknowledgement if not already replied
    if (!interaction.replied) {
      await this.sendInteractionReply(interaction, '✅').catch(() => undefined);
    }
  }

  private async createSession(bot: DiscordBotRecord, workspace: WorkspaceSummary, input?: MessagingSessionCreateInput) {
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

  private async handleInboundPrompt(input: InboundPromptInput) {
    let bot = await this.options.repository.getBotRecord(input.botId);
    if (!bot || !bot.enabled) {
      return;
    }

    if (!(await this.options.repository.recordInboundEvent({
      id: input.messageId,
      botId: input.botId,
      kind: 'message',
      channelId: input.channelId,
      authorId: input.authorId,
    }))) {
      return;
    }
    await this.reactToMessage(input.botId, input.channelId, input.messageId, '👀').catch(() => undefined);

    bot = await this.ensureBotDirectChannel(bot, input.channelId);
    if (bot.allowedDiscordUserId && bot.allowedDiscordUserId !== input.authorId) {
      await input.reply('This bot is not configured for your Discord account.');
      return;
    }

    const prompt = trimPrompt(input.content);
    if (!prompt) {
      await input.reply('Only plain-text prompts are supported in Discord right now.');
      return;
    }

    // -- Reply handling: flow replies ----------------------------------------
    if (input.threadTs) {
      const flowResult = await this.flows.handleReply(input.threadTs, prompt);
      if (flowResult) {
        const sentReply = await input.reply(flowResult.message);
        if (flowResult.type === 'prompt' && sentReply.messageId) {
          this.flows.registerFlowMessage(input.botId, input.channelId, sentReply.messageId);
        }
        return;
      }
      // Not a flow reply — fall through to normal handling
    }

    if (input.attachmentCount > 0) {
      await input.reply('Discord attachments are not supported in coding mode yet.');
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
      await input.reply(DISCORD_NO_SESSION_MESSAGE);
      return;
    }

    const { workspace, session } = context;
    const pendingApproval = this.options.getApprovals(session.id)[0] ?? null;
    const approvalAction = pendingApproval ? approvalReplyAction(prompt) : null;
    if (pendingApproval && approvalAction) {
      if (approvalAction.scope === 'session' && !approvalSupportsSessionScope(pendingApproval)) {
        await input.reply(`⚠️ 当前审批不支持 session 持续批准，请回复 1/a 或 3/c。\n${discordWorkspaceLine(workspaceDisplayName(workspace))}`);
        return;
      }

      try {
        await this.options.resolveApproval(session, pendingApproval.id, approvalAction);
      } catch (error) {
        await input.reply(`❌ 审批处理失败\n${discordWorkspaceLine(workspaceDisplayName(workspace))}\n\n${this.options.errorMessage(error)}`);
        return;
      }

      const confirmation = approvalAction.decision === 'decline'
        ? '🛑 已拒绝审批请求。'
        : approvalAction.scope === 'session'
          ? '✅ 已批准，并记住当前 session 的审批选择。'
          : '✅ 已批准一次，继续执行。';
      await input.reply(`${confirmation}\n${discordWorkspaceLine(workspaceDisplayName(workspace))}`);
      return;
    }
    if (session.status === 'needs-approval') {
      if (pendingApproval) {
        const approvalHint = approvalSupportsSessionScope(pendingApproval)
          ? '请回复 1/a、2/b 或 3/c。'
          : '请回复 1/a 或 3/c。';
        await input.reply(`⏸️ 当前 session 正在等待审批，${approvalHint}\n${discordWorkspaceLine(workspaceDisplayName(workspace))}`);
        return;
      }
      await input.reply(`⏸️ 当前 session 正在等待审批，请先处理审批后再发送新任务。\n${discordWorkspaceLine(workspaceDisplayName(workspace))}`);
      return;
    }

    try {
      if (isBusySession(session)) {
        await this.options.queueTurn(session, prompt);
        await input.reply(`⏳ 已收到，当前正在执行任务，已经帮你排队。\n${discordWorkspaceLine(workspaceDisplayName(workspace))}`);
        return;
      }

      if (context.queuedTurnCount > 0) {
        await this.options.queueTurn(session, prompt);
        await input.reply(`⏳ 已收到，当前前面还有 ${context.queuedTurnCount} 个待执行任务，已加入队列。\n${discordWorkspaceLine(workspaceDisplayName(workspace))}`);
        return;
      }

      const statusReply = await input.reply(decorateDiscordStatusWithWorkspace('🛠️ 正在处理...', workspaceDisplayName(workspace)));
      await this.options.startTurnWithAutoRestart(session, prompt, []);
      await this.startRunIndicator(session, input.channelId, statusReply.messageId);
    } catch (error) {
      await this.finishRunIndicator(session.id, decorateDiscordStatusWithWorkspace('❌ 启动失败', workspaceDisplayName(workspace)));
      await input.reply(`❌ 启动失败\n${discordWorkspaceLine(workspaceDisplayName(workspace))}\n\n${this.options.errorMessage(error)}`);
    }
  }

  private async handleMessage(botId: string, message: Message) {
    if (message.author.bot || !(await isDirectMessage(message))) {
      return;
    }

    await this.handleInboundPrompt({
      botId,
      messageId: message.id,
      channelId: message.channelId,
      authorId: message.author.id,
      content: message.content,
      attachmentCount: message.attachments.size,
      threadTs: message.reference?.messageId ?? null,
      reply: async (content) => {
        const sent = await message.reply(content);
        return { messageId: sent.id };
      },
    });
  }

  private async handleRawMessage(botId: string, data: RawDiscordMessageCreate) {
    if (!data?.id || !data.channel_id || data.guild_id || !data.author?.id || data.author.bot) {
      return;
    }

    const attachmentCount = Array.isArray(data.attachments)
      ? data.attachments.length
      : data.attachments && typeof data.attachments === 'object'
        ? Object.keys(data.attachments).length
        : 0;

    await this.handleInboundPrompt({
      botId,
      messageId: data.id,
      channelId: data.channel_id,
      authorId: data.author.id,
      content: typeof data.content === 'string' ? data.content : '',
      attachmentCount,
      threadTs: data.message_reference?.message_id ?? null,
      reply: async (content) => ({
        messageId: await this.sendText(botId, data.channel_id, content, {
          replyToMessageId: data.id,
        }),
      }),
    });
    this.options.log.info(`Discord raw DM received for bot ${botId}`);
  }

  private async registerCommands(client: Client) {
    if (!client.application) {
      return;
    }
    await client.application.commands.set([
      NEW_COMMAND.toJSON(),
      SWITCH_COMMAND.toJSON(),
      ALTER_COMMAND.toJSON(),
      STOP_COMMAND.toJSON(),
      STATUS_COMMAND.toJSON(),
    ]);
  }

  private async startBot(bot: DiscordBotRecord) {
    await this.stopBot(bot.id);
    this.clearReconnectTimer(bot.id);
    const token = await this.options.decryptToken(bot.tokenCiphertext);
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.User],
    });

    client.once(Events.ClientReady, async (readyClient) => {
      try {
        this.clearReconnectTimer(bot.id);
        this.startHealthCheck(bot.id, client);
        await this.options.repository.updateBot(bot.id, {
          applicationId: readyClient.application?.id ?? bot.applicationId,
          botUserId: readyClient.user.id,
          status: 'connected',
          lastError: null,
          lastConnectedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        await this.registerCommands(readyClient);
        await this.syncLiveBotPresence(bot.id, bot);
        this.options.log.info(`Discord bot connected for ${bot.ownerUsername}`);
      } catch (error) {
        this.options.log.warn(`Discord bot ready handler failed for ${bot.ownerUsername}: ${this.options.errorMessage(error)}`);
      }
    });

    client.on(Events.ShardReady, async () => {
      this.clearReconnectTimer(bot.id);
      this.startHealthCheck(bot.id, client);
      await this.markBotConnectionState(bot.id, {
        status: 'connected',
        lastError: null,
        lastConnectedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await this.syncLiveBotPresence(bot.id, bot);
    });

    client.on(Events.ShardResume, async () => {
      this.clearReconnectTimer(bot.id);
      this.startHealthCheck(bot.id, client);
      await this.markBotConnectionState(bot.id, {
        status: 'connected',
        lastError: null,
        lastConnectedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await this.syncLiveBotPresence(bot.id, bot);
    });

    client.on(Events.ShardReconnecting, async (shardId) => {
      const message = `Discord shard ${shardId} is reconnecting.`;
      this.clearHealthCheck(bot.id);
      await this.markBotConnectionState(bot.id, {
        status: 'connecting',
        lastError: message,
        updatedAt: new Date().toISOString(),
      });
      this.scheduleReconnect(bot.id, message, DISCORD_RECONNECT_STALE_DELAY_MS);
    });

    client.on(Events.ShardDisconnect, async (closeEvent, shardId) => {
      const message = `Discord shard ${shardId} disconnected. ${discordGatewayCloseReason(closeEvent)}`;
      this.clearHealthCheck(bot.id);
      await this.markBotConnectionState(bot.id, {
        status: 'error',
        lastError: message,
        updatedAt: new Date().toISOString(),
      });
      this.scheduleReconnect(bot.id, message);
    });

    client.on(Events.ShardError, async (error, shardId) => {
      const message = `Discord shard ${shardId} error: ${this.options.errorMessage(error)}`;
      this.clearHealthCheck(bot.id);
      await this.markBotConnectionState(bot.id, {
        status: 'connecting',
        lastError: message,
        updatedAt: new Date().toISOString(),
      });
      this.scheduleReconnect(bot.id, message, DISCORD_RECONNECT_STALE_DELAY_MS);
    });

    client.on(Events.Invalidated, async () => {
      const message = 'Discord gateway session invalidated.';
      this.clearHealthCheck(bot.id);
      await this.markBotConnectionState(bot.id, {
        status: 'error',
        lastError: message,
        updatedAt: new Date().toISOString(),
      });
      await this.stopBot(bot.id, null);
      this.scheduleReconnect(bot.id, message);
    });

    client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand()) {
        return;
      }
      await this.handleInteraction(bot.id, interaction).catch((error) => {
        const message = this.options.errorMessage(error);
        const commandLabel = interactionCommandLabel(interaction);
        this.options.log.warn(`Discord interaction failed for ${bot.ownerUsername} ${commandLabel}: ${message}`);
        if (message.includes('Unknown interaction')) {
          void this.sendText(
            bot.id,
            interaction.channelId,
            `❌ Discord 命令响应超时，请重试。\n命令：${commandLabel}`,
          ).catch(() => undefined);
        }
      });
    });

    client.on(Events.MessageCreate, async (message) => {
      await this.handleMessage(bot.id, message).catch((error) => {
        this.options.log.warn(`Discord DM failed for ${bot.ownerUsername}: ${this.options.errorMessage(error)}`);
      });
    });

    client.on(Events.Raw, async (packet) => {
      if (packet.t !== 'MESSAGE_CREATE') {
        return;
      }
      await this.handleRawMessage(bot.id, packet.d as RawDiscordMessageCreate).catch((error) => {
        this.options.log.warn(`Discord raw DM failed for ${bot.ownerUsername}: ${this.options.errorMessage(error)}`);
      });
    });

    client.on(Events.Error, async (error) => {
      const message = this.options.errorMessage(error);
      const reconnectDelay = isDiscordGatewayHandshakeTimeoutError(error)
        ? DISCORD_RECONNECT_DELAY_MS
        : DISCORD_RECONNECT_STALE_DELAY_MS;
      await this.options.repository.updateBot(bot.id, {
        status: client.isReady() ? 'error' : 'connecting',
        lastError: message,
        updatedAt: new Date().toISOString(),
      });
      if (!client.isReady() || isDiscordGatewayHandshakeTimeoutError(error)) {
        this.clearHealthCheck(bot.id);
        this.scheduleReconnect(bot.id, message, reconnectDelay);
      }
    });

    this.clients.set(bot.id, client);
    await this.options.repository.updateBot(bot.id, {
      status: 'connecting',
      lastError: null,
      updatedAt: new Date().toISOString(),
    });

    try {
      await client.login(token);
    } catch (error) {
      this.clearHealthCheck(bot.id);
      this.clients.delete(bot.id);
      client.destroy();
      await this.options.repository.updateBot(bot.id, {
        status: 'error',
        lastError: this.options.errorMessage(error),
        updatedAt: new Date().toISOString(),
      });
      this.scheduleReconnect(bot.id, this.options.errorMessage(error));
      throw error;
    }
  }

  async syncBot(botId: string) {
    const bot = await this.options.repository.getBotRecord(botId);
    if (!bot || !bot.enabled) {
      await this.stopBot(botId, bot ? 'disabled' : null);
      return;
    }

    try {
      await this.startBot(bot);
    } catch (error) {
      this.options.log.warn(`Discord bot start failed for ${bot.ownerUsername}: ${this.options.errorMessage(error)}`);
    }
  }

  async startAll() {
    const bots = await this.options.repository.listEnabledBotRecords();
    await Promise.all(bots.map(async (bot) => {
      await this.syncBot(bot.id);
    }));
  }

  async stopBot(botId: string, status: 'disabled' | null = 'disabled') {
    this.clearReconnectTimer(botId);
    this.clearHealthCheck(botId);
    for (const [sessionId, indicator] of this.runIndicators.entries()) {
      if (indicator.botId !== botId) {
        continue;
      }
      clearInterval(indicator.typingTimer);
      if (indicator.statusTimer) {
        clearInterval(indicator.statusTimer);
      }
      this.runIndicators.delete(sessionId);
    }
    const existing = this.clients.get(botId);
    this.clients.delete(botId);
    if (existing) {
      existing.destroy();
    }
    if (status) {
      await this.options.repository.updateBot(botId, {
        status,
        updatedAt: new Date().toISOString(),
      }).catch(() => undefined);
    }
  }

  async shutdown() {
    this.flows.shutdown();
    await Promise.all([...this.clients.keys()].map(async (botId) => {
      await this.stopBot(botId, null);
    }));
  }

  async sendTurnCompletion(session: SessionRecord, thread: CodexThread | null, turnId: string | null) {
    if (session.origin !== 'discord' || !session.botId || !turnId) {
      return;
    }
    const bot = await this.options.repository.getBotRecord(session.botId);
    if (!bot?.directChannelId || !thread) {
      return;
    }

    const currentSession = await this.options.repository.getSession(session.id) ?? session;
    const workspaceName = sessionWorkspaceDisplayName(currentSession);
    const summary = summarizeTurn(thread, turnId);
    const pendingApproval = this.options.getApprovals(currentSession.id)[0] ?? null;
    if (currentSession.status === 'error' && summary.errorMessage) {
      return;
    }

    const currentJob = currentSession.job;
    let heading = '✅ 已完成';
    let body = currentJob?.finalOutput ?? summary.assistantText ?? null;

    if (currentJob) {
      switch (currentJob.state) {
        case 'waiting-approval':
          heading = '⏸️ 等待审批';
          body = pendingApproval
            ? approvalMessageBody(pendingApproval, currentJob.waitingReason ?? body)
            : currentJob.waitingReason ?? body;
          break;
        case 'waiting-input':
          heading = '⏸️ 需要补充信息';
          body = currentJob.waitingReason ?? body;
          break;
        case 'budget-exhausted':
          heading = '⚠️ 已达到轮数上限';
          body = currentJob.waitingReason ?? currentJob.finalOutput ?? body;
          break;
        case 'failed':
          heading = '❌ 执行失败';
          body = currentJob.waitingReason ?? currentJob.finalOutput ?? summary.errorMessage ?? body;
          break;
        case 'completed':
          heading = '✅ 已完成';
          body = currentJob.finalOutput ?? body;
          break;
        default:
          heading = '✅ 已完成';
          break;
      }
    } else if (summary.errorMessage) {
      heading = '❌ 执行失败';
      body = summary.errorMessage;
    }

    await this.finishRunIndicator(session.id, decorateDiscordStatusWithWorkspace(heading, workspaceName));
    if (!body?.trim()) {
      return;
    }
    await this.sendText(bot.id, bot.directChannelId, decorateDiscordMessageWithWorkspace(heading, body, workspaceName));
  }

  async sendApprovalRequested(session: SessionRecord, approval: PendingApproval) {
    if (session.origin !== 'discord' || !session.botId || (session.executionMode ?? 'interactive') === 'job') {
      return;
    }
    const bot = await this.options.repository.getBotRecord(session.botId);
    if (!bot?.directChannelId) {
      return;
    }
    const currentSession = await this.options.repository.getSession(session.id) ?? session;
    const workspaceName = sessionWorkspaceDisplayName(currentSession);
    await this.finishRunIndicator(session.id, decorateDiscordStatusWithWorkspace('⏸️ 等待审批', workspaceName));
    await this.sendText(
      bot.id,
      bot.directChannelId,
      decorateDiscordMessageWithWorkspace('⏸️ 等待审批', approvalMessageBody(approval), workspaceName),
    );
  }

  async sendSessionError(session: SessionRecord, message: string) {
    if (session.origin !== 'discord' || !session.botId) {
      return;
    }
    const bot = await this.options.repository.getBotRecord(session.botId);
    if (!bot?.directChannelId) {
      return;
    }
    const interrupted = isInterruptedMessage(message);
    const heading = interrupted ? '🛑 已停止' : '❌ 执行失败';
    const workspaceName = sessionWorkspaceDisplayName(session);
    await this.finishRunIndicator(session.id, decorateDiscordStatusWithWorkspace(heading, workspaceName));
    await this.sendText(bot.id, bot.directChannelId, decorateDiscordMessageWithWorkspace(heading, message, workspaceName));
  }
}
