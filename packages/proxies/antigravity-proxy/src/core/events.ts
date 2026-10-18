import type { SessionNotification } from '@agentclientprotocol/sdk';
import { MAX_ACTIVITY_JSON_BYTES, usageDataSchema } from '@gian/proxy-protocol';

import type { JsonRecord, ProjectionContext, WireEventDraft } from '../contracts.js';
import { redactRuntimeData } from './mcp.js';

/**
 * Projects one turn of ACP session updates into Gian content, activity, plan,
 * and usage drafts. Tool failure stays failed when a later bare `completed`
 * close arrives (the official server sends that shape for still-open tools at
 * end_turn). `agent_message_chunk` and `agent_thought_chunk` are literal
 * deltas: a chunk that begins with the text already seen is still appended.
 * ACP 1.3.0 usage_update carries context occupancy only (`used` and `size`).
 * Conversation token totals are unavailable. Text length is never turned
 * into usage, and a used count of zero is a real empty context.
 * Turn completion closes unresolved tool cards as cancelled or failed. It
 * does not mark them succeeded.
 */

type ContentKind = 'text' | 'reasoning';
type ActivityStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

interface ProjectionBook {
  closed: Set<string>;
  kinds: Map<string, ContentKind>;
  turnClosed: boolean;
}

const books = new WeakMap<ProjectionContext, ProjectionBook>();

const COMMAND_KEYS = ['CommandLine', 'command_line', 'command', 'cmd'] as const;
const QUERY_KEYS = ['Query', 'query', 'pattern', 'SearchPattern', 'search_pattern'] as const;
const PATH_KEYS = [
  'TargetFile',
  'target_file',
  'FilePath',
  'file_path',
  'AbsolutePath',
  'absolute_path',
  'path',
] as const;

function bookFor(context: ProjectionContext): ProjectionBook {
  const existing = books.get(context);
  if (existing) return existing;
  const created: ProjectionBook = { closed: new Set(), kinds: new Map(), turnClosed: false };
  books.set(context, created);
  return created;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function draft(method: string, data: JsonRecord): WireEventDraft {
  return { method, data };
}

function contentId(context: ProjectionContext, kind: ContentKind, slot: string): string {
  return `content:${context.sessionId}:${context.turnId}:${kind}:${slot}`;
}

function activityIdFor(context: ProjectionContext, toolCallId: string): string {
  return `tool:${context.sessionId}:${context.turnId}:${toolCallId}`;
}

function planIdFor(context: ProjectionContext, nativeId?: string): string {
  return nativeId
    ? `plan:${context.sessionId}:${context.turnId}:${nativeId}`
    : `plan:${context.sessionId}:${context.turnId}`;
}

function argumentRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return isRecord(value.arguments) ? value.arguments : value;
}

function firstString(record: Record<string, unknown> | null, keys: readonly string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return null;
}

function redactedString(value: string): string {
  const redacted = redactRuntimeData(value);
  return typeof redacted === 'string' ? redacted : value;
}

function locationPath(locations: unknown): string | null {
  if (!Array.isArray(locations)) return null;
  for (const location of locations) {
    if (isRecord(location) && nonEmpty(location.path)) return location.path;
  }
  return null;
}

function mapStatus(status: unknown): ActivityStatus | undefined {
  if (status === 'pending') return 'pending';
  if (status === 'in_progress') return 'running';
  if (status === 'completed') return 'succeeded';
  if (status === 'failed') return 'failed';
  return undefined;
}

function boundedDetails(details: JsonRecord): JsonRecord | undefined {
  if (Object.keys(details).length === 0) return undefined;
  const serialized = JSON.stringify(details);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_ACTIVITY_JSON_BYTES) {
    return { truncated: true };
  }
  return details;
}

function textFromContentBlock(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (value.type === 'text' && typeof value.text === 'string') return value.text;
  if (isRecord(value.content) && value.content.type === 'text' && typeof value.content.text === 'string') {
    return value.content.text;
  }
  return null;
}

function summaryFromToolContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  let summary = '';
  for (const item of content) {
    if (!isRecord(item) || item.type !== 'content') continue;
    const text = textFromContentBlock(item.content);
    if (text) summary += text;
  }
  return summary;
}

