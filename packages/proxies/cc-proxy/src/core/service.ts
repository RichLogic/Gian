import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

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
import type { ClaudeRuntime } from '../runtime/types.js';

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

function buildPrompt(input: InputItem[]): string {
  return input
    .filter((item): item is { type: 'text'; text: string } => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n\n');
}

/** Best-guess context window for a Claude model ID. Claude CLI doesn't
 *  expose this via stream-json, so we go off the model name. `[1m]` suffix =
 *  1M token variant; everything else falls back to 200k (the standard ceiling
 *  for Sonnet/Opus/Haiku 4.x). */
function inferContextWindow(modelId: string | null): number {
  if (!modelId) return 200_000;
  if (modelId.includes('[1m]')) return 1_000_000;
  return 200_000;
}

export class CcProxyService {
  private readonly runtime: ClaudeRuntime;
  private emitEvent: ProxyEventSink;
  private readonly sessionsById = new Map<string, SessionRecord>();
  private readonly approvalsById = new Map<string, PendingApproval>();
  private readonly approvalsBySessionId = new Map<string, Map<string, PendingApproval>>();
  /** Tracks the current turn and upstream requestId per session. */
  private readonly activeTurns = new Map<string, { turnId: string; requestId: number | string | undefined }>();

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

    this.runtime.on('toolUse', (sessionId, toolName, input) => {
      this.handleToolUse(sessionId, toolName, input);
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
    // start() kicks off model discovery in the background so it doesn't
    // block initialize; wait for it here so the first capabilities.list
    // doesn't return an empty models list.
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
    const claudeSessionId = wasResumed ? input.claudeSessionId!.trim() : randomUUID();
    const createdAt = nowIso();

    const session: SessionRecord = {
      id: randomId('sess'),
      cwd,
      claudeSessionId,
      wasResumed,
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
    this.activeTurns.set(session.id, { turnId, requestId });

    // Send the user message. `thinking` is the host-side abstraction; Claude
    // CLI calls it `--effort` and only accepts the 5 levels — drop anything
    // else (e.g. 'off' / 'minimal' from the broader shared union).
    const validEfforts = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
    const effort = params.thinking && validEfforts.has(params.thinking)
      ? params.thinking
      : null;
    await this.runtime.sendMessage(session.id, prompt, {
      permissionMode: params.permissionMode ?? null,
      effort,
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
    // When the user answered an AskUserQuestion-flavored approval, hand the
    // structured answers back to the agent via Claude SDK's `updatedInput`
    // channel. Plain allow/deny otherwise.
    const extra = params.answers
      ? { updatedInput: { answers: params.answers } }
      : undefined;
    await this.runtime.respondPermission(session.id, approval.requestId, params.behavior, extra);

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

  private handleToolUse(sessionId: string, toolName: string, input: Record<string, unknown>) {
    const session = this.sessionsById.get(sessionId);
    if (!session) return;

    const context = this.activeTurns.get(sessionId);
    const turnId = context?.turnId ?? session.activeTurnId;

    this.emitEvent('tool.use', {
      requestId: context?.requestId,
      sessionId: session.id,
      turnId,
      data: { toolName, input },
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

  /**
   * Per-turn token usage from Claude CLI's `result.usage`. Wrapped in codex's
   * `token_usage.updated` shape so the host's existing parseTokenUsage works
   * unchanged. `total` is input + output (same convention codex uses).
   *
   * Context-window estimate: model IDs ending with `[1m]` get 1M; otherwise
   * 200k (Anthropic's standard ceiling). Better than nothing — the actual
   * runtime context isn't exposed via `claude -p` stream-json today.
   */
  private handleTokenUsage(
    sessionId: string,
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
    },
  ) {
    const session = this.sessionsById.get(sessionId);
    if (!session) return;

    const context = this.activeTurns.get(sessionId);
    const totalTokens = usage.inputTokens + usage.outputTokens;
    // Prefer the model id claude CLI reported on `system init` — when the
    // CLI auto-promoted the alias to a 1M variant (or any other suffix), the
    // probed alias id won't reflect it. Falls back to the stored session
    // model for first-turn / pre-init paths.
    const effectiveModelId = this.runtime.getDetectedModelId(sessionId) ?? session.model;
    const modelContextWindow = inferContextWindow(effectiveModelId);

    this.emitEvent('token_usage.updated', {
      requestId: context?.requestId,
      sessionId: session.id,
      turnId: context?.turnId ?? session.activeTurnId,
      data: {
        params: {
          tokenUsage: {
            total: {
              totalTokens,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cachedInputTokens: usage.cacheReadInputTokens,
            },
            modelContextWindow,
          },
        },
      },
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
      });
      this.updateSession(session, { processAlive: true, lastError: null });
    } catch (error) {
      // If resume failed, try creating a new Claude session.
      if (isResume) {
        const newClaudeSessionId = randomUUID();
        try {
          await this.runtime.spawnSession({
            sessionId: session.id,
            claudeSessionId: newClaudeSessionId,
            cwd: session.cwd,
            model,
            isResume: false,
          });
          this.updateSession(session, {
            claudeSessionId: newClaudeSessionId,
            wasResumed: false,
            processAlive: true,
            lastError: null,
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
