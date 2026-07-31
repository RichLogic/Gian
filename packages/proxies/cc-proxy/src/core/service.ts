import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';

import type { TokenUsageUpdate } from '@gian/shared';
import { createAppError } from './errors.js';
import { normalizeInputItems } from './input.js';
import { listAllSlashCommands } from './slash.js';
import type {
  ApprovalResponseParams,
  CapabilitiesPayload,
  CloseSessionParams,
  CreateSessionParams,
  GetSessionParams,
  InputItem,
  InitializePayload,
  InterruptTurnParams,
  PendingApproval,
  SessionRecord,
  SessionSnapshotParams,
  StartTurnParams,
} from './types.js';
import { nowIso, randomId } from './utils.js';
import type { ClaudeAgentTaskUpdate, ClaudeRuntime } from '../runtime/types.js';

type ProxyEventSink = (method: string, params: Record<string, unknown>) => void;

interface ServiceOptions {
  runtime: ClaudeRuntime;
  emitEvent?: ProxyEventSink;
}

function normalizeNonEmptyString(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw createAppError(400, 'INVALID_REQUEST', `${field} is required.`);
  }
  return value.trim();
}

// exported for tests
export function buildPrompt(input: InputItem[]): string {
  const parts: string[] = [];
  for (const item of input) {
    if (item.type === 'text' && typeof item.text === 'string' && item.text.length > 0) {
      parts.push(item.text);
    } else if (item.type === 'localImage' && typeof item.path === 'string' && item.path.length > 0) {
      parts.push(`[Attached image: ${item.path}]`);
    } else if (item.type === 'localFile' && typeof item.path === 'string' && item.path.length > 0) {
      parts.push(`[Attached file: ${item.path}]`);
    }
  }
  return parts.join('\n\n');
}

/** Serialize the user's AskUserQuestion answers into the deny-message body
 *  the model sees when claude CLI relays the permission-prompt-tool denial.
 *  Single-select values come through as `string`, multi-select as `string[]`,
 *  free-text comes in as a string (caller is responsible for that). */