function presentationFor(
  kind: string,
  title: string,
  locations: unknown,
  rawInput: unknown,
): JsonRecord {
  const name = kind || title;
  const args = argumentRecord(rawInput);
  const path = locationPath(locations) ?? firstString(args, PATH_KEYS);
  if (path && (kind === 'read' || kind === 'edit' || kind === 'delete' || kind === 'move')) {
    const operation = kind === 'read'
      ? 'read'
      : kind === 'delete'
        ? 'delete'
        : kind === 'move'
          ? 'rename'
          : 'write';
    return {
      type: 'file',
      data: { path: redactedString(path), operation },
    };
  }
  if (kind === 'execute') {
    const command = firstString(args, COMMAND_KEYS);
    if (command) return { type: 'command', data: { command: redactedString(command) } };
  }
  if (kind === 'search') {
    const query = firstString(args, QUERY_KEYS);
    if (query) return { type: 'search', data: { query: redactedString(query) } };
  }
  return { type: 'tool', data: { name } };
}

function copyDetails(value: unknown): JsonRecord {
  if (!isRecord(value)) return {};
  const copy: JsonRecord = {};
  for (const [key, entry] of Object.entries(value)) copy[key] = entry;
  return copy;
}

function diagnostic(context: ProjectionContext, key: string, message: string): WireEventDraft[] {
  const cleaned = key.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 64) || 'unknown';
  const activityId = `diagnostic:${context.sessionId}:${context.turnId}:${cleaned}`;
  const data: JsonRecord = {
    activityId,
    kind: 'notice',
    title: 'Unsupported update',
    status: 'succeeded',
    presentation: {
      type: 'notice',
      tone: 'warning',
      data: { message: message.slice(0, 180) },
    },
  };
  context.activities.set(activityId, data);
  return [draft('activity.updated', data)];
}

function appendDelta(previous: string, incoming: string): { next: string; delta: string } | null {
  if (incoming.length === 0) return null;
  return { next: previous + incoming, delta: incoming };
}

function projectText(
  context: ProjectionContext,
  kind: ContentKind,
  update: Record<string, unknown>,
): WireEventDraft[] {
  const text = textFromContentBlock(update.content);
  if (text === null) return [];
  const slot = nonEmpty(update.messageId) ? update.messageId : 'default';
  const id = contentId(context, kind, slot);
  const book = bookFor(context);
  if (book.closed.has(id)) return [];
  const previous = context.text.get(id) ?? '';
  const appended = appendDelta(previous, text);
  if (appended === null) return [];
  context.text.set(id, appended.next);
  book.kinds.set(id, kind);
  const data: JsonRecord = { contentId: id, kind, delta: appended.delta };
  return [draft('content.delta', data)];
}

