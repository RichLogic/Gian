import type { ApprovalCategory, ApprovalDecision, Executor, RuntimeMode } from '@gian/shared';

export interface CreatedSessionFirstMessagePlan {
  switchToTty: boolean;
  ttyText: string | null;
  structuredText: string | null;
  seedOptimisticEcho: boolean;
}

/**
 * Decide how the App should dispatch the first message after session:create.
 * Claude pinned to `tty` (the default) switches to TTY so first-turn text
 * enters the interactive CLI path instead of `message:send`/`claude -p`.
 * Claude pinned to `structured` (and Codex) stay structured.
 */
export function planCreatedSessionFirstMessage(
  executor: Executor,
  pendingMessage: string | null | undefined,
  claudeChatSurface: ClaudeChatSurface = 'tty',
): CreatedSessionFirstMessagePlan {
  const text = pendingMessage?.trim() || null;
  if (executor === 'claude' && claudeChatSurface === 'tty') {
    return {
      switchToTty: true,
      ttyText: text,
      structuredText: null,
      seedOptimisticEcho: false,
    };
  }
  // Codex, or Claude pinned to structured (`claude -p`): stay structured.
  return {
    switchToTty: false,
    ttyText: null,
    structuredText: text,
    seedOptimisticEcho: text !== null,
  };
}

export type SessionSurface = 'chat' | 'beta' | 'cli';

// ---------------------------------------------------------------------------
// Chat-view preferences (Settings → 聊天视图). Pure helpers that decide which
// runtime tabs render and which surface a session opens on, given the global
// config. See docs/superpowers/specs/2026-06-06-chat-view-settings-design.md.
// ---------------------------------------------------------------------------

export type ClaudeChatSurface = 'structured' | 'tty';

export interface ChatViewConfig {
  claude_chat_surface: ClaudeChatSurface;
  claude_chat_cli: boolean;
  codex_chat_cli: boolean;
}

export const DEFAULT_CHAT_VIEW: ChatViewConfig = {
  claude_chat_surface: 'tty',
  claude_chat_cli: true,
  codex_chat_cli: false,
};

/** Normalize a (possibly partial / null) SystemConfig into concrete chat-view
 *  prefs, applying the same defaults loadConfig uses on the host. */
export function resolveChatView(
  cfg: Partial<ChatViewConfig> | null | undefined,
): ChatViewConfig {
  return {
    claude_chat_surface: cfg?.claude_chat_surface ?? DEFAULT_CHAT_VIEW.claude_chat_surface,
    claude_chat_cli: cfg?.claude_chat_cli ?? DEFAULT_CHAT_VIEW.claude_chat_cli,
    codex_chat_cli: cfg?.codex_chat_cli ?? DEFAULT_CHAT_VIEW.codex_chat_cli,
  };
}

/** CLI tab default that re-seeds whenever the user flips the Claude chat
 *  surface: structured → off, tty → on. */
export function reseedClaudeCli(surface: ClaudeChatSurface): boolean {
  return surface === 'tty';
}

/** The runtime a given surface implies. 'chat' is structured; 'beta'/'cli'
 *  are both TTY surfaces. */
export function runtimeForSurface(surface: SessionSurface): RuntimeMode {
  return surface === 'chat' ? 'structured' : 'tty';
}

/** The primary chat-area surface for an executor under the given prefs.
 *  Codex chat is always structured ('chat'); Claude follows the config —
 *  'beta' when tty is selected, else 'chat'. CLI is a separate optional tab,
 *  never the primary chat surface here. */
export function runtimeChatSurface(
  executor: Executor,
  cfg: ChatViewConfig,
): 'chat' | 'beta' {
  if (executor === 'claude' && cfg.claude_chat_surface === 'tty') return 'beta';
  return 'chat';
}

export interface RuntimeTab {
  surface: SessionSurface;
  /** i18n label kind: 'chat' (the primary surface) or 'cli'. */
  label: 'chat' | 'cli';
}

/** Tabs to render in the chat-area tablist for an executor under prefs.
 *  Always a primary chat tab; a CLI tab is appended when enabled for that
 *  executor. When the result has a single entry the caller hides the tab
 *  bar entirely. */
