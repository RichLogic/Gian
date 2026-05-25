/**
 * Claude Code runtime backed by per-turn process spawning.
 *
 * Instead of maintaining long-lived processes with MCP channel communication,
 * this runtime spawns a new `claude -p` process for each turn and parses the
 * stream-json output.
 *
 * Session continuity is handled by Claude Code's built-in `--session-id` /
 * `--resume` flags, which preserve conversation history across invocations.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { ApprovalServer, APPROVAL_PROMPT_TOOL } from '../mcp/approval-server.js';
import type { EffortLevel, ModelCapabilities, PermissionMode } from '../core/types.js';
import type { ClaudeRuntime, ClaudeRuntimeEvents } from './types.js';

// Known Claude model aliases and their metadata.
const MODEL_ALIASES: Array<{
  alias: string;
  displayName: string;
  isDefault: boolean;
  defaultEffort: EffortLevel;
  supportedEfforts: EffortLevel[];
}> = [
  // Claude CLI's `--effort` flag accepts 5 levels uniformly (low/medium/high/
  // xhigh/max). Per-model differences are runtime-rejected by Claude itself,
  // so we expose all 5 to the UI and let the model pick.
  { alias: 'sonnet', displayName: 'Claude Sonnet', isDefault: true, defaultEffort: 'high', supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { alias: 'opus', displayName: 'Claude Opus', isDefault: false, defaultEffort: 'high', supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { alias: 'haiku', displayName: 'Claude Haiku', isDefault: false, defaultEffort: 'medium', supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
];

/**
 * Probe the slash commands available in this Claude environment by spawning
 * a throwaway `claude -p` and reading the `init` event's `slash_commands`
 * array — this is the authoritative list of what works in non-interactive
 * (`-p`) mode, including user-installed skills and plugins. Falls back to
 * an empty list on probe failure.
 */
export function probeSlashCommands(cwd?: string): Promise<string[]> {
  return new Promise((resolve) => {
    const args = [
      '-p', 'x',
      '--output-format', 'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--dangerously-skip-permissions',
    ];
    const proc = spawn(claudeExecutable(), args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(cwd ? { cwd } : {}),
    });
    proc.stdin.end();

    let resolved = false;
    const finish = (list: string[]) => {
      if (resolved) return;
      resolved = true;
      resolve(list);
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    };

    const lines = createInterface({ input: proc.stdout! });
    lines.on('line', (line) => {
      if (resolved) return;
      try {
        const event = JSON.parse(line.trim()) as Record<string, unknown>;
        if (event.type === 'system' && event.subtype === 'init' && Array.isArray(event.slash_commands)) {
          finish((event.slash_commands as unknown[]).filter((s): s is string => typeof s === 'string'));
        }
      } catch { /* ignore */ }
    });
    // Without an 'error' handler an ENOENT (claude binary missing) raises
    // an unhandled exception and crashes the proxy process. Treat it as a
    // probe failure → empty list, same as the timeout path.
    proc.on('error', () => finish([]));
    proc.on('exit', () => finish([]));
    setTimeout(() => finish([]), 15_000);
  });
}

/**
 * Resolve a model alias (e.g. "sonnet") to its full model ID by spawning
 * a throwaway Claude process and reading the init event.
 */