function projectTool(context: ProjectionContext, update: Record<string, unknown>, initial: boolean): WireEventDraft[] {
  if (!nonEmpty(update.toolCallId)) return [];
  if (initial && !nonEmpty(update.title)) return [];
  const activityId = activityIdFor(context, update.toolCallId);
  const previous = context.activities.get(activityId);
  const previousStatus = previous?.status;
  const mapped = mapStatus(update.status);
  const hasTerminalResult = update.rawOutput !== undefined
    || (Array.isArray(update.content) && update.content.length > 0);
  let status: ActivityStatus = mapped
    ?? (previousStatus === 'pending' || previousStatus === 'running' || previousStatus === 'succeeded'
      || previousStatus === 'failed' || previousStatus === 'cancelled'
      ? previousStatus
      : 'pending');
  if (previousStatus === 'failed' && mapped === 'succeeded' && !hasTerminalResult) status = 'failed';
  const title = nonEmpty(update.title)
    ? update.title
    : nonEmpty(previous?.title)
      ? previous.title
      : update.toolCallId;
  const kind = nonEmpty(update.kind)
    ? update.kind
    : nonEmpty(isRecord(previous?.presentation) && isRecord(previous.presentation.data)
      ? previous.presentation.data.name
      : undefined)
      ? String((previous?.presentation as { data?: { name?: unknown } }).data?.name ?? '')
      : '';
  const locations = update.locations !== undefined ? update.locations : undefined;
  const rawInput = update.rawInput !== undefined ? update.rawInput : undefined;
  const presentation = (update.kind !== undefined || locations !== undefined || rawInput !== undefined || !isRecord(previous?.presentation))
    ? presentationFor(typeof update.kind === 'string' ? update.kind : kind, title, locations ?? previousLocations(previous), rawInput ?? previousInput(previous))
    : previous.presentation;
  const details = copyDetails(previous?.details);
  if (rawInput !== undefined) details.input = redactRuntimeData(rawInput) as JsonRecord[string];
  if (update.rawOutput !== undefined) details.output = redactRuntimeData(update.rawOutput) as JsonRecord[string];
  if (update.locations !== undefined) details.locations = redactRuntimeData(update.locations) as JsonRecord[string];
  if (update.content === null) {
    delete details.content;
  } else if (update.content !== undefined) {
    details.content = redactRuntimeData(update.content) as JsonRecord[string];
  }
  const bounded = boundedDetails(details);
  const summarySource = update.content === null
    ? ''
    : Array.isArray(update.content)
      ? summaryFromToolContent(update.content)
      : nonEmpty(previous?.summary)
        ? previous.summary
        : '';
  const data: JsonRecord = {
    activityId,
    kind: 'tool',
    title,
    status,
    presentation,
  };
  if (summarySource) data.summary = redactedString(summarySource);
  if (bounded) data.details = bounded;
  context.activities.set(activityId, data);
  return [draft('activity.updated', data)];
}

function previousLocations(previous: JsonRecord | undefined): unknown {
  const details = previous?.details;
  if (!isRecord(details)) return undefined;
  return details.locations;
}

function previousInput(previous: JsonRecord | undefined): unknown {
  const details = previous?.details;
  if (!isRecord(details)) return undefined;
  return details.input;
}

function planStatus(status: unknown): 'pending' | 'in_progress' | 'completed' | 'failed' | null {
  if (status === 'pending' || status === 'in_progress' || status === 'completed' || status === 'failed') {
    return status;
  }
  return null;
}

function projectPlanEntries(
  context: ProjectionContext,
  planId: string,
  entries: unknown,
): WireEventDraft[] {
  if (!Array.isArray(entries)) return diagnostic(context, 'plan', 'Native plan entries were not a list.');
  const steps: JsonRecord[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!isRecord(entry) || !nonEmpty(entry.content)) continue;
    const status = planStatus(entry.status);
    if (status === null) continue;
    steps.push({ id: `step:${index}`, text: entry.content, status });
  }
  if (entries.length > 0 && steps.length === 0) return [];
  return [draft('plan.updated', { planId, title: 'Plan', steps })];
}

function projectPlanUpdate(context: ProjectionContext, update: Record<string, unknown>): WireEventDraft[] {
  const plan = update.plan;
  if (!isRecord(plan) || typeof plan.type !== 'string') {
    return diagnostic(context, 'plan-update', 'Native plan update was not readable.');
  }
  if (!nonEmpty(plan.id)) return diagnostic(context, 'plan-update', 'Native plan update had no id.');
  const planId = planIdFor(context, plan.id);
  if (plan.type === 'items') return projectPlanEntries(context, planId, plan.entries);
  if (plan.type === 'markdown') {
    if (!nonEmpty(plan.content)) return [];
    return [draft('plan.updated', {
      planId,
      title: 'Plan',
      steps: [{ id: 'step:markdown', text: plan.content, status: 'pending' }],
    })];
  }
  if (plan.type === 'file') {
    return diagnostic(context, 'plan-file', 'Native plan file updates are not inlined.');
  }
  const safeType = redactedString(plan.type).slice(0, 40);
  return diagnostic(context, 'plan-update', `Unsupported native plan type '${safeType}'.`);
}

function nonNegativeCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function positiveCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Official ACP 1.3.0 `_maybe_send_usage_update` emits only
 * `UsageUpdate { used, size }`. SDK cumulative counters stay inside the
 * server and are not client billing totals, so conversation token counts
 * are unavailable here.
 */
