import { EventEmitter } from 'node:events';

import type { EffortLevel, ModelCapabilities, PermissionMode } from '../core/types.js';

/**
 * Events emitted by the runtime:
 *
 *   'channelReply'         – Claude Code called the reply tool
 *   'permissionRequest'    – Claude Code needs user approval for a tool
 *   'exitPlanMode'         – Claude Code called the ExitPlanMode tool (plan ready)
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
  exitPlanMode: [sessionId: string, plan: string];
  autoClassifierDenied: [sessionId: string, action: string, reason: string, consecutive: number, total: number];
  autoCircuitBreaker: [sessionId: string, trigger: 'consecutive' | 'total', consecutive: number, total: number];
  toolUse: [sessionId: string, toolName: string, input: Record<string, unknown>];
  /** Cumulative token usage for the current turn. Claude CLI reports this on
   *  the `result` event. Numbers are per-turn (input includes resumed history
   *  context, output is the new reply). */
  tokenUsage: [sessionId: string, usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  }];
  processExited: [sessionId: string, code: number | null, signal: string | null];
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
  }): Promise<void>;

  /** Send a user message to Claude Code. */
  sendMessage(sessionId: string, content: string, options?: {
    /** Per-turn `--permission-mode` value. Pass-through to the spawned
     *  `claude -p` subprocess; null/undefined keeps Claude's default. */
    permissionMode?: PermissionMode | null;
    /** Per-turn `--effort` value (low/medium/high/xhigh/max). */
    effort?: EffortLevel | null;
  }): Promise<void>;

  /** Rotate the underlying Claude session id (used by Gian's `/clear`
   *  intercept to start a fresh conversation without losing the Gian
   *  session). */
  resetClaudeSessionId(sessionId: string, newClaudeSessionId: string): void;

  /** Respond to a permission request (allow / deny). */
  /** `extra.updatedInput` is forwarded into the Claude Code SDK
   *  approval_prompt response so the agent re-invokes the tool with the
   *  modified input. Used by the AskUserQuestion bridge to pre-supply
   *  `answers`. */
  respondPermission(
    sessionId: string,
    requestId: string,
    behavior: 'allow' | 'deny',
    extra?: { updatedInput?: Record<string, unknown> },
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

  /** Return discovered models (populated after start). */
  getModels(): ModelCapabilities[];

  /** Resolve once the initial discovery probe finishes. Lets callers (like
   *  capabilities.list) avoid returning an empty models array when the
   *  proxy was just spawned. */
  awaitModelDiscovery(): Promise<void>;
}
