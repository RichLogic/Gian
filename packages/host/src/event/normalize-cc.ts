import type { ProxyNotification } from '@gian/shared';
import type {
  AgentSpawnData,
  ApprovalRequestedData,
  ApprovalResolvedData,
  AskQuestion,
  FileChangeSummary,
  DisplayEvent,
} from '@gian/shared';

/**
 * Project a raw cc-proxy notification into 0..N UI display records.
 * The output names are page selectors, not renamed Claude events. The
 * original method and payload are attached by projectNotification.
 *
 * cc does NOT emit: output.text.delta (non-streaming), diff.updated,
 *   output.command.delta, runtime.error, token_usage.updated.
 *
 * thinking is present in Claude -p stream-json, but the current cc-proxy
 * boundary does not forward it yet.
 *
 * approval.resolved field-name divergence:
 *   cc  uses data.behavior ('allow'|'deny') + no explicit scope
 *   codex uses data.decision + data.scope
 *   Discriminated by field presence in the approval_resolved case.
 */
export function projectCcNotification(
  raw: ProxyNotification,
  sessionId: string,
  turn: number,
): DisplayEvent[] {
  const data = (raw.params.data ?? {}) as Record<string, unknown>;

  switch (raw.method) {
    case 'output.text': {
      const itemId = String(
        data.itemId ?? (raw.params as Record<string, unknown>).callId ?? crypto.randomUUID(),
      );
      const text = String(data.text ?? '');
      return [
        {
          session_id: sessionId,
          turn,
          call_id: itemId,
          ts: Date.now(),
          type: 'message',
          data: { text, delta: false, itemId },
        },
      ];
    }

    case 'tool.use': {
      const toolName = String(data.toolName ?? data.name ?? '');
      const input = (data.input ?? {}) as Record<string, unknown>;
      const callId = String(
        data.callId ?? data.itemId ?? crypto.randomUUID(),
      );

      switch (toolName) {
        case 'Bash': {
          return [
            {
              session_id: sessionId,
              turn,
              call_id: callId,
              ts: Date.now(),
              type: 'activity.command',
              data: {
                command: String(input.command ?? ''),
                cwd: input.cwd != null ? String(input.cwd) : undefined,
                status: 'running',
                itemId: callId,
              },
            },
          ];
        }

        case 'Write':
        case 'Edit':
        case 'NotebookEdit': {
          const file = buildCcFileChangeSummary(toolName, input);
          // cc's Edit/Write tool inputs contain the actual replaced text
          // (old_string/new_string for Edit, content for Write). Synthesize a
          // unified diff so DiffCard can render real hunks instead of just
          // path + stat. Without this the diff body would render empty.
          const diff = buildCcSyntheticDiff(toolName, file.path, input);
          const events: DisplayEvent[] = [
            {
              session_id: sessionId,
              turn,
              call_id: callId,
              ts: Date.now(),
              type: 'activity.file-change',
              data: diff
                ? { files: [file], diff }
                : { files: [file] },
            },
          ];
          const plan = claudePlanWrite(toolName, input);
          if (plan) {
            events.push({
              session_id: sessionId,
              turn,
              call_id: `${callId}:plan`,
              ts: Date.now(),
              type: 'plan',
              data: { text: plan, delta: false },
            });
          }
          return events;
        }

        case 'Read': {
          const offset = input.offset != null ? Number(input.offset) : undefined;
          const limit = input.limit != null ? Number(input.limit) : undefined;
          return [
            {
              session_id: sessionId,
              turn,
              call_id: callId,
              ts: Date.now(),
              type: 'activity.file-read',
              data: {
                path: String(input.file_path ?? input.path ?? ''),
                startLine: offset,
                endLine:
                  offset != null && limit != null ? offset + limit - 1 : undefined,
              },
            },
          ];
        }

        case 'Glob': {
          return [
            {
              session_id: sessionId,
              turn,
              call_id: callId,
              ts: Date.now(),
              type: 'activity.file-search',
              data: {
                pattern: String(input.pattern ?? ''),
                kind: 'glob',
              },
            },
          ];
        }

        case 'Grep': {
          return [
            {
              session_id: sessionId,
              turn,
              call_id: callId,
              ts: Date.now(),
              type: 'activity.file-search',
              data: {
                pattern: String(input.pattern ?? ''),
                kind: 'grep',
              },
            },
          ];
        }

        case 'WebSearch': {
          return [
            {
              session_id: sessionId,
              turn,
              call_id: callId,
              ts: Date.now(),
              type: 'activity.web-search',
              data: { query: String(input.query ?? '') },
            },
          ];
        }

        case 'Agent':
        case 'Task': {
          return [
            {
              session_id: sessionId,
              turn,
              call_id: callId,
              ts: Date.now(),
              type: 'agent',
              data: {
                description: String(input.description ?? input.prompt ?? ''),
                status: 'running',
                input: Object.keys(input).length > 0 ? input : undefined,
              },
            },
          ];
        }

        default:
          // Unknown tool — fall through to legacy raw passthrough
          return [];
      }
    }

    case 'claude.task': {
      const toolUseId = String(data.toolUseId ?? data.callId ?? '');
      if (!toolUseId) return [];
      const update: AgentSpawnData = {
        agentId: typeof data.taskId === 'string' ? data.taskId : undefined,
        description: typeof data.description === 'string' ? data.description : '',
        status: data.status === 'done' || data.status === 'error' ? data.status : 'running',
        agentType: typeof data.agentType === 'string' ? data.agentType : undefined,
        output: typeof data.summary === 'string' ? data.summary : undefined,
        outputFile: typeof data.outputFile === 'string' ? data.outputFile : undefined,
        startedAt: typeof data.startedAt === 'number' ? data.startedAt : undefined,
        completedAt: typeof data.completedAt === 'number' ? data.completedAt : undefined,
      };
      return [{
        session_id: sessionId,
        turn,
        call_id: toolUseId,
        ts: Date.now(),
        type: 'agent',
        data: update,
      }];
    }

    case 'approval.requested': {
      const approvalId = String(data.approvalId ?? crypto.randomUUID());
      const toolName = String(data.toolName ?? '');

      // AskUserQuestion is special-cased: cc routes it through the same
      // `approval_prompt` MCP bridge as regular tool approvals, but the
      // semantics are "the agent wants to ask the user a question" not
      // "the agent wants permission". Detect it here, parse the questions
      // struct out of inputPreview, and tag category='question' so the UI
      // renders a structured QuestionCard. Answers are fed back via
      // approval:resolve.answers → cc-proxy's updatedInput channel.
      //
      // We detect by *either* the canonical toolName OR by input shape
      // (`{questions: [...]}`). Claude SDK has been known to namespace or
      // rename built-in tool names across versions; structural detection
      // keeps the question card working regardless of what the CLI calls it.
      const parsedQuestions = parseAskUserQuestionInput(data.inputPreview);
      const matchedByName = toolName === 'AskUserQuestion';
      const matchedByShape = parsedQuestions.length > 0;
      if (matchedByName || matchedByShape) {
        if (!matchedByName && matchedByShape) {
          // Heads-up: SDK is sending question events under an unexpected
          // toolName. The structural match catches it; logging here helps
          // us update the canonical list when this becomes the common case.
          // eslint-disable-next-line no-console
          console.warn(
            `[project-cc] AskUserQuestion detected by input shape, not toolName. toolName=${JSON.stringify(toolName)} — add to matcher if seen repeatedly.`,
          );
        }
        const firstQuestion = parsedQuestions[0]?.question?.trim();
        return [
          {
            session_id: sessionId,
            turn,
            call_id: approvalId,
            ts: Date.now(),
            type: 'interaction.question',
            data: {
              approvalId,
              category: 'question',
              risk: 'low',
              title: firstQuestion || 'Claude is asking you a question',
              description: '',
              scopeOptions: ['once'],
              toolName,
              questions: parsedQuestions,
            } satisfies ApprovalRequestedData,
          },
        ];
      }

      // ExitPlanMode arrives with explicit category='exit_plan_mode' set by
      // cc-proxy when toolName === 'ExitPlanMode' on the permission MCP path;
      // fall back to tool-name mapping for regular tool approvals.
      const category = typeof data.category === 'string' && data.category
        ? data.category as ApprovalRequestedData['category']
        : mapCcToolNameToCategory(toolName);
      const parsed = parseCcApprovalInput(data.inputPreview);
      return [
        {
          session_id: sessionId,
          turn,
          call_id: approvalId,
          ts: Date.now(),
          type: 'interaction.approval',
          data: {
            approvalId,
            category,
            risk: mapCcRisk(data.risk ?? data.riskLevel),
            title: category === 'exit_plan_mode'
              ? 'Plan ready for review'
              : String(data.title ?? toolName ?? 'Review request'),
            // Prefer claude's per-call description when present (Bash supplies
            // a one-liner explaining the command); fall back to whatever the
            // proxy sent (currently boilerplate "Tool X requires permission.").
            description: ccApprovalDescription(toolName, parsed) ?? String(data.description ?? ''),
            // Tool-aware extraction: the raw inputPreview is the JSON dump of
            // tool args, which is unreadable for users. Render the meaningful
            // bit (command / file_path / pattern / url / query) instead. Falls
            // back to the raw JSON for unknown tools so we never lose info.
            subject: ccApprovalSubject(toolName, parsed)
              ?? (data.inputPreview != null ? String(data.inputPreview) : undefined),
            // cc has no native session-scope, but Gian's ApprovalManager
            // tracks an in-process allowlist by category — exposing the
            // 'session' option lets the user click "Allow session" once and
            // skip future approvals of the same category for this session.
            // Restricted to known categories; 'other' / 'exit_plan_mode' stay
            // per-call.
            scopeOptions: category === 'command' || category === 'file_write_outside_ws' || category === 'network'
              ? ['once', 'session']
              : ['once'],
            // For exit_plan_mode, advertise the three-way action set so the
            // UI renders Claude Code's native "auto / ask / keep planning"
            // buttons. scopeOptions stays ['once'] but the UI ignores it
            // when planActions is present.
            ...(category === 'exit_plan_mode'
              ? { planActions: ['accept_with_auto', 'accept_with_ask', 'keep_planning'] as const }
              : {}),
            toolName: toolName || undefined,
          } satisfies ApprovalRequestedData,
        },
      ];
    }

    case 'auto.classifier_denied': {
      const callId = String(data.callId ?? crypto.randomUUID());
      return [
        {
          session_id: sessionId,
          turn,
          call_id: callId,
          ts: Date.now(),
          type: 'activity.classifier-denied',
          data: {
            action: String(data.action ?? ''),
            reason: String(data.reason ?? ''),
            consecutive: Number(data.consecutive ?? 0),
            total: Number(data.total ?? 0),
          },
        },
      ];
    }

    case 'auto.circuit_breaker': {
      const callId = String(data.callId ?? crypto.randomUUID());
      const trigger = data.trigger === 'total' ? 'total' : 'consecutive';
      return [
        {
          session_id: sessionId,
          turn,
          call_id: callId,
          ts: Date.now(),
          type: 'activity.circuit-breaker',
          data: {
            trigger,
            consecutive: Number(data.consecutive ?? 0),
            total: Number(data.total ?? 0),
          },
        },
      ];
    }

    case 'approval.resolved': {
      const approvalId = String(data.approvalId ?? '');
      if (!approvalId) return [];

      // Discriminate by field: cc uses data.behavior; codex uses data.decision.
      // This adapter only handles cc notifications, but guard defensively.
      let decision: 'allow_once' | 'allow_session' | 'decline';
      if ('behavior' in data) {
        const behavior = String(data.behavior ?? '');
        decision = behavior === 'deny' || behavior === 'decline' ? 'decline' : 'allow_once';
      } else {
        // fallback for unexpected shapes
        const dec = String(data.decision ?? '');
        const scope = String(data.scope ?? '');
        if (dec === 'decline' || dec === 'deny') decision = 'decline';
        else if (scope === 'session') decision = 'allow_session';
        else decision = 'allow_once';
      }

      // AskUserQuestion answers (when present) ride along so a resolved
      // question card can show what was picked even after a page reload.
      const answers = data.answers && typeof data.answers === 'object' && !Array.isArray(data.answers)
        ? data.answers as Record<string, string | string[]>
        : undefined;
      return [
        {
          session_id: sessionId,
          turn,
          call_id: approvalId,
          ts: Date.now(),
          type: 'interaction.resolved',
          data: {
            approvalId,
            decision,
            // cc relay mode: the user explicitly clicked; never auto-resolved
            auto: false,
            ...(answers ? { answers } : {}),
          } satisfies ApprovalResolvedData,
        },
      ];
    }

    case 'turn.completed': {
      const turnId = String(raw.params.turnId ?? turn);
      return [
        {
          session_id: sessionId,
          turn,
          call_id: turnId,
          ts: Date.now(),
          type: 'state.turn-completed',
          data: {
            turnId,
            summary: data.result != null ? String(data.result) : undefined,
          },
        },
      ];
    }

    case 'turn.failed': {
      const msg = String(data.error ?? data.message ?? 'turn failed');
      return [
        {
          session_id: sessionId,
          turn,
          call_id: crypto.randomUUID(),
          ts: Date.now(),
          type: 'state.error',
          data: {
            message: msg,
            // cc spawns one process per session; process crash = retryable
            retryable: isProcessCrash(msg),
          },
        },
      ];
    }

    case 'runtime.error': {
      // Emitted by cc-proxy spawn.ts crash safety net (uncaughtException /
      // unhandledRejection). Surfacing as session_error so the user sees the
      // crash reason in the transcript instead of just a silent stuck spinner.
      return [
        {
          session_id: sessionId,
          turn,
          call_id: crypto.randomUUID(),
          ts: Date.now(),
          type: 'state.error',
          data: {
            message: String(data.message ?? 'cc-proxy crashed'),
            retryable: true,
            code: data.code != null ? String(data.code) : undefined,
          },
        },
      ];
    }

    case 'turn.started': {
      return [
        {
          session_id: sessionId,
          turn,
          call_id: 'turn-start',
          ts: Date.now(),
          type: 'state.turn-started',
          data: { turnId: String((raw.params as { turnId?: unknown }).turnId ?? '') },
        },
      ];
    }

    // Intentionally dropped:
    case 'token_usage.updated': // M2 session stats layer
    case 'debug':               // discard
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pull `AskQuestion[]` out of the JSON-stringified input cc-proxy puts in
 * `inputPreview`. The shape is the AskUserQuestion tool's input contract:
 * `{ questions: [{ question, header?, multiSelect?, options: [{label, description?}] }] }`.
 * Lossy on bad input — returns `[]` so the UI just shows an empty card
 * rather than crashing.
 */
function parseAskUserQuestionInput(raw: unknown): AskQuestion[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as { questions?: unknown };
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.questions)) {
      return [];
    }
    return parsed.questions
      .filter((q): q is Record<string, unknown> => q != null && typeof q === 'object')
      .map((q): AskQuestion => ({
        question: typeof q.question === 'string' ? q.question : '',
        header: typeof q.header === 'string' ? q.header : undefined,
        multiSelect: q.multiSelect === true,
        options: Array.isArray(q.options)
          ? q.options
            .filter((o): o is Record<string, unknown> => o != null && typeof o === 'object')
            .map(o => ({
              label: typeof o.label === 'string' ? o.label : '',
              description: typeof o.description === 'string' ? o.description : undefined,
            }))
          : [],
      }));
  } catch (err) {
    // Silently returning [] here used to make it hard to diagnose why a
    // question card came up empty. Surface the failure so it's visible in
    // host.err if Claude SDK ever changes the input shape.
    // eslint-disable-next-line no-console
    console.warn(
      `[project-cc] parseAskUserQuestionInput: JSON parse failed (${err instanceof Error ? err.message : String(err)})`,
    );
    return [];
  }
}