export function runtimeTabs(executor: Executor, cfg: ChatViewConfig): RuntimeTab[] {
  const tabs: RuntimeTab[] = [{ surface: runtimeChatSurface(executor, cfg), label: 'chat' }];
  const showCli = executor === 'claude' ? cfg.claude_chat_cli : cfg.codex_chat_cli;
  if (showCli) tabs.push({ surface: 'cli', label: 'cli' });
  return tabs;
}

export interface ApprovalResponseDispatchInput {
  executor: Executor;
  runtimeMode: RuntimeMode;
  surface: SessionSurface;
  decision: ApprovalDecision;
  answers?: Record<string, string | string[]>;
  context?: {
    category?: ApprovalCategory;
  };
}

export type ApprovalResponseDispatchPlan =
  | { channel: 'structured' }
  | { channel: 'tty'; text: string };

export function planApprovalResponseDispatch(input: ApprovalResponseDispatchInput): ApprovalResponseDispatchPlan {
  if (
    input.executor === 'claude'
    && input.runtimeMode === 'tty'
    && input.context?.category === 'question'
  ) {
    // TTY-mode AskUserQuestion always paste-routes back through the PTY,
    // regardless of which surface the user is looking at when they click an
    // answer. The structured approval bridge isn't wired in TTY mode — cc-proxy
    // returns 404 — so routing through `structured` outside the Beta surface
    // would just fail with APPROVAL_RESOLVE_FAILED. The Beta surface is still
    // the only place the QuestionCard is actionable in the UI, but during a
    // transient surface=chat→beta switch (or a stale render) we don't want the
    // click to silently 404.
    return {
      channel: 'tty',
      text: formatBetaQuestionResponse(input.decision, input.answers),
    };
  }
  return { channel: 'structured' };
}

export function formatBetaQuestionResponse(
  decision: ApprovalDecision,
  answers?: Record<string, string | string[]>,
): string {
  if (decision === 'decline') {
    return 'The user cancelled your AskUserQuestion via the Gian web UI. Treat it as unanswered and continue without using AskUserQuestion.';
  }
  return formatBetaQuestionAnswers(answers ?? {});
}

export function formatBetaQuestionAnswers(answers: Record<string, string | string[]>): string {
  const lines: string[] = [
    'The user answered your AskUserQuestion via the Gian web UI rather than letting the tool run. Use these answers and continue as if AskUserQuestion had returned them.',
    '',
  ];
  const entries = Object.entries(answers);
  if (entries.length === 0) {
    lines.push('No answers were provided.');
  } else {
    for (const [question, value] of entries) {
      lines.push(`Q: ${question}`);
      lines.push(`A: ${Array.isArray(value) ? value.join('; ') : value}`);
      lines.push('');
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  }
  return lines.join('\n');
}

export interface BetaComposerAttachment {
  path: string;
}

export type BetaComposerSendPlan =
  | { channel: 'noop' }
  | { channel: 'pty'; text: string }
  | { channel: 'stage_for_tty'; text: string };

/**
 * Beta always targets the interactive Claude TTY. If the UI has switched to
 * the Beta surface before the host confirms `runtime_mode='tty'`, keep the
 * user's first message and dispatch it once the TTY startup event arrives.
 */
export function planBetaComposerSend(
  runtimeMode: RuntimeMode,
  text: string,
  attachments: BetaComposerAttachment[] = [],
): BetaComposerSendPlan {
  // Pasted screenshots are uploaded to a real on-disk path before send. The
  // interactive `claude` in the PTY picks them up via its Read tool when the
  // path is framed as `[Attached image: <path>]` — the exact framing cc-proxy's
  // structured path uses (see buildPrompt in cc-proxy service.ts), which is the
  // one Claude reliably acts on. A looser "Attached files: - path" line often
  // got ignored.
  const attachmentText = attachments.length > 0
    ? `\n\n${attachments.map(a => `[Attached image: ${a.path}]`).join('\n')}`
    : '';
  const ttyText = `${text.trim()}${attachmentText}`.trim();
  if (!ttyText) return { channel: 'noop' };
  if (runtimeMode === 'tty') return { channel: 'pty', text: ttyText };
  return { channel: 'stage_for_tty', text: ttyText };
}
