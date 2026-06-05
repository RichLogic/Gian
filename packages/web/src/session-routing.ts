import type { ApprovalCategory, ApprovalDecision, Executor, RuntimeMode } from '@gian/shared';

export interface CreatedSessionFirstMessagePlan {
  switchToTty: boolean;
  ttyText: string | null;
  structuredText: string | null;
  seedOptimisticEcho: boolean;
}

/**
 * Decide how the App should dispatch the first message after session:create.
 * Claude defaults to TTY so first-turn text enters the interactive CLI path
 * instead of `message:send`/`claude -p`.
 */
export function planCreatedSessionFirstMessage(
  executor: Executor,
  pendingMessage: string | null | undefined,
): CreatedSessionFirstMessagePlan {
  const text = pendingMessage?.trim() || null;
  if (executor === 'claude') {
    return {
      switchToTty: true,
      ttyText: text,
      structuredText: null,
      seedOptimisticEcho: false,
    };
  }
  return {
    switchToTty: false,
    ttyText: null,
    structuredText: text,
    seedOptimisticEcho: text !== null,
  };
}

export type SessionSurface = 'chat' | 'beta' | 'cli';

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
