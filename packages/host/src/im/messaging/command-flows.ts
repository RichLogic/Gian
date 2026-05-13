/**
 * Shared interactive command flow definitions for Discord and Slack.
 *
 * Each flow is an async generator that yields prompt strings,
 * receives user reply strings, and returns a completion message.
 */

import type { AgentExecutor, ModelOption, ReasoningEffort, SessionRecord, WorkspaceSummary } from '../types.js';
import { messagingSessionModeFromRecord, messagingSessionModePreferences } from './mode.js';
import type { MessagingSessionMode } from './types.js';
import type { FlowGenerator } from './interactive-flow.js';

// ---------------------------------------------------------------------------
// Flow context — everything the flow generators need from the platform
// ---------------------------------------------------------------------------

export interface CommandFlowContext {
  /** Executors that have a running runtime. */
  availableExecutors: AgentExecutor[];

  /** Current selected session (for /alter). */
  currentSession: SessionRecord | null;

  // Queries
  listWorkspaces(): Promise<WorkspaceSummary[]>;
  listSessions(workspaceId: string): Promise<SessionRecord[]>;
  listModels(executor?: AgentExecutor): ModelOption[];
  currentModelOption(session: SessionRecord): ModelOption | null;
  currentReasoningEffort(session: SessionRecord): ReasoningEffort;
  preferredReasoningEffortForModel(model: ModelOption): ReasoningEffort;