function mapCcToolNameToCategory(
  toolName: string,
): 'command' | 'network' | 'file_write_outside_ws' | 'other' {
  if (toolName === 'Bash') return 'command';
  if (toolName === 'WebSearch' || toolName === 'WebFetch') return 'network';
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') return 'file_write_outside_ws';
  return 'other';
}

/**
 * Parse the JSON-stringified `inputPreview` cc-proxy puts on every approval.
 * Returns `null` on bad input — callers fall back to the raw string so we
 * never lose info even if the shape changes.
 */
function parseCcApprovalInput(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/**
 * Tool-aware extraction of the "what is this approval about" line. Replaces
 * the raw JSON dump with the meaningful field per tool. Returns `undefined`
 * for unknown tools so the caller can fall back to the raw string.
 */
function ccApprovalSubject(toolName: string, parsed: Record<string, unknown> | null): string | undefined {
  if (!parsed) return undefined;
  const s = (k: string) => typeof parsed[k] === 'string' ? parsed[k] as string : '';
  switch (toolName) {
    case 'ExitPlanMode': {
      // cc-proxy now routes ExitPlanMode through the regular permission MCP
      // bridge; inputPreview is the SDK's JSON dump `{"plan": "<markdown>"}`.
      // Pull the plan body out so the UI can render markdown directly.
      const plan = s('plan').trim();
      return plan || undefined;
    }
    case 'Bash': {
      const cmd = s('command').trim();
      return cmd || undefined;
    }
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return s('file_path') || s('notebook_path') || s('path') || undefined;
    case 'Read':
      return s('file_path') || s('path') || undefined;
    case 'Glob':
    case 'Grep': {
      const pattern = s('pattern');
      const path = s('path');
      if (!pattern) return undefined;
      return path ? `${pattern}  in  ${path}` : pattern;
    }
    case 'WebSearch':
      return s('query') || undefined;
    case 'WebFetch':
      return s('url') || undefined;
    case 'Task': {
      const desc = s('description') || s('prompt');
      return desc ? desc.slice(0, 200) : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Per-tool description override. Bash supplies a one-liner via `description`
 * that's much more useful than the boilerplate "Tool X requires permission."
 * cc-proxy emits. Returns `undefined` to defer to the proxy's default.
 */
function ccApprovalDescription(toolName: string, parsed: Record<string, unknown> | null): string | undefined {
  if (!parsed) return undefined;
  if (toolName === 'Bash') {
    const desc = typeof parsed.description === 'string' ? parsed.description.trim() : '';
    return desc || undefined;
  }
  return undefined;
}

function mapCcRisk(v: unknown): 'low' | 'medium' | 'high' {
  const s = String(v ?? '').toLowerCase();
  if (s === 'high' || s.includes('danger')) return 'high';
  if (s === 'low') return 'low';
  return 'medium';
}

function isProcessCrash(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes('crash') ||
    lower.includes('exit') ||
    lower.includes('sigkill') ||
    lower.includes('sigterm') ||
    lower.includes('econnreset') ||
    lower.includes('socket hang up')
  );
}

/**
 * Build a unified diff string from cc's Edit/Write inputs. The shape mirrors
 * `git diff` (`diff --git`, `---`, `+++`, `@@`) so the existing transcript
 * parser (`parseUnifiedDiff` in web/transcript/apply.ts) handles it without
 * any special-casing. Returns an empty string when there's nothing useful to
 * render — caller should omit the `diff` field in that case.
 *
 *   - Edit/NotebookEdit: del all `old_string` lines, add all `new_string`
 *     lines. cc Edit is a literal text replace, so showing it as a single
 *     contiguous swap matches the operation semantics.
 *   - Write: treat as a brand-new file — every line is an addition under a
 *     synthetic `@@ -0,0 +1,N @@` hunk header.
 */
function buildCcSyntheticDiff(
  toolName: string,
  path: string,
  input: Record<string, unknown>,
): string {
  if (!path) return '';
  const header = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`;

  if (toolName === 'Write') {
    const content = String(input.content ?? '');
    if (!content) return '';
    const lines = content.split('\n');
    return (
      header
      + `@@ -0,0 +1,${lines.length} @@\n`
      + lines.map((l) => `+${l}`).join('\n')
      + '\n'
    );
  }

  if (toolName === 'Edit' || toolName === 'NotebookEdit') {
    const oldStr = String(input.old_string ?? '');
    const newStr = String(input.new_string ?? '');
    if (!oldStr && !newStr) return '';
    const oldLines = oldStr ? oldStr.split('\n') : [];
    const newLines = newStr ? newStr.split('\n') : [];
    return (
      header
      + `@@ -1,${oldLines.length} +1,${newLines.length} @@\n`
      + oldLines.map((l) => `-${l}`).join('\n')
      + (oldLines.length && newLines.length ? '\n' : '')
      + newLines.map((l) => `+${l}`).join('\n')
      + '\n'
    );
  }

  return '';
}

function buildCcFileChangeSummary(
  toolName: string,
  input: Record<string, unknown>,
): FileChangeSummary {
  const path = String(input.file_path ?? input.path ?? '');

  if (toolName === 'Write') {
    // Write always creates or overwrites
    return { path, kind: 'create' };
  }

  if (toolName === 'Edit' || toolName === 'NotebookEdit') {
    // cc Edit provides old_string / new_string; count lines as rough proxy for adds/dels
    const oldStr = String(input.old_string ?? '');
    const newStr = String(input.new_string ?? '');
    const removed = oldStr ? oldStr.split('\n').length : undefined;
    const added = newStr ? newStr.split('\n').length : undefined;
    return { path, kind: 'update', added, removed };
  }

  return { path, kind: 'update' };
}

function claudePlanWrite(
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  if (toolName !== 'Write' || typeof input.content !== 'string') return null;
  const path = String(input.file_path ?? input.path ?? '').replaceAll('\\', '/');
  if (!/(^|\/)\.claude(?:-[^/]+)?\/plans\//.test(path)) return null;
  const content = input.content.trim();
  return content || null;
}