function resolveModelAlias(alias: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn(claudeExecutable(), [
      '-p', 'x',
      '--model', alias,
      '--output-format', 'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--dangerously-skip-permissions',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    proc.stdin.end();

    let resolved = false;
    // Capture stderr so a spawn-time CLI rejection (unknown flag, wrong
    // binary version) surfaces in cc-proxy stderr instead of looking like
    // a silent null — discovery used to swallow this and the UI just sat
    // on an empty model list forever.
    let stderrBuf = '';
    proc.stderr!.on('data', d => { stderrBuf += d.toString(); });
    const lines = createInterface({ input: proc.stdout! });
    lines.on('line', (line) => {
      if (resolved) return;
      try {
        const event = JSON.parse(line.trim()) as Record<string, unknown>;
        if (event.type === 'system' && event.subtype === 'init' && typeof event.model === 'string') {
          resolved = true;
          resolve(event.model);
          proc.kill('SIGTERM');
        }
      } catch { /* ignore */ }
    });

    proc.on('exit', (code) => {
      if (!resolved) {
        if (code !== 0 && stderrBuf.trim()) {
          console.error(`[cc-proxy:probe ${alias}] claude exited ${code}: ${stderrBuf.trim().split('\n')[0]}`);
        }
        resolve(null);
      }
    });

    // Same reason as probeSlashCommands — survive a missing `claude` binary.
    proc.on('error', (err) => {
      if (!resolved) {
        console.error(`[cc-proxy:probe ${alias}] spawn error: ${err.message}`);
        resolved = true;
        resolve(null);
      }
    });

    // Timeout after 30s.
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(null);
        proc.kill('SIGTERM');
      }
    }, 30_000);
  });
}

interface ManagedSession {
  sessionId: string;
  claudeSessionId: string;
  cwd: string;
  model: string | null;
  /** Last model id reported by claude CLI's `system init` event. Claude can
   *  auto-promote (e.g. opus → opus[1m]) based on user config, so the alias
   *  we asked for isn't necessarily what's running. Used for context-window
   *  inference so the bar reflects the actual variant. */
  detectedModelId: string | null;
  activeProcess: ChildProcess | null;
  hasHadFirstTurn: boolean;
  /** Absolute path to the per-session mcp-config json passed to `claude
   *  --mcp-config`. Written before each spawn that goes through the approval
   *  bridge; cleaned up on session close. */
  mcpConfigPath: string | null;
  /** Pending approval callIds → toolName, indexed by MCP CallTool id. Used so
   *  respondPermission can locate the right ApprovalServer entry. */
  pendingCallIds: Set<string>;
}

function claudeExecutable() {
  // Honor an explicit override first (escape hatch for launchd contexts where
  // PATH is sparse). Otherwise lean on the inherited PATH — Claude Code can
  // live in /opt/homebrew/bin, ~/.local/bin, /usr/local/bin, or a custom
  // location, so hardcoding any one path is strictly worse than PATH lookup.
  const configured = process.env.CLAUDE_BIN?.trim();
  if (configured) return configured;
  return 'claude';
}

export class ClaudeMcpRuntime extends EventEmitter<ClaudeRuntimeEvents> implements ClaudeRuntime {
  private readonly sessions = new Map<string, ManagedSession>();
  private discoveredModels: ModelCapabilities[] = [];
  private modelDiscoveryPromise: Promise<void> | null = null;
  private readonly approvalServer: ApprovalServer;
  private approvalPort = 0;

  constructor() {
    super();
    this.approvalServer = new ApprovalServer({
      onPermissionRequest: (sessionId, callId, toolName, input) => {
        const session = this.sessions.get(sessionId);
        if (session) session.pendingCallIds.add(callId);
        // Pass the full input through. host's normalize-cc.ts uses JSON.parse
        // to extract per-tool fields; truncating here breaks JSON syntax for
        // Edit/Write tools whose old_string / new_string easily exceed any
        // small cap, leaving the host's parser with malformed input and the
        // UI showing the raw broken JSON instead of a clean file path.
        const inputPreview = (() => {
          try { return JSON.stringify(input); }
          catch { return ''; }
        })();
        // Log toolName up front so host.out shows the canonical name the
        // CLI is using — needed for diagnosing things like AskUserQuestion
        // getting renamed/namespaced across SDK versions.
        this.emit('debug', `[runtime] permissionRequest sessionId=${sessionId} toolName=${toolName} inputKeys=${Object.keys(input ?? {}).join(',')}`);
        const description = `Tool ${toolName} requires permission.`;
        this.emit('permissionRequest', sessionId, callId, toolName, description, inputPreview);
      },
      onConnected: (sessionId) => this.emit('debug', `[runtime] approval MCP connected for ${sessionId}`),
      onDisconnected: (sessionId) => this.emit('debug', `[runtime] approval MCP disconnected for ${sessionId}`),
      onDebug: (msg) => this.emit('debug', msg),
    });
  }