  // Mutations
  createSession(executor: AgentExecutor, workspace: WorkspaceSummary, title?: string): Promise<SessionRecord>;
  switchToSession(workspace: WorkspaceSummary, session: SessionRecord): Promise<void>;
  updateSessionModel(model: string, reasoningEffort: ReasoningEffort): Promise<void>;
  updateSessionMode(mode: MessagingSessionMode): Promise<void>;
  updateSessionReasoning(level: ReasoningEffort): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CANCELLED = '已取消。';

function formatPrompt(title: string, options: string[]): string {
  return [title, '0. 取消', ...options.map((o, i) => `${i + 1}. ${o}`)].join('\n');
}

function parseChoice(reply: string, max: number): number | null {
  const n = parseInt(reply, 10);
  return !Number.isNaN(n) && n >= 0 && n <= max ? n : null;
}

export function executorLabel(executor: AgentExecutor): string {
  switch (executor) {
    case 'codex': return 'Codex';
    case 'claude': return 'Claude Code';
    default: return executor;
  }
}

export function workspaceDisplayName(workspace: Pick<WorkspaceSummary, 'name' | 'path'>): string {
  if (workspace.name) return workspace.name;
  const last = workspace.path.split('/').filter(Boolean).pop();
  return last || workspace.path;
}

export function sessionDisplayName(session: Pick<SessionRecord, 'title' | 'id'>): string {
  const title = session.title.trim();
  return title || `Session ${session.id.slice(0, 8)}`;
}

function sessionStatusLabel(session: Pick<SessionRecord, 'status' | 'activeTurnId'>): string {
  if (session.activeTurnId) return 'running';
  return session.status;
}

// ---------------------------------------------------------------------------
// /new — create a new session
// ---------------------------------------------------------------------------

export async function* newSessionFlow(ctx: CommandFlowContext): FlowGenerator {
  // Step 1: Agent
  const executors = ctx.availableExecutors;
  if (executors.length === 0) return '没有可用的 Agent。';

  const p1 = formatPrompt('选择 Agent：', executors.map(executorLabel));
  let reply = yield p1;
  let choice = parseChoice(reply, executors.length);
  while (choice === null) {
    reply = yield `无效选择，请重新输入。\n\n${p1}`;
    choice = parseChoice(reply, executors.length);
  }
  if (choice === 0) return CANCELLED;
  const executor = executors[choice - 1]!;

  // Step 2: Workspace
  const workspaces = await ctx.listWorkspaces();
  if (workspaces.length === 0) return '没有可用的 Workspace。';

  const p2 = formatPrompt('选择 Workspace：', workspaces.map(workspaceDisplayName));
  reply = yield p2;
  choice = parseChoice(reply, workspaces.length);
  while (choice === null) {
    reply = yield `无效选择，请重新输入。\n\n${p2}`;
    choice = parseChoice(reply, workspaces.length);
  }
  if (choice === 0) return CANCELLED;
  const workspace = workspaces[choice - 1]!;

  // Step 3: Session title
  const p3 = '输入 Session 名称：\n0. 取消\n1. 使用默认名称\n或直接输入自定义名称';
  reply = yield p3;
  if (reply === '0') return CANCELLED;
  const title = reply === '1' ? undefined : reply.trim() || undefined;

  // Create
  const session = await ctx.createSession(executor, workspace, title);
  const mode = messagingSessionModeFromRecord(session);
  return [
    `✅ 已创建 Session: ${sessionDisplayName(session)}`,
    `Agent: ${executorLabel(executor)} | Mode: ${mode} | Model: ${session.model ?? 'default'}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// /switch — switch to an existing session
// ---------------------------------------------------------------------------

export async function* switchSessionFlow(ctx: CommandFlowContext): FlowGenerator {
  // Step 1: Workspace
  const workspaces = await ctx.listWorkspaces();
  if (workspaces.length === 0) return '没有可用的 Workspace。';

  const sessionCounts = await Promise.all(
    workspaces.map((ws) => ctx.listSessions(ws.id).then((s) => s.length)),
  );
  const wsOptions = workspaces.map(
    (ws, i) => `${workspaceDisplayName(ws)} (${sessionCounts[i]} sessions)`,
  );
  const p1 = formatPrompt('选择 Workspace：', wsOptions);
  let reply = yield p1;
  let choice = parseChoice(reply, workspaces.length);
  while (choice === null) {
    reply = yield `无效选择，请重新输入。\n\n${p1}`;
    choice = parseChoice(reply, workspaces.length);
  }
  if (choice === 0) return CANCELLED;
  const workspace = workspaces[choice - 1]!;

  // Step 2: Session
  const sessions = await ctx.listSessions(workspace.id);
  if (sessions.length === 0) return `${workspaceDisplayName(workspace)} 没有可用的 Session。使用 /new 创建一个。`;

  const sessionOptions = sessions.map(
    (s) => `${sessionDisplayName(s)} [${sessionStatusLabel(s)}] — ${executorLabel(s.executor)} / ${s.model ?? 'default'}`,
  );
  const p2 = formatPrompt('选择 Session：', sessionOptions);
  reply = yield p2;
  choice = parseChoice(reply, sessions.length);
  while (choice === null) {
    reply = yield `无效选择，请重新输入。\n\n${p2}`;
    choice = parseChoice(reply, sessions.length);
  }
  if (choice === 0) return CANCELLED;
  const session = sessions[choice - 1]!;

  await ctx.switchToSession(workspace, session);
  return `✅ 已切换到 ${sessionDisplayName(session)}（${workspaceDisplayName(workspace)}）`;
}

// ---------------------------------------------------------------------------
// /alter — modify current session settings
// ---------------------------------------------------------------------------

export async function* alterSessionFlow(ctx: CommandFlowContext): FlowGenerator {
  const session = ctx.currentSession;
  if (!session) return '没有选中的 Session。请先使用 /switch 选择一个。';

  // Step 1: What to change
  const p1 = formatPrompt('修改什么？', ['Model', 'Mode', 'Thinking']);
  let reply = yield p1;
  let choice = parseChoice(reply, 3);
  while (choice === null) {
    reply = yield `无效选择，请重新输入。\n\n${p1}`;
    choice = parseChoice(reply, 3);
  }
  if (choice === 0) return CANCELLED;

  if (choice === 1) return yield* alterModel(ctx, session);
  if (choice === 2) return yield* alterMode(ctx, session);
  return yield* alterThinking(ctx, session);
}

async function* alterModel(ctx: CommandFlowContext, session: SessionRecord): FlowGenerator {
  const models = ctx.listModels(session.executor).filter((m) => !m.hidden);
  if (models.length === 0) return '没有可用的 Model。';

  const currentModel = session.model;
  const options = models.map(
    (m) => `${m.model}${m.model === currentModel ? ' (当前)' : ''}`,
  );
  const p = formatPrompt(`当前 Model: ${currentModel ?? 'default'}\n选择 Model：`, options);
  let reply = yield p;
  let choice = parseChoice(reply, models.length);
  while (choice === null) {
    reply = yield `无效选择，请重新输入。\n\n${p}`;
    choice = parseChoice(reply, models.length);
  }
  if (choice === 0) return CANCELLED;

  const selected = models[choice - 1]!;
  const reasoning = ctx.preferredReasoningEffortForModel(selected);
  await ctx.updateSessionModel(selected.model, reasoning);
  return `✅ Model 已切换为 ${selected.model}，Thinking: ${reasoning}`;
}

async function* alterMode(
  _ctx: CommandFlowContext,
  session: SessionRecord,
): FlowGenerator {
  const currentMode = messagingSessionModeFromRecord(session);
  // Three Gian modes — rvc-derived flow originally listed only two.
  const modes: MessagingSessionMode[] = ['plan', 'ask', 'auto'];
  const labels: Record<MessagingSessionMode, string> = {
    plan: 'Plan (read-only / planning)',
    ask: 'Ask (每个 risky action 都问)',
    auto: 'Auto (全自动,不打扰)',
  };
  const options = modes.map(
    (m) => `${labels[m]}${m === currentMode ? ' (当前)' : ''}`,
  );
  const p = formatPrompt(`当前 Mode: ${currentMode}\n选择 Mode：`, options);
  let reply = yield p;
  let choice = parseChoice(reply, modes.length);
  while (choice === null) {
    reply = yield `无效选择，请重新输入。\n\n${p}`;
    choice = parseChoice(reply, modes.length);
  }
  if (choice === 0) return CANCELLED;

  const selected = modes[choice - 1]!;
  if (selected === currentMode) return `当前已是 ${currentMode}，无需修改。`;
  await _ctx.updateSessionMode(selected);
  return `✅ Mode 已切换为 ${selected}`;
}

async function* alterThinking(
  ctx: CommandFlowContext,
  session: SessionRecord,
): FlowGenerator {
  const modelOption = ctx.currentModelOption(session);
  if (!modelOption) return '无法获取当前 Model 信息。';

  const efforts = modelOption.supportedReasoningEfforts;
  if (efforts.length === 0) return '当前 Model 不支持调整 Thinking。';

  const current = ctx.currentReasoningEffort(session);
  const options = efforts.map(
    (e) => `${e}${e === current ? ' (当前)' : ''}`,
  );
  const p = formatPrompt(`当前 Thinking: ${current}\n选择 Thinking：`, options);
  let reply = yield p;
  let choice = parseChoice(reply, efforts.length);
  while (choice === null) {
    reply = yield `无效选择，请重新输入。\n\n${p}`;
    choice = parseChoice(reply, efforts.length);
  }
  if (choice === 0) return CANCELLED;

  const selected = efforts[choice - 1]!;
  await ctx.updateSessionReasoning(selected);
  return `✅ Thinking 已切换为 ${selected}`;
}
