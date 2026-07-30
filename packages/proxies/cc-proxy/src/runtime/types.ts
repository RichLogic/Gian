import { EventEmitter } from 'node:events';

import type { TokenUsageUpdate } from '@gian/shared';
import type { EffortLevel, ModelCapabilities, PermissionMode } from '../core/types.js';

export interface ClaudeAgentTaskUpdate {
  taskId: string;
  toolUseId: string;
  description?: string;
  agentType?: string;
  status: 'running' | 'done' | 'error';
  summary?: string;
  outputFile?: string;
  startedAt?: number;
  completedAt?: number;
}

/**
 * Events emitted by the runtime:
 *
 *   'channelReply'         – Claude Code called the reply tool
 *   'permissionRequest'    – Claude Code needs user approval for a tool
 *                            (ExitPlanMode routes here too — host detects via toolName)
 *   'autoClassifierDenied' – auto-mode classifier blocked an action
 *   'autoCircuitBreaker'   – process aborted by auto-mode circuit breaker
 *   'processExited'        – A Claude Code process exited
 *   'debug'                – Debug / log message
 */
export interface ClaudeRuntimeEvents {
  channelReply: [sessionId: string, text: string];
  /** Intermediate assistant text block from a stream-json `assistant` event.
   *  Emitted for each `text` block as it arrives so the UI can render the
   *  agent's commentary interleaved with tool calls — without this, only the
   *  final `result` text would surface and you'd see "wall of actions then
   *  one summary" UX.  `itemId` is stable across deltas of the same logical
   *  block so the renderer can update in place. */
  assistantText: [sessionId: string, text: string, itemId: string];
  permissionRequest: [sessionId: string, requestId: string, toolName: string, description: string, inputPreview: string];
  autoClassifierDenied: [sessionId: string, action: string, reason: string, consecutive: number, total: number];
  autoCircuitBreaker: [sessionId: string, trigger: 'consecutive' | 'total', consecutive: number, total: number];
  toolUse: [
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    callId: string,
  ];
  /** Claude -p's native task_started / task_notification lifecycle. */
  agentTask: [sessionId: string, update: ClaudeAgentTaskUpdate];
  /** Current context samples from assistant events plus the result event's
   *  per-invocation conversation delta and authoritative context-window size. */
  tokenUsage: [sessionId: string, usage: TokenUsageUpdate];
  processExited: [sessionId: string, code: number | null, signal: string | null];
  /** Fork adoption (Gian sidechat): after a `--fork-session` spawn, Claude
   *  mints the fork's native id; the runtime learns it from the stream-json
   *  init event and reports it here so the service can swap its placeholder. */
  nativeSessionIdAdopted: [sessionId: string, newClaudeSessionId: string];
  debug: [message: string];
}

export interface ClaudeRuntime extends EventEmitter<ClaudeRuntimeEvents> {
  /** Initialize the runtime. Returns 0 (no server port). */
  start(): Promise<number>;

  /** Spawn a Claude Code process for a new session. */
  spawnSession(options: {
    sessionId: string;
    claudeSessionId: string;
    cwd: string;
    model?: string | null;
    isResume: boolean;
    /** Gian sidechat: fork this parent Claude session on the first turn
     *  (`claude -p --resume <parent> --fork-session`). The fork's real native
     *  id is adopted from the init event — see nativeSessionIdAdopted. */
    forkFromClaudeSessionId?: string;
  }): Promise<void>;

  /** Send a user message to Claude Code. */
  sendMessage(sessionId: string, content: string, options?: {
    /** Per-turn `--permission-mode` value. Pass-through to the spawned
     *  `claude -p` subprocess; null/undefined keeps Claude's default. */
    permissionMode?: PermissionMode | null;
    /** Per-turn `--effort` value, validated against Claude CLI discovery. */
    effort?: EffortLevel | null;
    /** Session display name (SESSION-NAME-001). Applied as `--name` only on
     *  the first (`--session-id`) spawn. */
    displayName?: string | null;
  }): Promise<void>;

  /** Rotate the underlying Claude session id (used by Gian's `/clear`
   *  intercept to start a fresh conversation without losing the Gian
   *  session). */
  resetClaudeSessionId(sessionId: string, newClaudeSessionId: string): void;

  /** Respond to a permission request (allow / deny).
   *
   *  `extra.updatedInput` is forwarded into the Claude Code SDK
   *  approval_prompt response so the agent re-invokes the tool with the
   *  modified input.
   *
   *  `extra.message` is forwarded as the SDK-shaped `message` on a deny
   *  payload. Used by the AskUserQuestion bridge: claude CLI 1.0.90 doesn't
   *  honor the `updatedInput.answers` short-circuit anymore, so the bridge
   *  routes structured answers through deny+message instead. The model
   *  reads the message as the tool's denial reason and treats the embedded
   *  answers as the user's response. */
  respondPermission(
    sessionId: string,
    requestId: string,
    behavior: 'allow' | 'deny',
    extra?: { updatedInput?: Record<string, unknown>; message?: string },
  ): Promise<void>;

  /** Kill the Claude Code process for a session. */
  killSession(sessionId: string): void;

  /** Check whether a session's Claude Code process is alive. */
  isSessionAlive(sessionId: string): boolean;

  /** Actual model id last reported by claude CLI's `system init` event for
   *  this session — may differ from the stored alias (e.g. `claude-opus-4-7`
   *  vs `claude-opus-4-7[1m]` when CLI auto-promotes). Returns null if no
   *  turn has run yet. */
  getDetectedModelId(sessionId: string): string | null;

  /** Shut down everything – kill all processes. */
  stop(): Promise<void>;

  /** Return discovered model choices (populated after start). For Claude this
   *  may be a billing-safe "default/no --model override" option rather than
   *  a concrete resolved model id. */
  getModels(): ModelCapabilities[];

  /** Resolve once the initial capability discovery finishes. Lets callers (like
   *  capabilities.list) avoid returning an empty models array when the
   *  proxy was just spawned. */
  awaitModelDiscovery(): Promise<void>;
}
