/**
 * Side Chat snapshot → transcript projection (gian.proxy/2.0 proposal §10.5).
 *
 * HOST CONTRACT (sidechat-coordinator/sidechat-store): the Host does NOT
 * forward Side Chat events as `event` envelopes on the shared event stream.
 * Transcript-relevant gian.proxy/2.0 notifications of a Side Chat route are
 * redacted and semantically compacted into a bounded transient event set. The
 * COMPLETE public snapshot — `events`, `user_inputs`, `uncertain_turn_id`, `state` —
 * is broadcast via `sidechat:created` / `sidechat:updated` and carried in
 * `state_sync.sidechats`. This module is the web-side read boundary for that
 * contract: it folds the snapshot's raw notifications through the SAME
 * display projection the live session pipeline uses (`applyEnvelope`), so a
 * Side Chat renders tools, activities, interactions, diffs, reasoning and
 * errors exactly like a normal transcript (§10.5: never a fake tool-less /
 * read-only mode).
 *
 * The notification → display mapping mirrors the Host's protocol-v2
 * projector (`packages/host/src/event/project-protocol-v2.ts`) — kept
 * web-owned because the web cannot import Host code. `step.updated` /
 * `request.updated` are trace-only and skipped here exactly as there.
 *
 * The snapshot carries no Gian turn numbers, so turns are numbered
 * sequentially by first-seen `turnId` across the merged user-input/event
 * timeline — deterministic for the same snapshot, which keeps transcript
 * item identities stable across re-projections.
 */
import type { EventEnvelope, Executor, SideChatInfo } from '@gian/shared';

import { applyEnvelope } from '../transcript/apply.js';
import type { TranscriptItem } from '../types.js';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function timestamp(value: unknown): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

function activityStatus(status: unknown): 'running' | 'success' | 'error' {
  if (status === 'succeeded') return 'success';
  if (status === 'failed' || status === 'cancelled') return 'error';
  return 'running';
}

const INTERACTION_KINDS = new Set(['question', 'choice', 'confirmation', 'permission']);
const PRESENTATION_TONES = new Set(['neutral', 'info', 'warning', 'danger']);

interface ProjectedEvent {
  callId: string;
  type: string;
  data: Record<string, unknown>;
}

function projectActivity(data: Record<string, unknown>): ProjectedEvent[] {
  const activityId = String(data.activityId ?? '');
  const presentation = asRecord(data.presentation);
  const presentationData = asRecord(presentation.data);
  const type = typeof presentation.type === 'string' ? presentation.type : 'generic';
  const status = activityStatus(data.status);
  const title = String(data.title ?? type);
  const summary = typeof data.summary === 'string' ? data.summary : undefined;

  if (type === 'command') {
    return [{
      callId: activityId,
      type: 'activity.command',
      data: {
        command: String(presentationData.command ?? title),
        status,
        itemId: activityId,
        ...(summary ? { stdout: summary } : {}),
      },
    }];
  }
  if (type === 'file') {
    const operation = String(presentationData.operation ?? 'write');
    if (operation === 'read') {
      return [{
        callId: activityId,
        type: 'activity.file-read',
        data: { path: String(presentationData.path ?? '') },
      }];
    }
    return [{
      callId: activityId,
      type: 'activity.file-change',
      data: {
        files: [{
          path: String(presentationData.path ?? ''),
          kind: operation === 'delete' ? 'delete' : 'update',
        }],
      },
    }];
  }
  if (type === 'search') {
    return [{
      callId: activityId,
      type: 'activity.web-search',
      data: { query: String(presentationData.query ?? title) },
    }];
  }
  if (type === 'agent') {
    const state = String(presentationData.state ?? 'running');
    return [{
      callId: activityId,
      type: 'agent',
      data: {
        agentId: String(presentationData.agentId ?? activityId),
        description: title,
        status: state === 'completed' ? 'done' : state === 'running' ? 'running' : 'error',
        ...(typeof presentationData.displayName === 'string'
          ? { agentType: presentationData.displayName }
          : {}),
        ...(typeof presentationData.output === 'string' ? { output: presentationData.output } : {}),
      },
    }];
  }
  if (type === 'notice') {
    return [{
      callId: activityId,
      type: 'activity.notice',
      data: {
        severity: presentation.tone === 'danger'
          ? 'error' as const
          : presentation.tone === 'warning' ? 'warning' as const : 'info' as const,
        code: typeof presentationData.code === 'string' ? presentationData.code : type,
        title,
        message: String(presentationData.message ?? summary ?? title),
      },
    }];
  }
  // Generic fallback — §15's stable default card for unknown activity kinds.
  return [{
    callId: activityId,
    type: 'activity.tool',
    data: {
      itemId: activityId,
      title,
      kind: String(presentationData.name ?? data.kind ?? type),
      status,
      ...(presentationData.input !== undefined ? { input: presentationData.input } : {}),
      ...(presentationData.output !== undefined ? { output: presentationData.output } : {}),
      ...(summary && presentationData.output === undefined ? { output: summary } : {}),
    },
  }];
}