export function formatQuestionAnswers(answers: Record<string, string | string[]>): string {
  const lines: string[] = [
    'The user answered your AskUserQuestion via the Gian web UI rather than letting the tool run. Use these answers and continue as if AskUserQuestion had returned them.',
    '',
  ];
  for (const [question, value] of Object.entries(answers)) {
    lines.push(`Q: ${question}`);
    if (Array.isArray(value)) {
      lines.push(`A: ${value.join('; ')}`);
    } else {
      lines.push(`A: ${value}`);
    }
    lines.push('');
  }
  // Drop the trailing blank line for a tidy payload — the model is happier
  // when the deny message doesn't end with stray whitespace.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/** Older Claude CLI builds may omit `contextWindow`; only infer it when the
 * detected model id carries an explicit capacity marker. */
function inferContextWindow(modelId: string | null): number | undefined {
  return modelId?.includes('[1m]') ? 1_000_000 : undefined;
}

export class CcProxyService {
  private readonly runtime: ClaudeRuntime;
  private emitEvent: ProxyEventSink;
  private readonly sessionsById = new Map<string, SessionRecord>();
  private readonly approvalsById = new Map<string, PendingApproval>();
  private readonly approvalsBySessionId = new Map<string, Map<string, PendingApproval>>();
  /** Tracks the current turn and upstream requestId per session. */
  private readonly activeTurns = new Map<string, {
    turnId: string;
    requestId: number | string | undefined;
    isCompact: boolean;
  }>();

  constructor(options: ServiceOptions) {
    this.runtime = options.runtime;
    this.emitEvent = options.emitEvent ?? (() => undefined);
  }

  async initialize() {
    // Wire up runtime events. The proxy is fully stateless across restarts —
    // sessions live in-memory only; the host re-creates them on reconnect.
    this.runtime.on('channelReply', (sessionId, text) => {
      this.handleChannelReply(sessionId, text);
    });

    this.runtime.on('assistantText', (sessionId, text, itemId) => {
      this.handleAssistantText(sessionId, text, itemId);
    });

    this.runtime.on('permissionRequest', (sessionId, requestId, toolName, description, inputPreview) => {
      this.handlePermissionRequest(sessionId, requestId, toolName, description, inputPreview);
    });

    this.runtime.on('toolUse', (sessionId, toolName, input, callId) => {
      this.handleToolUse(sessionId, toolName, input, callId);
    });

    this.runtime.on('agentTask', (sessionId, update) => {
      this.handleAgentTask(sessionId, update);
    });

    this.runtime.on('autoClassifierDenied', (sessionId, action, reason, consecutive, total) => {
      this.handleAutoClassifierDenied(sessionId, action, reason, consecutive, total);
    });

    this.runtime.on('autoCircuitBreaker', (sessionId, trigger, consecutive, total) => {
      this.handleAutoCircuitBreaker(sessionId, trigger, consecutive, total);
    });

    this.runtime.on('tokenUsage', (sessionId, usage) => {
      this.handleTokenUsage(sessionId, usage);
    });

    this.runtime.on('processExited', (sessionId, code, signal) => {
      this.handleProcessExited(sessionId, code, signal);
    });

    // Fork adoption (Gian sidechat): the first turn of a fork session spawns
    // `--resume <parent> --fork-session`; Claude mints the fork's native id
    // and the runtime reports it here. Swap the placeholder id for the real
    // one and tell the host (same `session.rotated` channel /clear uses).
    this.runtime.on('nativeSessionIdAdopted', (sessionId, newClaudeSessionId) => {
      const session = this.sessionsById.get(sessionId);
      if (!session) return;
      const oldClaudeSessionId = session.claudeSessionId;
      const updated = this.updateSession(session, {
        claudeSessionId: newClaudeSessionId,
        forkFromClaudeSessionId: null,
        lastError: null,
      });
      this.emitEvent('session.rotated', {
        sessionId: updated.id,
        data: {
          oldNativeSessionId: oldClaudeSessionId,
          newNativeSessionId: newClaudeSessionId,
        },
      });
    });

    this.runtime.on('debug', (message) => {
      this.emitEvent('debug', { message });
    });

    // Start the MCP channel server.
    await this.runtime.start();
  }

  setEventSink(handler: ProxyEventSink) {
    this.emitEvent = handler;
  }

  async close() {
    await this.runtime.stop();
  }

  initializePayload(): InitializePayload {
    return {
      mode: 'spawn',
      protocolVersion: '0.1.0',
      methods: [
        'initialize',
        'capabilities.list',
        'slash.list',
        'session.create',
        'session.get',
        'turn.start',
        'turn.interrupt',
        'approval.respond',
        'session.snapshot',
        'session.close',
        'shutdown',
      ],
    };
  }

  async listCapabilities(): Promise<CapabilitiesPayload> {
    // start() kicks off billing-safe capability discovery in the background
    // (Claude help + local command files only). Do not run `claude -p` from
    // capabilities: a stray probe turn would count against Agent SDK credit.
    await this.runtime.awaitModelDiscovery();
    return {
      protocolVersion: '0.1.0',
      models: this.runtime.getModels(),
      slashCommands: await listAllSlashCommands(),
    };
  }

  async listSlashCommands(cwd?: string): Promise<{ commands: import('@gian/shared').SlashCommand[] }> {
    return { commands: await listAllSlashCommands(cwd) };
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  async createSession(input: CreateSessionParams) {
    const cwd = resolve(normalizeNonEmptyString(input.cwd, 'cwd'));
    // If host passed a pre-existing claudeSessionId (adoption / reconnect),
    // use it so the next `claude -p --resume <id>` finds the existing on-disk
    // session. Otherwise generate fresh and the next spawn uses --session-id.
    const wasResumed = typeof input.claudeSessionId === 'string' && input.claudeSessionId.trim().length > 0;
    const forkFrom = typeof input.forkFromClaudeSessionId === 'string' && input.forkFromClaudeSessionId.trim().length > 0
      ? input.forkFromClaudeSessionId.trim()
      : null;
    // A fork's claudeSessionId is a placeholder until the first turn's init
    // event reports the real fork id (see nativeSessionIdAdopted above).
    const claudeSessionId = wasResumed ? input.claudeSessionId!.trim() : randomUUID();
    const createdAt = nowIso();

    const session: SessionRecord = {
      id: randomId('sess'),
      cwd,
      claudeSessionId,
      wasResumed,
      forkFromClaudeSessionId: forkFrom,
      model: typeof input.model === 'string' && input.model.trim() ? input.model.trim() : null,
      status: 'idle',
      activeTurnId: null,
      lastError: null,
      processAlive: false,
      createdAt,
      updatedAt: createdAt,
    };

    this.addSession(session);
    return { session: this.serializeSession(session) };
  }

  getSession(params: GetSessionParams) {
    const session = this.requireSessionById(normalizeNonEmptyString(params.sessionId, 'sessionId'));
    return { session: this.serializeSession(session) };
  }

  async startTurn(params: StartTurnParams, requestId?: number | string) {
    const session = this.requireSessionById(params.sessionId);
    if (session.status === 'closed') {
      throw createAppError(409, 'SESSION_CLOSED', 'This session is closed.');
    }
    if (session.activeTurnId) {
      throw createAppError(409, 'SESSION_BUSY', 'This session already has an active turn.');
    }

    const input = normalizeInputItems(params.input, session.cwd);
    const prompt = buildPrompt(input);

    // Gian-level `/clear` intercept. Claude CLI's native `/clear` is a no-op
    // in `-p` mode (each turn spawns its own process). Instead we rotate the
    // underlying claudeSessionId so the next turn uses `--session-id <new>`
    // (fresh history) instead of `--resume <old>`. The Gian session id is
    // unchanged — only the Claude-side persistence rotates.
    if (prompt.trim() === '/clear') {
      return this.handleClearIntercept(session, requestId);
    }

    const requestedModel = typeof params.model === 'string' && params.model.trim() ? params.model.trim() : session.model;

    // Ensure Claude Code process is running for this session.
    await this.ensureProcess(session, requestedModel);

    const turnId = randomId('turn');
    const isCompact = prompt.trim().split(/\s+/, 1)[0]?.toLowerCase() === '/compact';
    this.activeTurns.set(session.id, { turnId, requestId, isCompact });

    if (isCompact) {
      // The pre-compact numerator is now invalid. Clear it before Claude can
      // stream a post-compact assistant usage sample; never wait for a
      // transcript heuristic or reuse the stale value.
      this.emitEvent('token_usage.updated', {
        requestId,
        sessionId: session.id,
        turnId,
        data: { context: null, reason: 'compact_started' },
      });
    }

    // Send the user message. `thinking` is the host-side abstraction; Claude
    // CLI calls it `--effort`. Validate against the levels discovered from
    // Claude Code itself instead of carrying a Gian-side enum.
    let effort: import('./types.js').EffortLevel | null = null;
    if (typeof params.thinking === 'string' && params.thinking.trim()) {
      await this.runtime.awaitModelDiscovery();
      const requestedEffort = params.thinking.trim();
      const discoveredModels = this.runtime.getModels();
      const modelForEffort = requestedModel ?? session.model;
      const modelCapabilities = discoveredModels.find(model => model.model === modelForEffort)
        ?? (discoveredModels.length === 1 ? discoveredModels[0] : null);
      const supportedEfforts = new Set(modelCapabilities?.supportedEfforts ?? []);
      effort = supportedEfforts.has(requestedEffort) ? requestedEffort : null;
    }
    const additionalDirectories = [...new Set(
      input
        .filter((item): item is Extract<InputItem, { type: 'localFile' }> =>
          item.type === 'localFile')
        .map(item => dirname(item.path)),
    )];
    await this.runtime.sendMessage(session.id, prompt, {
      permissionMode: params.permissionMode ?? null,
      effort,
      displayName: params.displayName ?? null,
      additionalDirectories,
    });

    const updatedSession = this.updateSession(session, {
      activeTurnId: turnId,
      status: 'running',
      model: requestedModel,
      lastError: null,
    });

    this.emitEvent('turn.started', {
      requestId,
      sessionId: updatedSession.id,
      turnId,
      data: { turnId, status: 'running' },
    });

    return {
      session: this.serializeSession(updatedSession),
      turn: { id: turnId, status: 'running' },
    };
  }

  async interruptTurn(params: InterruptTurnParams) {
    const session = this.requireSessionById(params.sessionId);
    if (!session.activeTurnId) {
      throw createAppError(409, 'INVALID_REQUEST', 'This session does not have an active turn.');
    }

    // Killing the process is the most reliable way to interrupt.
    this.runtime.killSession(session.id);
    this.activeTurns.delete(session.id);

    const updated = this.updateSession(session, {
      activeTurnId: null,
      status: 'idle',
      processAlive: false,
      lastError: null,
    });
    return { ok: true, session: this.serializeSession(updated) };
  }

  async respondApproval(params: ApprovalResponseParams) {
    const session = this.requireSessionById(params.sessionId);
    const approval = this.approvalsById.get(params.approvalId);
    if (!approval || approval.sessionId !== session.id) {
      throw createAppError(404, 'APPROVAL_NOT_FOUND', 'Approval not found.');
    }

    // Every approval — including ExitPlanMode — routes through the approval
    // MCP bridge. The Claude SDK has a live canUseTool callId waiting for a
    // response; without it the process would hang forever.
    //
    // AskUserQuestion bridge: the previous implementation returned `allow`
    // with `updatedInput: { answers }` and hoped claude CLI would short-
    // circuit AskUserQuestion using the supplied answers. claude CLI 1.0.90
    // no longer honors that — it executes the real tool, which has no UI in
    // `-p` mode and errors out. We now force a `deny` and tunnel the answers
    // through the deny `message`. The model reads "tool denied: <message>"
    // and treats the embedded Q/A pairs as the user's response.
    let effectiveBehavior: 'allow' | 'deny' = params.behavior;
    let extra: { updatedInput?: Record<string, unknown>; message?: string } | undefined;
    if (params.answers) {
      effectiveBehavior = 'deny';
      extra = { message: formatQuestionAnswers(params.answers) };
    }
    await this.runtime.respondPermission(session.id, approval.requestId, effectiveBehavior, extra);

    this.removeApproval(approval);
    const updatedSession = this.updateSession(session, {
      status: session.activeTurnId ? 'running' : 'idle',
      lastError: null,
    });

    this.emitEvent('approval.resolved', {
      sessionId: updatedSession.id,
      turnId: updatedSession.activeTurnId ?? undefined,
      data: {
        approvalId: approval.approvalId,
        behavior: params.behavior,
      },
    });

    return { ok: true, session: this.serializeSession(updatedSession) };
  }

  sessionSnapshot(params: SessionSnapshotParams) {
    const session = this.requireSessionById(params.sessionId);
    return { session: this.serializeSession(session) };
  }

  async closeSession(params: CloseSessionParams) {
    const session = this.requireSessionById(params.sessionId);
    if (session.activeTurnId) {
      throw createAppError(409, 'SESSION_BUSY', 'Stop the active turn before closing the session.');
    }

    // Kill the Claude Code process if alive.
    this.runtime.killSession(session.id);
    this.removeSession(session);
    return { ok: true };
  }

  /**
   * Handle Gian's `/clear` command without invoking Claude. Rotate the
   * claudeSessionId, emit synthetic turn events plus a `session.rotated`
   * notification so the host can swap its nativeSessionId reference.
   * The internal session.id stays stable across rotations; only the
   * Claude-side persistence ID changes.
   */
  private async handleClearIntercept(
    session: SessionRecord,
    requestId?: number | string,
  ) {
    const turnId = randomId('turn');
    const oldClaudeSessionId = session.claudeSessionId;
    const newClaudeSessionId = randomUUID();
    const ackText = 'Conversation cleared. Next message starts a fresh context.';

    // Rotate the underlying Claude session id and reset runtime state so
    // `sendMessage` will use `--session-id` (fresh) instead of `--resume`.
    this.runtime.resetClaudeSessionId(session.id, newClaudeSessionId);
    const updated = this.updateSession(session, {
      claudeSessionId: newClaudeSessionId,
      // Fresh native session — first spawn will use --session-id, not --resume.
      wasResumed: false,
      lastError: null,
    });

    // Notify host of the native-session-id swap so it can update its own
    // bookkeeping. Internal session.id is unchanged so existing references
    // to it (e.g. WebSocket subscriptions) remain valid.
    this.emitEvent('session.rotated', {
      sessionId: updated.id,
      data: {
        oldNativeSessionId: oldClaudeSessionId,
        newNativeSessionId: newClaudeSessionId,
      },
    });

    // Emit the same trio of events a real turn produces, so transcript
    // rendering / token tracking treat this like a normal exchange.
    this.emitEvent('turn.started', {
      requestId,
      sessionId: updated.id,
      turnId,
      data: { turnId, status: 'running' },
    });
    this.emitEvent('output.text', {
      requestId,
      sessionId: updated.id,
      turnId,
      data: { text: ackText, itemId: turnId },
    });
    this.emitEvent('turn.completed', {
      requestId,
      sessionId: updated.id,
      turnId,
      data: { result: ackText },
    });

    return {
      session: this.serializeSession(updated),
      turn: { id: turnId, status: 'completed' },
    };
  }

  // ---------------------------------------------------------------------------
  // Runtime event handlers
  // ---------------------------------------------------------------------------

  /**
   * Intermediate assistant text block streamed from Claude. Emit as a
   * regular `output.text` notification carrying `itemId` so the web side can
   * render multiple distinct messages (one per block) interleaved with tool
   * calls. Crucially, this does NOT touch active-turn state — the turn
   * stays running until `channelReply` (turn end) or `processExited`.
   */
  private handleAssistantText(sessionId: string, text: string, itemId: string) {
    const session = this.sessionsById.get(sessionId);
    if (!session) return;
    const context = this.activeTurns.get(sessionId);
    const turnId = context?.turnId ?? session.activeTurnId;

    this.emitEvent('output.text', {
      requestId: context?.requestId,
      sessionId: session.id,
      turnId,
      data: { text, itemId },
    });
  }

  private handleChannelReply(sessionId: string, text: string) {
    const session = this.sessionsById.get(sessionId);
    if (!session) return;

    const context = this.activeTurns.get(sessionId);
    const turnId = context?.turnId ?? session.activeTurnId;

    // Empty text means the runtime already streamed each block via
    // `assistantText`; re-emitting `result` would duplicate the last block.
    // Only fire output.text when there's actually new text to surface.
    if (text.length > 0) {
      this.emitEvent('output.text', {
        requestId: context?.requestId,
        sessionId: session.id,
        turnId,
        data: { text },
      });
    }

    // Each reply call from Claude Code represents a complete response.
    // Mark the turn as completed.
    this.activeTurns.delete(sessionId);
    const updated = this.updateSession(session, {
      activeTurnId: null,
      status: 'idle',
      lastError: null,
    });

    this.emitEvent('turn.completed', {
      requestId: context?.requestId,
      sessionId: updated.id,
      turnId,
      data: { status: 'completed', result: text },
    });
  }

  private handleToolUse(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    callId: string,
  ) {
    const session = this.sessionsById.get(sessionId);
    if (!session) return;

    const context = this.activeTurns.get(sessionId);
    const turnId = context?.turnId ?? session.activeTurnId;

    this.emitEvent('tool.use', {
      requestId: context?.requestId,
      sessionId: session.id,
      turnId,
      data: { callId, toolName, input },
    });
  }

  private handleAgentTask(sessionId: string, update: ClaudeAgentTaskUpdate) {
    const session = this.sessionsById.get(sessionId);
    if (!session) return;

    const context = this.activeTurns.get(sessionId);
    this.emitEvent('claude.task', {
      requestId: context?.requestId,
      sessionId: session.id,
      turnId: context?.turnId ?? session.activeTurnId,
      data: update,
    });
  }

  /**
   * Auto-mode classifier blocked an action. Forward to host as a non-blocking
   * notification so the UI can show the user what was blocked. Per Anthropic
   * docs, the agent receives the deny reason and tries an alternative — this
   * event is informational only.
   */
  private handleAutoClassifierDenied(
    sessionId: string,
    action: string,
    reason: string,
    consecutive: number,
    total: number,
  ) {
    const session = this.sessionsById.get(sessionId);
    if (!session) return;

    const context = this.activeTurns.get(sessionId);
    this.emitEvent('auto.classifier_denied', {
      requestId: context?.requestId,
      sessionId: session.id,
      turnId: context?.turnId ?? session.activeTurnId,
      data: { action, reason, consecutive, total },
    });
  }

  private handleTokenUsage(sessionId: string, usage: TokenUsageUpdate) {
    const session = this.sessionsById.get(sessionId);
    if (!session) return;

    const context = this.activeTurns.get(sessionId);
    const effectiveModelId = this.runtime.getDetectedModelId(sessionId) ?? session.model;
    // Claude may report the summarization request's large, pre-compact input
    // as an assistant usage sample. Keep its conversation delta, but never
    // let that sample refill the context numerator we just invalidated.
    const { context: reportedContext, ...usageWithoutContext } = usage;
    const contextSafeUsage: TokenUsageUpdate = context?.isCompact
      ? usageWithoutContext
      : {
          ...usageWithoutContext,
          ...(reportedContext === undefined ? {} : { context: reportedContext }),
        };
    const inferredContextWindow = contextSafeUsage.context?.window === undefined
      ? inferContextWindow(effectiveModelId)
      : undefined;
    const normalized: TokenUsageUpdate = {
      ...contextSafeUsage,
      ...(contextSafeUsage.context && inferredContextWindow !== undefined
        ? {
            context: {
              ...contextSafeUsage.context,
              window: inferredContextWindow,
            },
          }
        : {}),
    };
    if (normalized.context === undefined && normalized.conversation === undefined && normalized.reason === undefined) {
      return;
    }

    this.emitEvent('token_usage.updated', {
      requestId: context?.requestId,
      sessionId: session.id,
      turnId: context?.turnId ?? session.activeTurnId,
      data: normalized,
    });
  }

  /**
   * Auto-mode circuit breaker tripped (3 consecutive / 20 total). In `claude
   * -p` mode the session aborts; this event lets host show a recovery card.
   */
  private handleAutoCircuitBreaker(
    sessionId: string,
    trigger: 'consecutive' | 'total',
    consecutive: number,
    total: number,
  ) {
    const session = this.sessionsById.get(sessionId);
    if (!session) return;

    const context = this.activeTurns.get(sessionId);
    this.emitEvent('auto.circuit_breaker', {
      requestId: context?.requestId,
      sessionId: session.id,
      turnId: context?.turnId ?? session.activeTurnId,
      data: { trigger, consecutive, total },
    });
  }

  private handlePermissionRequest(sessionId: string, requestId: string, toolName: string, description: string, inputPreview: string) {
    const session = this.sessionsById.get(sessionId);
    if (!session) return;

    // ExitPlanMode gets a category tag so the host can pick a specialized UI
    // (plan card + 3-way decision) without re-deriving from toolName. Plain
    // permission requests carry no category.
    const isExitPlanMode = toolName === 'ExitPlanMode';
    const finalDescription = isExitPlanMode
      ? 'Claude has finished planning. Choose how to proceed.'
      : description;

    const context = this.activeTurns.get(sessionId);
    const approval: PendingApproval = {
      approvalId: randomId('appr'),
      sessionId: session.id,
      requestId,
      toolName,
      description: finalDescription,
      inputPreview,
      createdAt: nowIso(),
      ...(isExitPlanMode ? { category: 'exit_plan_mode' } : {}),
    };

    this.addApproval(approval);
    this.updateSession(session, { status: 'needs-approval' });

    this.emitEvent('approval.requested', {
      requestId: context?.requestId,
      sessionId: session.id,
      turnId: context?.turnId ?? session.activeTurnId,
      data: approval,
    });
  }

  private handleProcessExited(sessionId: string, code: number | null, signal: string | null) {
    const session = this.sessionsById.get(sessionId);
    if (!session) return;

    const context = this.activeTurns.get(sessionId);
    this.activeTurns.delete(sessionId);

    // Clear all pending approvals (an MCP CallTool waiting on the dead
    // process can never be answered). ExitPlanMode also routes through the
    // MCP bridge now, so it's no exception.
    const approvals = this.approvalsBySessionId.get(sessionId);
    if (approvals) {
      for (const id of approvals.keys()) {
        this.approvalsById.delete(id);
      }
      this.approvalsBySessionId.delete(sessionId);
    }

    const hadActiveTurn = session.activeTurnId !== null;
    const errorMessage = hadActiveTurn ? `Claude Code process exited (code=${code}, signal=${signal})` : null;

    const updated = this.updateSession(session, {
      activeTurnId: null,
      processAlive: false,
      status: hadActiveTurn ? 'error' : 'idle',
      lastError: errorMessage,
    });

    if (hadActiveTurn) {
      this.emitEvent('turn.failed', {
        requestId: context?.requestId,
        sessionId: updated.id,
        turnId: context?.turnId,
        data: { status: 'failed', error: updated.lastError },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Process management
  // ---------------------------------------------------------------------------

  private async ensureProcess(session: SessionRecord, modelOverride?: string | null): Promise<void> {
    if (this.runtime.isSessionAlive(session.id)) {
      return;
    }

    // First spawn for this session in this proxy process. Use --resume only
    // if the host explicitly supplied a claudeSessionId at creation time
    // (adoption / reconnect — the JSONL exists on disk). Otherwise the
    // session was minted here so we use --session-id for a fresh start.
    // After the first spawn the runtime flips its internal hasHadFirstTurn,
    // so all subsequent spawns use --resume regardless of this flag.
    const isResume = session.wasResumed;
    const model = modelOverride === undefined ? session.model : modelOverride;

    try {
      await this.runtime.spawnSession({
        sessionId: session.id,
        claudeSessionId: session.claudeSessionId,
        cwd: session.cwd,
        model,
        isResume,
        ...(session.forkFromClaudeSessionId
          ? { forkFromClaudeSessionId: session.forkFromClaudeSessionId }
          : {}),
      });
      this.updateSession(session, { processAlive: true, lastError: null });
    } catch (error) {
      // If resume failed, try creating a new Claude session.
      if (isResume || session.forkFromClaudeSessionId) {
        const oldClaudeSessionId = session.claudeSessionId;
        const newClaudeSessionId = randomUUID();
        try {
          await this.runtime.spawnSession({
            sessionId: session.id,
            claudeSessionId: newClaudeSessionId,
            cwd: session.cwd,
            model,
            isResume: false,
          });
          const updated = this.updateSession(session, {
            claudeSessionId: newClaudeSessionId,
            wasResumed: false,
            // Fork fallback: the parent's JSONL was missing (e.g. it never ran
            // a turn), so there was nothing to carry — start fresh.
            forkFromClaudeSessionId: null,
            processAlive: true,
            lastError: null,
          });
          this.emitEvent('session.rotated', {
            sessionId: updated.id,
            data: {
              oldNativeSessionId: oldClaudeSessionId,
              newNativeSessionId: newClaudeSessionId,
            },
          });
        } catch (retryError) {
          throw createAppError(500, 'PROCESS_SPAWN_FAILED', retryError instanceof Error ? retryError.message : String(retryError));
        }
      } else {
        throw createAppError(500, 'PROCESS_SPAWN_FAILED', error instanceof Error ? error.message : String(error));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Session bookkeeping
  // ---------------------------------------------------------------------------

  private addSession(session: SessionRecord) {
    this.sessionsById.set(session.id, session);
  }

  private removeSession(session: SessionRecord) {
    this.sessionsById.delete(session.id);
    const approvals = this.approvalsBySessionId.get(session.id);
    if (approvals) {
      for (const id of approvals.keys()) {
        this.approvalsById.delete(id);
      }
      this.approvalsBySessionId.delete(session.id);
    }
  }

  private updateSession(session: SessionRecord, patch: Partial<SessionRecord>) {
    const next: SessionRecord = { ...session, ...patch, updatedAt: nowIso() };
    this.sessionsById.set(next.id, next);
    return next;
  }

  private serializeSession(session: SessionRecord) {
    return {
      id: session.id,
      cwd: session.cwd,
      claudeSessionId: session.claudeSessionId,
      model: session.model,
      status: session.status,
      processAlive: session.processAlive,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      lastError: session.lastError,
    };
  }

  private requireSessionById(sessionId: string) {
    const session = this.sessionsById.get(sessionId);
    if (!session) {
      throw createAppError(404, 'SESSION_NOT_FOUND', 'Session not found.');
    }
    return session;
  }

  private addApproval(approval: PendingApproval) {
    this.approvalsById.set(approval.approvalId, approval);
    let map = this.approvalsBySessionId.get(approval.sessionId);
    if (!map) {
      map = new Map();
      this.approvalsBySessionId.set(approval.sessionId, map);
    }
    map.set(approval.approvalId, approval);
  }

  private removeApproval(approval: PendingApproval) {
    this.approvalsById.delete(approval.approvalId);
    const map = this.approvalsBySessionId.get(approval.sessionId);
    map?.delete(approval.approvalId);
    if (map && map.size === 0) {
      this.approvalsBySessionId.delete(approval.sessionId);
    }
  }
}