  async start(): Promise<number> {
    this.approvalPort = await this.approvalServer.start();
    this.emit('debug', `[runtime] Approval MCP listening on 127.0.0.1:${this.approvalPort}`);
    // Kick off discovery in the background. discoverModels() shells out to
    // `claude --model <alias>` per alias and can take seconds when the CLI
    // is cold or unreachable. Awaiting it here used to block the spawn.ts
    // stdin loop from starting, so the host's `initialize` request would
    // time out (and the cc-proxy smoke test fails). Discovery is required
    // for capabilities.list, not initialize — listCapabilities awaits the
    // promise via `awaitModelDiscovery()` instead.
    this.modelDiscoveryPromise = this.discoverModels().catch((err) => {
      this.emit('debug', `[runtime] Model discovery failed: ${err}`);
    });
    return 0;
  }

  getModels(): ModelCapabilities[] {
    return this.discoveredModels;
  }

  /** Block until the initial model discovery probe finishes (success or
   *  failure). Used by capabilities.list so it doesn't return an empty
   *  models list on a freshly-spawned proxy. */
  async awaitModelDiscovery(): Promise<void> {
    if (this.modelDiscoveryPromise) await this.modelDiscoveryPromise;
  }

  private async discoverModels(): Promise<void> {
    this.emit('debug', '[runtime] Discovering available models...');
    const results = await Promise.all(
      MODEL_ALIASES.map(async (entry) => {
        try {
          const modelId = await resolveModelAlias(entry.alias);
          if (!modelId) return null;
          // Extract version: "claude-sonnet-4-6" → "4.6", "claude-haiku-4-5-20251001" → "4.5"
          const versionMatch = modelId.match(/(\d+-\d+)(?:-\d{8,})?$/);
          const version = versionMatch?.[1]?.replace(/-/g, '.') ?? '';
          return {
            id: modelId,
            model: modelId,
            displayName: version ? `${entry.displayName} ${version}` : entry.displayName,
            description: '',
            hidden: false as boolean,
            isDefault: entry.isDefault,
            defaultEffort: entry.defaultEffort,
            supportedEfforts: entry.supportedEfforts,
          } as ModelCapabilities;
        } catch {
          return null;
        }
      }),
    );

    const base = results.filter((m): m is NonNullable<typeof m> => m !== null);

    // Synthesize the 1M-context variants for sonnet/opus. Claude CLI accepts
    // a literal `[1m]` suffix on these model ids and routes to the 1M
    // version; without surfacing them here the user has no way to pick the
    // larger context. Haiku has no 1M variant. The probe-then-resolve cost
    // for these is high, so synthesize unconditionally — if claude rejects
    // it at turn time, the error surfaces naturally.
    const variants: ModelCapabilities[] = [];
    for (const m of base) {
      const isOpus = /opus/i.test(m.displayName);
      const isSonnet = /sonnet/i.test(m.displayName);
      if (!isOpus && !isSonnet) continue;
      const id1m = `${m.model}[1m]`;
      variants.push({
        ...m,
        id: id1m,
        model: id1m,
        displayName: `${m.displayName} (1M)`,
        isDefault: false,
      });
    }

    this.discoveredModels = [...base, ...variants];
    this.emit('debug', `[runtime] Discovered ${this.discoveredModels.length} models: ${this.discoveredModels.map((m) => m.model).join(', ')}`);
  }

  async spawnSession(options: {
    sessionId: string;
    claudeSessionId: string;
    cwd: string;
    model?: string | null;
    isResume: boolean;
  }): Promise<void> {
    // Kill any existing process for this session.
    this.killSession(options.sessionId);

    // Record session metadata — no process spawned yet.
    this.sessions.set(options.sessionId, {
      sessionId: options.sessionId,
      claudeSessionId: options.claudeSessionId,
      cwd: options.cwd,
      model: options.model ?? null,
      detectedModelId: null,
      activeProcess: null,
      hasHadFirstTurn: options.isResume,
      mcpConfigPath: null,
      pendingCallIds: new Set(),
    });

    this.emit('debug', `[runtime] Session registered: ${options.sessionId} (claude: ${options.claudeSessionId})`);
  }