function projectInteractionRequested(data: Record<string, unknown>): ProjectedEvent[] {
  const presentation = asRecord(data.presentation);
  const kind = typeof presentation.kind === 'string' ? presentation.kind : 'question';
  const actions = (Array.isArray(data.actions) ? data.actions : [])
    .map(asRecord)
    .map(action => ({
      id: String(action.id ?? ''),
      label: String(action.label ?? action.id ?? ''),
      style: (action.style === 'primary' || action.style === 'danger'
        ? action.style
        : 'secondary') as 'primary' | 'secondary' | 'danger',
    }));
  const inputs = (Array.isArray(data.inputs) ? data.inputs : [])
    .map(asRecord)
    .map(input => ({
      id: String(input.id ?? ''),
      type: (input.type === 'multiline_text'
        || input.type === 'single_select'
        || input.type === 'multi_select'
        || input.type === 'boolean'
        ? input.type
        : 'text') as 'text' | 'multiline_text' | 'single_select' | 'multi_select' | 'boolean',
      label: String(input.label ?? input.id ?? ''),
      required: input.required === true,
      ...(typeof input.description === 'string' ? { description: input.description } : {}),
      ...(typeof input.sensitive === 'boolean' ? { sensitive: input.sensitive } : {}),
      ...(typeof input.placeholder === 'string' ? { placeholder: input.placeholder } : {}),
      ...(typeof input.multiline === 'boolean' ? { multiline: input.multiline } : {}),
      ...(Array.isArray(input.choices) ? { choices: input.choices } : {}),
    }));
  const nativeOptions = actions.map(action => ({
    optionId: action.id,
    label: action.label,
    kind: action.id || 'other',
  }));
  // cc-proxy sends context.subject = { toolName, inputPreview }; flatten it
  // to "toolName\ninputPreview" so the approval card's cmd fallback
  // (data.subject) picks it up. A plain-string subject passes through.
  const rawSubject = asRecord(data.context).subject;
  let subject: string | undefined;
  if (typeof rawSubject === 'string') {
    subject = rawSubject;
  } else if (rawSubject && typeof rawSubject === 'object' && !Array.isArray(rawSubject)) {
    const subjectRecord = rawSubject as Record<string, unknown>;
    const toolName = typeof subjectRecord.toolName === 'string' ? subjectRecord.toolName : '';
    const inputPreview = typeof subjectRecord.inputPreview === 'string' ? subjectRecord.inputPreview : '';
    if (toolName) subject = inputPreview ? `${toolName}\n${inputPreview}` : toolName;
  }
  return [{
    callId: String(data.interactionId ?? ''),
    type: kind === 'permission' ? 'interaction.approval' : 'interaction.question',
    data: {
      approvalId: String(data.interactionId ?? ''),
      category: kind === 'permission' ? 'other' : 'question',
      risk: presentation.tone === 'danger' ? 'high' : presentation.tone === 'warning' ? 'medium' : 'low',
      title: String(data.title ?? (kind === 'permission' ? 'Permission required' : 'Question')),
      description: String(data.description ?? ''),
      scopeOptions: ['once'],
      nativeOptions,
      ...(INTERACTION_KINDS.has(kind) ? { interactionKind: kind } : {}),
      ...(typeof presentation.tone === 'string' && PRESENTATION_TONES.has(presentation.tone)
        ? { tone: presentation.tone }
        : {}),
      ...(subject ? { subject } : {}),
      ...(actions.length > 0 ? { actions } : {}),
      ...(inputs.length > 0 ? { inputs } : {}),
    },
  }];
}

/** One raw gian.proxy/2.0 notification → display events (empty = not
 *  transcript-relevant: step/request updated, catalog.changed, unknown). */