function projectUsage(context: ProjectionContext, update: Record<string, unknown>): WireEventDraft[] {
  if (!('used' in update)) return [];
  const used = nonNegativeCount(update.used);
  if (used === null) return [];
  const window = positiveCount(update.size);
  const data: JsonRecord = {
    context: window === null ? { used } : { used, window },
  };
  const parsed = usageDataSchema.safeParse(data);
  if (!parsed.success) return [];
  const emitted = parsed.data as JsonRecord;
  if (JSON.stringify(context.usage) === JSON.stringify(emitted)) return [];
  context.usage = emitted;
  return [draft('usage.updated', emitted)];
}

export function createProjectionContext(sessionId: string, turnId: string): ProjectionContext {
  return {
    sessionId,
    turnId,
    text: new Map(),
    activities: new Map(),
    usage: {},
  };
}

export function projectSessionUpdate(
  update: SessionNotification['update'],
  context: ProjectionContext,
): WireEventDraft[] {
  if (!isRecord(update) || !nonEmpty(update.sessionUpdate)) return [];
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      return projectText(context, 'text', update);
    case 'agent_thought_chunk':
      return projectText(context, 'reasoning', update);
    case 'user_message_chunk':
      return [];
    case 'tool_call':
      return projectTool(context, update, true);
    case 'tool_call_update':
      return projectTool(context, update, false);
    case 'plan':
      return projectPlanEntries(context, planIdFor(context), update.entries);
    case 'plan_update':
      return projectPlanUpdate(context, update);
    case 'plan_removed':
      if (!nonEmpty(update.id)) return [];
      return [draft('plan.updated', { planId: planIdFor(context, update.id), title: '', steps: [] })];
    case 'usage_update':
      return projectUsage(context, update);
    case 'available_commands_update':
    case 'current_mode_update':
    case 'config_option_update':
    case 'session_info_update':
      return [];
    default: {
      const safeKind = redactedString((update as { sessionUpdate: string }).sessionUpdate);
      return diagnostic(
        context,
        safeKind,
        `Unsupported native session update '${safeKind.slice(0, 80)}'.`,
      );
    }
  }
}

export type TurnProjectionOutcome = 'completed' | 'cancelled' | 'failed';

function unresolvedClose(outcome: TurnProjectionOutcome): { status: 'cancelled' | 'failed'; summary: string } {
  if (outcome === 'cancelled') {
    return {
      status: 'cancelled',
      summary: 'Native turn cancelled before this tool reported a terminal result.',
    };
  }
  return {
    status: 'failed',
    summary: 'Native turn ended before this tool reported a terminal result.',
  };
}

function closeUnresolvedActivities(
  context: ProjectionContext,
  outcome: TurnProjectionOutcome,
): WireEventDraft[] {
  const terminal = unresolvedClose(outcome);
  const drafts: WireEventDraft[] = [];
  for (const activityId of [...context.activities.keys()].sort()) {
    const previous = context.activities.get(activityId);
    if (!previous) continue;
    if (previous.status !== 'pending' && previous.status !== 'running') continue;
    const data: JsonRecord = {};
    for (const [key, value] of Object.entries(previous)) data[key] = value;
    data.status = terminal.status;
    data.summary = terminal.summary;
    context.activities.set(activityId, data);
    drafts.push(draft('activity.updated', data));
  }
  return drafts;
}

export function completeTurnProjection(
  context: ProjectionContext,
  outcome: TurnProjectionOutcome = 'completed',
): WireEventDraft[] {
  const book = bookFor(context);
  if (book.turnClosed) return [];
  book.turnClosed = true;
  const ids = [...context.text.keys()]
    .filter((id) => !book.closed.has(id) && book.kinds.has(id))
    .sort();
  const drafts: WireEventDraft[] = [];
  for (const id of ids) {
    const content = context.text.get(id);
    const kind = book.kinds.get(id);
    if (!content || !kind) continue;
    drafts.push(draft('content.completed', { contentId: id, kind, content }));
    book.closed.add(id);
  }
  drafts.push(...closeUnresolvedActivities(context, outcome));
  return drafts;
}