  /**
   * Rotate the Claude Code session ID for an existing Gian session. Used by
   * the `/clear` intercept: cc-proxy generates a fresh UUID, the next turn
   * spawns `claude -p --session-id <new>` (not `--resume`), so Claude starts
   * with empty conversation history. The user-facing Gian session id stays
   * the same; just the Claude-side persistence ID rotates.
   */
  resetClaudeSessionId(sessionId: string, newClaudeSessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.activeProcess && !session.activeProcess.killed) {
      session.activeProcess.kill('SIGTERM');
      session.activeProcess = null;
    }
    session.claudeSessionId = newClaudeSessionId;
    session.hasHadFirstTurn = false;
    this.emit('debug', `[runtime] Session ${sessionId} reset to fresh claude session ${newClaudeSessionId}`);
  }

  async sendMessage(sessionId: string, content: string, options?: {
    permissionMode?: PermissionMode | null;
    effort?: EffortLevel | null;
  }): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`No session found for ${sessionId}`);
    }

    // Kill any still-running process for this session.
    if (session.activeProcess && !session.activeProcess.killed) {
      session.activeProcess.kill('SIGTERM');
    }

    // Permission bridge: bypassPermissions skips the MCP roundtrip entirely
    // (CLI flag handles it). All other modes route through approval-server.
    const mode = options?.permissionMode ?? 'default';
    const useApprovalBridge = mode !== 'bypassPermissions';
    if (useApprovalBridge) {
      session.mcpConfigPath = await this.writeMcpConfig(session.sessionId);
    } else {
      session.mcpConfigPath = null;
    }

    const args = this.buildClaudeArgs(session, content, options);
    this.emit('debug', `[runtime] Spawning turn: claude ${args.slice(0, 4).join(' ')}...`);

    const proc = spawn(claudeExecutable(), args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: session.cwd,
      env: { ...process.env },
    });

    // Wait until spawn either succeeds or fails so we can surface ENOENT etc.
    // back to the caller and the host-side state machine. Without this the
    // turn would be marked running indefinitely on a missing claude binary.
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => { cleanup(); resolve(); };
      const onError = (err: Error) => {
        cleanup();
        // Surface as processExited too so service.ts marks the turn failed.
        this.emit('debug', `[runtime] Failed to spawn claude: ${err.message}`);
        this.emit('processExited', sessionId, null, null);
        reject(err);
      };
      const cleanup = () => {
        proc.removeListener('spawn', onSpawn);
        proc.removeListener('error', onError);
      };
      proc.once('spawn', onSpawn);
      proc.once('error', onError);
    });

    proc.stdin.end();
    session.activeProcess = proc;

    // Parse stdout line by line for stream-json events.
    const lines = createInterface({ input: proc.stdout! });
    let resultText: string | null = null;
    let resultSubtype: string | null = null;
    // Tracks whether any text has been streamed via `assistantText` this
    // turn. The `result` event echoes the final assistant message verbatim,
    // so emitting it again as channelReply would duplicate the last text
    // block. When this is true we suppress the result-side text and only
    // signal turn completion.
    let streamedAnyText = false;

    lines.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const event = JSON.parse(trimmed) as Record<string, unknown>;
        const eventType = event.type as string | undefined;

        // The `system init` event reports the actual resolved model id
        // claude is running under (e.g. `claude-opus-4-7[1m]` when the user
        // has 1M enabled). The alias-probe done at startup only knows the
        // shorthand (`opus`) and the canonical id (`claude-opus-4-7`); CLI
        // may auto-promote to a variant we never asked for. Capture it so
        // tokenUsage downstream picks the right context window.
        if (eventType === 'system' && event.subtype === 'init') {
          if (typeof event.model === 'string') {
            session.detectedModelId = event.model;
          }
        }

        if (eventType === 'assistant') {
          // Parse all content blocks from assistant messages — both `text`
          // (intermediate commentary) and `tool_use`. Without emitting the
          // text blocks the UI only sees the final `result` summary, missing
          // every "let me check that" / "now I'll do X" the agent says
          // between tool calls.
          const message = event.message as { id?: string; content?: unknown[] } | undefined;
          const messageId = typeof message?.id === 'string' && message.id ? message.id : `msg_${Date.now()}`;
          const content = Array.isArray(message?.content) ? message!.content : [];
          let blockIdx = 0;
          for (const block of content) {
            if (typeof block !== 'object' || block === null) {
              blockIdx++;
              continue;
            }
            const b = block as Record<string, unknown>;
            const blockType = b.type;

            if (blockType === 'text' && typeof b.text === 'string' && b.text.length > 0) {
              streamedAnyText = true;
              this.emit('assistantText', sessionId, b.text, `${messageId}_${blockIdx}`);
            } else if (blockType === 'tool_use') {
              const toolName = typeof b.name === 'string' ? b.name : 'unknown';
              const toolInput = typeof b.input === 'object' && b.input !== null
                ? b.input as Record<string, unknown>
                : {};

              // ExitPlanMode permission request flows through the approval
              // MCP bridge (Claude SDK calls canUseTool before invoking the
              // tool). Host detects toolName='ExitPlanMode' on the approval
              // event and tags it as exit_plan_mode for special UI rendering.
              // No synthesized event needed here.

              this.emit('toolUse', sessionId, toolName, toolInput);
            }
            blockIdx++;
          }
        }

        if (eventType === 'result') {
          resultSubtype = (event.subtype as string) ?? null;
          resultText = typeof event.result === 'string' ? event.result : '';
          this.emit('debug', `[runtime] Turn result for ${sessionId} (${resultSubtype}): ${resultText.slice(0, 120)}...`);

          // Extract token usage from the result event. Claude CLI reports
          // input_tokens (= context size into this turn) + output_tokens
          // + cache_read_input_tokens + cache_creation_input_tokens.
          const usage = event.usage as Record<string, unknown> | undefined;
          if (usage && typeof usage === 'object') {
            this.emit('tokenUsage', sessionId, {
              inputTokens: Number(usage.input_tokens ?? 0),
              outputTokens: Number(usage.output_tokens ?? 0),
              cacheReadInputTokens: Number(usage.cache_read_input_tokens ?? 0),
              cacheCreationInputTokens: Number(usage.cache_creation_input_tokens ?? 0),
            });
          }
        }

        // Log non-system events.
        if (eventType && eventType !== 'system') {
          this.emit('debug', `[runtime:${sessionId}] ${eventType}${event.subtype ? ':' + String(event.subtype) : ''}`);
        }
      } catch {
        this.emit('debug', `[runtime:${sessionId}:stdout] ${trimmed.slice(0, 200)}`);
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) this.emit('debug', `[runtime:${sessionId}:stderr] ${text}`);
    });

    // Post-spawn errors (rare — usually pipe failures). Surface but don't
    // re-emit processExited; the 'exit' handler below covers process death.
    proc.on('error', (err) => {
      this.emit('debug', `[runtime] post-spawn error for ${sessionId}: ${err.message}`);
    });

    proc.on('exit', (code, signal) => {
      session.activeProcess = null;
      session.hasHadFirstTurn = true;

      // Drop any per-session state tied to this process. The approval bridge
      // will deny outstanding approvals so claude never gets a stale reply.
      this.cleanupAfterTurn(session);

      if (resultText !== null && resultSubtype === 'success') {
        // Turn completed successfully. If we've already streamed text via
        // assistantText events, the result text is just a duplicate of the
        // last block — pass an empty string so the service emits the
        // turn-completed signal without re-emitting text. Otherwise (rare
        // edge case where claude reports success but never streamed text)
        // pass the result text through so it isn't lost.
        const replyText = streamedAnyText ? '' : resultText;
        this.emit('channelReply', sessionId, replyText);
      }

      this.emit('processExited', sessionId, code, signal);
      this.emit('debug', `[runtime] Turn process exited for ${sessionId} (code=${code}, signal=${signal})`);
    });
  }

  async respondPermission(
    sessionId: string,
    requestId: string,
    behavior: 'allow' | 'deny',
    extra?: { updatedInput?: Record<string, unknown>; message?: string },
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.emit('debug', `[runtime] respondPermission: no session ${sessionId}`);
      return;
    }
    const ok = this.approvalServer.resolve(
      requestId,
      behavior,
      extra?.message,
      extra?.updatedInput !== undefined ? { updatedInput: extra.updatedInput } : undefined,
    );
    if (ok) {
      session.pendingCallIds.delete(requestId);
    } else {
      this.emit('debug', `[runtime] respondPermission: no pending callId ${requestId}`);
    }
  }

  isSessionAlive(sessionId: string): boolean {
    // A session is "alive" as long as it is registered.
    return this.sessions.has(sessionId);
  }

  getDetectedModelId(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.detectedModelId ?? null;
  }

  killSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.activeProcess && !session.activeProcess.killed) {
      session.activeProcess.kill('SIGTERM');
    }
    this.cleanupAfterTurn(session);
    this.approvalServer.dropConnection(sessionId);
    this.sessions.delete(sessionId);
  }

  async stop(): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.activeProcess && !session.activeProcess.killed) {
        session.activeProcess.kill('SIGTERM');
      }
      this.cleanupAfterTurn(session);
    }
    this.sessions.clear();
    await this.approvalServer.stop();
  }

  /** Drop per-turn state: deny pending approvals and unlink the temporary
   *  mcp-config file. Safe to call multiple times. */
  private cleanupAfterTurn(session: ManagedSession): void {
    for (const callId of session.pendingCallIds) {
      this.approvalServer.resolve(callId, 'deny', 'turn ended');
    }
    session.pendingCallIds.clear();

    if (session.mcpConfigPath) {
      const path = session.mcpConfigPath;
      session.mcpConfigPath = null;
      void unlink(path).catch(() => undefined);
    }
  }

  private async writeMcpConfig(sessionId: string): Promise<string> {
    const path = join(tmpdir(), `cc-proxy-mcp-${sessionId}-${process.pid}.json`);
    const config = {
      mcpServers: {
        cc_approval: {
          type: 'sse',
          url: this.approvalServer.urlForSession(sessionId),
        },
      },
    };
    await writeFile(path, JSON.stringify(config), 'utf8');
    return path;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private buildClaudeArgs(
    session: ManagedSession,
    content: string,
    options?: { permissionMode?: PermissionMode | null; effort?: EffortLevel | null },
  ): string[] {
    const args: string[] = [
      '-p', content,
      '--verbose',
      '--output-format', 'stream-json',
    ];

    // Pass through host's permissionMode directly to Claude CLI. The host's
    // SessionManager translates ApprovalMode (plan/ask/auto) → PermissionMode
    // (plan/default/auto/bypassPermissions). cc-proxy is just a transport.
    //
    // For non-bypass modes we attach the in-process approval MCP server so
    // CLI's permission requests are relayed to host instead of denied
    // outright (which is what `claude -p` does without an interactive TTY).
    const mode = options?.permissionMode ?? 'default';
    if (mode === 'bypassPermissions') {
      args.push('--dangerously-skip-permissions');
    } else {
      args.push('--permission-mode', mode);
      if (session.mcpConfigPath) {
        args.push('--mcp-config', session.mcpConfigPath);
        args.push('--permission-prompt-tool', APPROVAL_PROMPT_TOOL);
      }
    }

    if (options?.effort) {
      args.push('--effort', options.effort);
    }

    if (session.hasHadFirstTurn) {
      args.push('--resume', session.claudeSessionId);
    } else {
      args.push('--session-id', session.claudeSessionId);
    }

    if (session.model) {
      args.push('--model', session.model);
    }

    return args;
  }
}