function projectNotification(notification: unknown): {
  turnId: string | null;
  ts: number;
  events: ProjectedEvent[];
} {
  const record = asRecord(notification);
  const params = asRecord(record.params);
  const method = typeof record.method === 'string' ? record.method : '';
  const data = asRecord(params.data);
  const ts = timestamp(params.emittedAt);
  const turnId = typeof params.turnId === 'string' ? params.turnId : null;
  const empty = { turnId, ts, events: [] };

  switch (method) {
    case 'content.delta':
    case 'content.completed': {
      const delta = method === 'content.delta';
      const text = delta ? String(data.delta ?? '') : String(data.content ?? '');
      if (!text) return empty;
      const contentId = String(data.contentId ?? '');
      if (data.kind === 'text') {
        return {
          turnId, ts,
          events: [{ callId: contentId, type: 'message', data: { text, delta, itemId: contentId } }],
        };
      }
      if (data.kind === 'reasoning') {
        return {
          turnId, ts,
          events: [{
            callId: contentId,
            type: 'activity.reasoning',
            data: { text, delta, itemId: contentId, kind: 'full' },
          }],
        };
      }
      if (data.kind === 'status') {
        return {
          turnId, ts,
          events: [{
            callId: contentId,
            type: 'activity.notice',
            data: { severity: 'info', code: 'status', title: 'Status', message: text },
          }],
        };
      }
      return empty;
    }
    case 'activity.updated':
      return { turnId, ts, events: projectActivity(data) };
    case 'interaction.requested':
      return { turnId, ts, events: projectInteractionRequested(data) };
    case 'interaction.resolved':
      return {
        turnId, ts,
        events: [{
          callId: String(data.interactionId ?? ''),
          type: 'interaction.resolved',
          data: {
            approvalId: String(data.interactionId ?? ''),
            decision: data.outcome === 'submitted' ? 'allow_once' : 'decline',
            auto: data.outcome !== 'submitted',
            nativeOptionId: typeof data.actionId === 'string' ? data.actionId : null,
            ...(typeof data.displaySummary === 'string'
              ? { answers: { summary: data.displaySummary } }
              : {}),
          },
        }],
      };
    case 'plan.updated': {
      const steps = Array.isArray(data.steps) ? data.steps : [];
      return {
        turnId, ts,
        events: [{
          callId: String(data.planId ?? ''),
          type: 'plan',
          data: {
            text: [
              data.title,
              ...steps.map(step => {
                const row = asRecord(step);
                return `- [${row.status === 'completed' ? 'x' : ' '}] ${String(row.text ?? '')}`;
              }),
            ].filter(Boolean).join('\n'),
            delta: false,
          },
        }],
      };
    }
    case 'diff.updated': {
      const files = Array.isArray(data.files)
        ? (data.files as Array<Record<string, unknown>>).map(file => ({
            path: String(file.path ?? ''),
            kind: (file.status === 'added'
              ? 'create'
              : file.status === 'deleted' ? 'delete' : 'update') as 'create' | 'delete' | 'update',
          }))
        : [...new Set(
            Array.from(String(data.diff ?? '').matchAll(/^\+\+\+\s+(?:b\/)?(.+)$/gm))
              .map(match => match[1])
              .filter((path): path is string => Boolean(path) && path !== '/dev/null'),
          )].map(path => ({ path, kind: 'update' as const }));
      return {
        turnId, ts,
        events: [{
          callId: String(data.diffId ?? ''),
          type: 'activity.file-change',
          data: { files, diff: String(data.diff ?? '') },
        }],
      };
    }
    case 'turn.started':
      return turnId
        ? { turnId, ts, events: [{ callId: turnId, type: 'state.turn-started', data: { turnId } }] }
        : empty;
    case 'turn.completed':
      return turnId
        ? { turnId, ts, events: [{ callId: turnId, type: 'state.turn-completed', data: { turnId } }] }
        : empty;
    case 'turn.failed':
    case 'runtime.error': {
      const error = method === 'turn.failed' ? asRecord(data.error) : data;
      return {
        turnId, ts,
        events: [{
          callId: turnId ?? String(error.domainCode ?? 'runtime'),
          type: 'state.error',
          data: {
            message: String(error.message ?? 'Runtime error'),
            retryable: error.retryable === true,
            code: String(error.domainCode ?? error.code ?? 'INTERNAL'),
          },
        }],
      };
    }
    // step.updated / request.updated are trace-only execution evidence;
    // catalog.changed carries no transcript content. Unknown methods: §15
    // stable default is "ignore for transcript" (activities/interactions
    // have their own fallback cards above).
    default:
      return empty;
  }
}

/** Visible text of one stored user input (InputItem[] as sent to turn.start;
 *  the minimal Side Chat composer only produces text, but older/skill items
 *  degrade gracefully). */
function userInputText(input: unknown): string {
  if (!Array.isArray(input)) return '';
  const parts: string[] = [];
  for (const entry of input) {
    const item = asRecord(entry);
    if (item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
      parts.push(item.text);
    } else if (item.type === 'skill' && typeof item.name === 'string') {
      parts.push(`/${item.name}`);
    }
  }
  return parts.join('\n');
}

export interface ProjectSideChatOptions {
  /** Localized line for a turn whose pre-crash outcome is uncertain
   *  (§10.5.3: shown as genuinely failed/interrupted, never auto-retried). */
  uncertainTurnMessage: string;
}

/**
 * Fold one Side Chat public snapshot into transcript items. Pure: the same
 * snapshot always yields the same items (stable ids), so callers may
 * re-project on every `sidechat:updated` without dedupe bookkeeping.
 */
export function projectSideChatSnapshot(
  snapshot: SideChatInfo,
  executor: Executor,
  options: ProjectSideChatOptions,
): TranscriptItem[] {
  // Merge the two timelines (user inputs / runtime events) by timestamp so
  // each user message lands ahead of the turn it started.
  const turnNumbers = new Map<string, number>();
  let latestTurn = 0;
  const turnOf = (turnId: string | null): number => {
    if (turnId === null) return latestTurn;
    const existing = turnNumbers.get(turnId);
    if (existing !== undefined) return existing;
    const assigned = turnNumbers.size + 1;
    turnNumbers.set(turnId, assigned);
    latestTurn = assigned;
    return assigned;
  };

  interface TimedEnvelope {
    ts: number;
    order: number;
    /** Proxy turn id of this entry (user input `turn_id` / notification
     *  `params.turnId`); null = joins the latest known turn. */
    turnId: string | null;
    envelope: EventEnvelope;
  }
  const timeline: TimedEnvelope[] = [];
  let order = 0;

  for (const entry of snapshot.user_inputs ?? []) {
    const text = userInputText(entry.input);
    if (!text) continue;
    const ts = timestamp(entry.created_at);
    timeline.push({
      ts,
      order: order++,
      turnId: typeof entry.turn_id === 'string' ? entry.turn_id : null,
      envelope: {
        session_id: snapshot.id,
        turn: 0, // assigned below in timeline order
        call_id: `sidechat-input:${entry.turn_id}:${order}`,
        event: 'user_message',
        ts,
        data: {
          text,
          ...(entry.context_items ? { context_items: entry.context_items } : {}),
          ...(entry.composer_document ? { composer_document: entry.composer_document } : {}),
        },
      },
    });
  }

  const terminatedTurns = new Set<string>();
  for (const raw of snapshot.events ?? []) {
    const { turnId, ts, events } = projectNotification(raw);
    if (turnId !== null && events.some(event =>
      event.type === 'state.turn-completed' || event.type === 'state.error')) {
      terminatedTurns.add(turnId);
    }
    for (const projected of events) {
      timeline.push({
        ts,
        order: order++,
        turnId,
        envelope: {
          session_id: snapshot.id,
          turn: 0,
          call_id: projected.callId,
          event: '',
          ts,
          data: {},
          display: { type: projected.type, data: projected.data } as unknown as EventEnvelope['display'],
        },
      });
    }
  }

  // §10.5.3: a crash-interrupted turn whose outcome is uncertain is shown as
  // genuinely failed/interrupted — never auto-retried, never silently live.
  if (snapshot.uncertain_turn_id && !terminatedTurns.has(snapshot.uncertain_turn_id)) {
    timeline.push({
      ts: Number.MAX_SAFE_INTEGER,
      order: order++,
      turnId: snapshot.uncertain_turn_id,
      envelope: {
        session_id: snapshot.id,
        turn: 0,
        call_id: `sidechat-uncertain:${snapshot.uncertain_turn_id}`,
        event: '',
        ts: timestamp(snapshot.updated_at),
        data: {},
        display: {
          type: 'state.error',
          data: { message: options.uncertainTurnMessage, retryable: false },
        } as unknown as EventEnvelope['display'],
      },
    });
  }

  timeline.sort((a, b) => (a.ts - b.ts) || (a.order - b.order));

  let items: TranscriptItem[] = [];
  for (const entry of timeline) {
    items = applyEnvelope(items, { ...entry.envelope, turn: turnOf(entry.turnId) }, executor);
  }
  return items;
}

/**
 * Merge a fresh projection with the live echo items of the previous list
 * (optimistic sends). An echo survives only while the snapshot has not yet
 * caught up with it: once the same text appears among the projected user
 * messages the canonical copy replaces the echo (§4.3/SES-003 semantics).
 * Failed echoes always survive — they are the retry affordance.
 */
export function mergeSideChatEchoes(
  projected: TranscriptItem[],
  previous: TranscriptItem[],
): TranscriptItem[] {
  const echoes = previous.filter(item => item.kind === 'user' && item.id.startsWith('optimistic:'));
  if (echoes.length === 0) return projected;
  const projectedUserTexts = new Set(
    projected.filter(item => item.kind === 'user').map(item => (item as { text: string }).text),
  );
  const surviving = echoes.filter(item => {
    if (item.kind !== 'user') return false;
    if (item.failed === true) return true;
    return !projectedUserTexts.has(item.text);
  });
  return surviving.length === 0 ? projected : [...projected, ...surviving];
}
