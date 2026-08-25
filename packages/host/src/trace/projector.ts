import type {
  JsonValue,
  TraceItem,
  TraceItemKind,
  TraceSnapshot,
  TraceStatus,
} from '@gian/shared';
import type { TraceEvidenceRow } from './evidence-store.js';

/**
 * Deterministic Trace projection over canonical execution evidence.
 *
 * Pure module: no DB, no time source, no randomness — the same rows always
 * produce the same snapshot. Ordering follows the protocol sequence numbers;
 * timestamps come only from provider-emitted events.
 *
 * Projection rules:
 * - one Turn item per provider turnId: turn.started plus the latest terminal
 *   event (turn.failed wins over turn.completed) aggregate into one item;
 * - one Tool item per (turnId, toolCallId): started/updated/completed
 *   aggregate into one item — updates never create extra rows;
 * - assistant/reasoning/plan content streams aggregate per contentId;
 * - input/agent/notice/plan.updated emit one item per native event;
 * - evidence marking: direct projection of one native event = native;
 *   reliable aggregation of several events = derived; nothing in this slice
 *   is generated at the Core boundary, so no synthetic items are emitted;
 * - durations exist only when both start and end are known;
 * - snapshot.partial is set for any structural evidence gap (missing turn
 *   boundary, orphan tool completion, unattachable rows, unparseable
 *   timestamps) — never crashes on incomplete input.
 */

/** Bounds for summary text exposed on TraceItems. */
export const TRACE_SUMMARY_MAX_CHARS = 512;
export const TRACE_TITLE_MAX_CHARS = 200;

interface TimedRow {
  row: TraceEvidenceRow;
  atMs: number | null;
}

interface Projected {
  item: TraceItem;
  firstGeneration: number;
  firstSequence: number;
}

export function projectTraceSnapshot(
  sessionId: string,
  rows: TraceEvidenceRow[],
  generatedAt: string,
): TraceSnapshot {
  // Stable session-level order: Host-assigned stream generation first (the
  // protocol resets sequence on re-attach), protocol sequence within a
  // stream, eventId tiebreak keeps the order total.
  const ordered = [...rows].sort((a, b) =>
    a.streamGeneration - b.streamGeneration
    || a.sequence - b.sequence
    || a.eventId.localeCompare(b.eventId),
  );
  // Replay-safe: one item contribution per eventId, first occurrence wins.
  const seen = new Set<string>();
  const timed: TimedRow[] = [];
  for (const row of ordered) {
    if (seen.has(row.eventId)) continue;
    seen.add(row.eventId);
    timed.push({ row, atMs: parseIso(row.emittedAt) });
  }

  let partial = false;
  const markPartial = (): void => { partial = true; };
  if (timed.length === 0) markPartial(); // no evidence at all (old sessions)

  // Events without a turnId cannot be attached to any item.
  const turnGroups = new Map<string, TimedRow[]>();
  for (const entry of timed) {
    if (!entry.row.turnId) {
      markPartial();
      continue;
    }
    const group = turnGroups.get(entry.row.turnId) ?? [];
    group.push(entry);
    turnGroups.set(entry.row.turnId, group);
  }
  for (const entry of timed) {
    if (entry.atMs === null) markPartial();
  }

  const projected: Projected[] = [];
  for (const [turnId, group] of turnGroups) {
    projected.push(...projectTurn(turnId, group, markPartial));
  }
  projected.sort((a, b) =>
    a.firstGeneration - b.firstGeneration
    || a.firstSequence - b.firstSequence
    || a.item.id.localeCompare(b.item.id),
  );
  return {
    sessionId,
    generatedAt,
    partial,
    items: projected.map(entry => entry.item),
  };
}

function projectTurn(
  turnId: string,
  group: TimedRow[],
  markPartial: () => void,
): Projected[] {
  const started = group.find(entry => entry.row.method === 'turn.started');
  const failed = lastWith(group, 'turn.failed');
  const completed = lastWith(group, 'turn.completed');
  const terminal = failed ?? completed;
  const first = group[0]!;
  const source: string[] = [];
  for (const entry of [started, terminal]) {
    if (entry && !source.includes(entry.row.eventId)) source.push(entry.row.eventId);
  }

  if (!started) markPartial();
  if (!terminal) markPartial();

  const atEntry = started ?? first;
  const detail: Record<string, unknown> = {};
  if (failed) detail['error'] = failed.row.data['error'];
  if (completed) detail['stopReason'] = completed.row.data['stopReason'];

  const inputEntry = group.find(entry => entry.row.method === 'input.recorded');
  let summary = inputEntry ? boundedString(firstInputText(inputEntry.row.data)) : undefined;
  if (!summary) {
    const assistant = group.find(entry => (
      entry.row.method === 'content.completed' && entry.row.data['kind'] === 'text'
    ));
    summary = boundedString(assistant?.row.data['content']);
  }

  const item: TraceItem = {
    id: `turn:${turnId}`,
    turnId,
    kind: 'turn',
    shape: 'span',
    title: 'Turn',
    ...(summary ? { summary } : {}),
    status: failed ? 'failed' : completed ? mapStopReason(completed.row.data['stopReason']) : 'running',
    at: atEntry.row.emittedAt,
    ...terminalTiming(started, terminal),
    evidence: 'derived',
    correlationId: turnId,
    sourceEventIds: source,
    ...(Object.keys(detail).length > 0 ? { detail: toJsonValue(detail) } : {}),
  };
  const projected: Projected[] = [{
    item,
    firstGeneration: atEntry.row.streamGeneration,
    firstSequence: atEntry.row.sequence,
  }];

  // --- Runtime steps: running/terminal snapshots aggregate by stepId ---
  const steps = new Map<string, TimedRow[]>();
  for (const entry of group) {
    if (entry.row.method !== 'step.updated') continue;
    const stepId = stringValue(entry.row.data['stepId']);
    if (!stepId) {
      markPartial();
      continue;
    }
    const list = steps.get(stepId) ?? [];
    list.push(entry);
    steps.set(stepId, list);
  }
  for (const [stepId, rows] of steps) {
    projected.push(projectStep(turnId, stepId, rows));
  }

  // --- Tool items: started/updated/completed aggregate by toolCallId ---
  const tools = new Map<string, TimedRow[]>();
  for (const entry of group) {
    if (!isToolMethod(entry.row.method)) continue;
    const toolCallId = stringValue(entry.row.data['toolCallId']);
    if (!toolCallId) {
      markPartial();
      continue;
    }
    const list = tools.get(toolCallId) ?? [];
    list.push(entry);
    tools.set(toolCallId, list);
  }
  for (const [toolCallId, rows] of tools) {
    projected.push(projectTool(turnId, toolCallId, rows, markPartial));
  }

  const activities = new Map<string, TimedRow[]>();
  for (const entry of group) {
    if (entry.row.method !== 'activity.updated') continue;
    // Older Codex adapters exposed every app-server notification as a generic
    // activity. Keep that raw evidence in storage, but do not promote those
    // transport diagnostics into either conversation rows or Trace spans.
    if (isLegacyCodexNotificationActivity(entry.row.data)) continue;
    const activityId = stringValue(entry.row.data['activityId']);
    if (!activityId) {
      markPartial();
      continue;
    }
    const list = activities.get(activityId) ?? [];
    list.push(entry);
    activities.set(activityId, list);
  }
  for (const [activityId, rows] of activities) {
    projected.push(projectActivity(turnId, activityId, rows, markPartial));
  }

  const requests = new Map<string, TimedRow[]>();
  for (const entry of group) {
    if (entry.row.method !== 'request.updated') continue;
    const requestId = stringValue(entry.row.data['requestId']);
    if (!requestId) {
      markPartial();
      continue;
    }
    const list = requests.get(requestId) ?? [];
    list.push(entry);
    requests.set(requestId, list);
  }
  for (const [requestId, rows] of requests) {
    projected.push(projectRequest(turnId, requestId, rows));
  }

  // --- Content streams: text/reasoning/plan aggregate by contentId ---
  const content = new Map<string, TimedRow[]>();
  for (const entry of group) {
    if (entry.row.method !== 'content.delta' && entry.row.method !== 'content.completed') continue;
    const contentId = stringValue(entry.row.data['contentId']);
    const kind = stringValue(entry.row.data['kind']);
    // command/status streams are intentionally excluded from TraceItemKind;
    // malformed rows (missing contentId/kind) are an evidence gap.
    if (kind === 'command' || kind === 'status') continue;
    if (!contentId || !kind) {
      markPartial();
      continue;
    }
    const key = `${contentId}\u0000${kind}`;
    const list = content.get(key) ?? [];
    list.push(entry);
    content.set(key, list);
  }
  for (const [key, rows] of content) {
    const separator = key.indexOf('\u0000');
    projected.push(projectContent(
      turnId,
      key.slice(0, separator),
      key.slice(separator + 1) as 'text' | 'reasoning' | 'plan',
      rows,
    ));
  }

  // --- Single-event items ---
  for (const entry of group) {
    const single = projectSingleEventItem(turnId, entry);
    if (single) projected.push(single);
  }
  return projected;
}

function isLegacyCodexNotificationActivity(data: Record<string, unknown>): boolean {
  const presentation = data['presentation'];
  if (!presentation || typeof presentation !== 'object' || Array.isArray(presentation)) return false;
  const record = presentation as Record<string, unknown>;
  const presentationData = record['data'];
  if (!presentationData || typeof presentationData !== 'object' || Array.isArray(presentationData)) {
    return false;
  }
  return record['type'] === 'generic'
    && typeof (presentationData as Record<string, unknown>)['nativeMethod'] === 'string'
    && stringValue(data['title'])?.startsWith('Codex event: ') === true;
}

function projectTool(
  turnId: string,
  toolCallId: string,
  rows: TimedRow[],
  markPartial: () => void,
): Projected {
  const started = rows.find(entry => entry.row.method === 'tool.started');
  const completed = lastWith(rows, 'tool.completed');
  const first = rows[0]!;
  const lastUpdate = [...rows].reverse().find(entry => entry.row.method === 'tool.updated');
  if (!started) markPartial();

  const startedData = started?.row.data ?? {};
  const completedData = completed?.row.data ?? {};
  const title = boundedString(
    stringValue(startedData['title']) ?? stringValue(startedData['name']) ?? 'Tool',
    TRACE_TITLE_MAX_CHARS,
  ) ?? 'Tool';
  let summary: string | undefined;
  if (startedData['input'] !== undefined) {
    summary = boundedJson(startedData['input']);
  } else {
    summary = boundedString(lastUpdate?.row.data['statusText']);
  }
  if (!summary && completedData['error'] !== undefined) {
    summary = boundedJson(completedData['error']);
  }

  const detail: Record<string, unknown> = {};
  const name = stringValue(startedData['name']);
  if (name) detail['name'] = name;
  const statusText = stringValue(lastUpdate?.row.data['statusText']);
  if (statusText) detail['statusText'] = statusText;
  if (completedData['error'] !== undefined) detail['error'] = completedData['error'];

  const item: TraceItem = {
    id: `tool:${turnId}:${toolCallId}`,
    turnId,
    kind: 'tool',
    shape: 'span',
    title,
    ...(summary ? { summary } : {}),
    status: completed ? mapToolStatus(completedData['status']) : 'running',
    at: first.row.emittedAt,
    // Duration requires a real tool.started: an update or the completion
    // event itself must never stand in for the start time.
    ...terminalTiming(started, completed),
    evidence: 'derived',
    ...stepParent(turnId, rows),
    correlationId: toolCallId,
    sourceEventIds: rows.map(entry => entry.row.eventId),
    ...(Object.keys(detail).length > 0 ? { detail: toJsonValue(detail) } : {}),
  };
  return {
    item,
    firstGeneration: first.row.streamGeneration,
    firstSequence: first.row.sequence,
  };
}

function projectActivity(
  turnId: string,
  activityId: string,
  rows: TimedRow[],
  markPartial: () => void,
): Projected {
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const lastData = last.row.data;
  const reversedRows = [...rows].reverse();
  const semanticRow = reversedRows.find(entry => {
    const candidate = entry.row.data['presentation'];
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const candidateType = stringValue((candidate as Record<string, unknown>)['type']);
    return candidateType !== 'generic' && candidateType !== 'tool';
  }) ?? reversedRows.find(entry => {
    const candidate = entry.row.data['presentation'];
    return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      && stringValue((candidate as Record<string, unknown>)['type']) !== 'generic';
  });
  const semanticData = semanticRow?.row.data ?? lastData;
  const presentation = semanticData['presentation'] && typeof semanticData['presentation'] === 'object'
    ? semanticData['presentation'] as Record<string, unknown>
    : {};
  const type = stringValue(presentation['type']) ?? 'generic';
  const title = boundedString(
    stringValue(semanticData['title']) ?? stringValue(lastData['title'])
      ?? stringValue(semanticData['kind']) ?? type,
    TRACE_TITLE_MAX_CHARS,
  ) ?? 'Activity';
  const status = mapToolStatus(lastData['status']);
  const pointEvent = type === 'notice';
  const started = rows.find(entry => entry.row.data['status'] === 'running');
  if (!pointEvent && !started) markPartial();
  const nativeStartMs = nativeActivityTimestamp(rows, 'started');
  const nativeEndMs = nativeActivityTimestamp(rows, 'completed');
  const terminal = status === 'running' ? undefined : last;
  const detail: Record<string, unknown> = { presentation };
  if (lastData['details'] !== undefined) detail['details'] = lastData['details'];
  else if (semanticData['details'] !== undefined) detail['details'] = semanticData['details'];
  const item: TraceItem = {
    id: `activity:${turnId}:${activityId}`,
    turnId,
    kind: type === 'agent' ? 'agent' : pointEvent ? 'notice' : 'tool',
    shape: pointEvent ? 'event' : 'span',
    title,
    ...(stringValue(lastData['summary']) || stringValue(semanticData['summary'])
      ? { summary: boundedString(stringValue(lastData['summary']) ?? semanticData['summary']) }
      : {}),
    status,
    at: nativeStartMs !== null ? new Date(nativeStartMs).toISOString() : first.row.emittedAt,
    ...(pointEvent
      ? {}
      : nativeActivityTiming(nativeStartMs, nativeEndMs) ?? terminalTiming(started, terminal)),
    evidence: rows.length > 1 ? 'derived' : 'native',
    ...stepParent(turnId, rows),
    correlationId: activityId,
    sourceEventIds: rows.map((entry) => entry.row.eventId),
    detail: toJsonValue(detail),
  };
  return {
    item,
    firstGeneration: first.row.streamGeneration,
    firstSequence: first.row.sequence,
  };
}

function projectContent(
  turnId: string,
  contentId: string,
  kind: 'text' | 'reasoning' | 'plan',
  rows: TimedRow[],
): Projected {
  const completed = lastWith(rows, 'content.completed');
  const first = rows[0]!;
  let text = stringValue(completed?.row.data['content']);
  if (!text) {
    text = rows
      .filter(entry => entry.row.method === 'content.delta')
      .map(entry => stringValue(entry.row.data['delta']) ?? '')
      .join('');
  }
  const itemKind: TraceItemKind = kind === 'text' ? 'assistant' : kind;
  const item: TraceItem = {
    id: `content:${turnId}:${contentId}:${kind}`,
    turnId,
    kind: itemKind,
    shape: 'span',
    title: kind === 'text' ? 'Assistant' : kind === 'reasoning' ? 'Reasoning' : 'Plan',
    ...(text ? { summary: boundedString(text) } : {}),
    status: completed ? 'succeeded' : 'running',
    at: first.row.emittedAt,
    ...terminalTiming(first, completed),
    evidence: rows.length === 1 ? 'native' : 'derived',
    ...stepParent(turnId, rows),
    correlationId: contentId,
    sourceEventIds: rows.map(entry => entry.row.eventId),
    detail: { contentId, kind } as JsonValue,
  };
  return {
    item,
    firstGeneration: first.row.streamGeneration,
    firstSequence: first.row.sequence,
  };
}

function projectStep(turnId: string, stepId: string, rows: TimedRow[]): Projected {
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const running = rows.find(entry => entry.row.data['status'] === 'running');
  const terminal = last.row.data['status'] === 'completed' || last.row.data['status'] === 'failed'
    ? last
    : undefined;
  const index = typeof last.row.data['index'] === 'number' ? last.row.data['index'] : undefined;
  const item: TraceItem = {
    id: stepTraceId(turnId, stepId),
    turnId,
    kind: 'step',
    shape: 'span',
    title: index !== undefined ? `Step ${index + 1}` : 'Step',
    summary: stepId,
    status: last.row.data['status'] === 'completed'
      ? 'succeeded'
      : last.row.data['status'] === 'failed' ? 'failed' : 'running',
    at: (running ?? first).row.emittedAt,
    ...terminalTiming(running, terminal),
    evidence: rows.length > 1 ? 'derived' : 'native',
    parentId: `turn:${turnId}`,
    correlationId: stepId,
    sourceEventIds: rows.map(entry => entry.row.eventId),
    detail: toJsonValue({ stepId, ...(index !== undefined ? { index } : {}) }),
  };
  return {
    item,
    firstGeneration: first.row.streamGeneration,
    firstSequence: first.row.sequence,
  };
}

function projectRequest(
  turnId: string,
  requestId: string,
  rows: TimedRow[],
): Projected {
  const first = rows[0]!;
  const data = Object.assign({}, ...rows.map(entry => entry.row.data)) as Record<string, unknown>;
  const reason = stringValue(data['reason']);
  const model = data['model'] && typeof data['model'] === 'object' && !Array.isArray(data['model'])
    ? data['model'] as Record<string, unknown>
    : {};
  const modelTitle = stringValue(model['displayName']) ?? stringValue(model['id']);
  const item: TraceItem = {
    id: `request:${turnId}:${requestId}`,
    turnId,
    kind: 'request',
    shape: 'event',
    title: boundedString(modelTitle, TRACE_TITLE_MAX_CHARS) ?? 'Request',
    ...(reason ? { summary: reason } : {}),
    at: first.row.emittedAt,
    evidence: rows.length > 1 ? 'derived' : 'native',
    ...stepParent(turnId, rows),
    correlationId: requestId,
    sourceEventIds: rows.map(entry => entry.row.eventId),
    detail: toJsonValue(data),
  };
  return {
    item,
    firstGeneration: first.row.streamGeneration,
    firstSequence: first.row.sequence,
  };
}

function projectSingleEventItem(turnId: string, entry: TimedRow): Projected | null {
  const data = entry.row.data;
  switch (entry.row.method) {
    case 'input.recorded': {
      const inputId = stringValue(data['inputId']);
      const inputSummary = boundedString(firstInputText(data));
      const item: TraceItem = {
        id: `input:${turnId}:${inputId ?? entry.row.eventId}`,
        turnId,
        kind: 'input',
        shape: 'event',
        title: 'Input',
        ...(inputSummary ? { summary: inputSummary } : {}),
        at: entry.row.emittedAt,
        evidence: 'native',
        ...stepParent(turnId, [entry]),
        ...(inputId ? { correlationId: inputId } : {}),
        sourceEventIds: [entry.row.eventId],
        ...(inputId ? { detail: { inputId } } : {}),
      };
      return {
        item,
        firstGeneration: entry.row.streamGeneration,
        firstSequence: entry.row.sequence,
      };
    }
    case 'agent.updated': {
      const agentId = stringValue(data['agentId']);
      const title = boundedString(
        stringValue(data['description']) ?? stringValue(data['agentType']) ?? 'Agent',
        TRACE_TITLE_MAX_CHARS,
      ) ?? 'Agent';
      const detail: Record<string, unknown> = {};
      if (agentId) detail['agentId'] = agentId;
      if (data['agentType'] !== undefined) detail['agentType'] = data['agentType'];
      if (data['model'] !== undefined) detail['model'] = data['model'];
      const item: TraceItem = {
        id: `agent:${turnId}:${agentId ?? entry.row.eventId}:${entry.row.eventId}`,
        turnId,
        kind: 'agent',
        shape: 'event',
        title,
        ...(boundedString(data['output']) ? { summary: boundedString(data['output']) } : {}),
        status: mapAgentStatus(data['status']),
        at: entry.row.emittedAt,
        evidence: 'native',
        ...stepParent(turnId, [entry]),
        ...(agentId ? { correlationId: agentId } : {}),
        sourceEventIds: [entry.row.eventId],
        detail: toJsonValue(detail),
      };
      return {
        item,
        firstGeneration: entry.row.streamGeneration,
        firstSequence: entry.row.sequence,
      };
    }
    case 'notice.created': {
      const noticeId = stringValue(data['noticeId']);
      const item: TraceItem = {
        id: `notice:${turnId}:${noticeId ?? entry.row.eventId}`,
        turnId,
        kind: 'notice',
        shape: 'event',
        title: boundedString(data['title'], TRACE_TITLE_MAX_CHARS) ?? 'Notice',
        ...(boundedString(data['message']) ? { summary: boundedString(data['message']) } : {}),
        at: entry.row.emittedAt,
        evidence: 'native',
        ...stepParent(turnId, [entry]),
        ...(noticeId ? { correlationId: noticeId } : {}),
        sourceEventIds: [entry.row.eventId],
        ...(noticeId ? { detail: toJsonValue({ severity: data['severity'], code: data['code'] }) } : {}),
      };
      return {
        item,
        firstGeneration: entry.row.streamGeneration,
        firstSequence: entry.row.sequence,
      };
    }
    case 'plan.updated': {
      const planId = stringValue(data['planId']);
      const steps: unknown[] = Array.isArray(data['steps']) ? data['steps'] : [];
      // Sanitizer truncation markers are objects without text; skip them so
      // they never render as empty plan rows.
      const stepsText = steps
        .filter((step): step is Record<string, unknown> => (
          !!step && typeof step === 'object' && !Array.isArray(step)
        ))
        .filter(step => typeof step['text'] === 'string')
        .map(step => {
          const status = stringValue(step['status']) === 'completed' ? 'x' : ' ';
          return `- [${status}] ${String(step['text'] ?? '')}`;
        }).join('\n');
      const summary = stepsText || stringValue(data['title']);
      const item: TraceItem = {
        id: `plan:${turnId}:${planId ?? entry.row.eventId}:${entry.row.eventId}`,
        turnId,
        kind: 'plan',
        shape: 'event',
        title: boundedString(data['title'], TRACE_TITLE_MAX_CHARS) ?? 'Plan',
        ...(boundedString(summary) ? { summary: boundedString(summary) } : {}),
        at: entry.row.emittedAt,
        evidence: 'native',
        ...stepParent(turnId, [entry]),
        ...(planId ? { correlationId: planId } : {}),
        sourceEventIds: [entry.row.eventId],
        ...(planId ? { detail: toJsonValue({ planId, ...(steps.length > 0 ? { steps: data['steps'] } : {}) }) } : {}),
      };
      return {
        item,
        firstGeneration: entry.row.streamGeneration,
        firstSequence: entry.row.sequence,
      };
    }
    case 'usage.updated': {
      const item: TraceItem = {
        id: `usage:${turnId}:${entry.row.eventId}`,
        turnId,
        kind: 'notice',
        shape: 'event',
        title: 'Usage',
        ...(boundedJson({
          context: data['context'],
          conversation: data['conversation'],
        }) ? {
          summary: boundedJson({
            context: data['context'],
            conversation: data['conversation'],
          }),
        } : {}),
        at: entry.row.emittedAt,
        evidence: 'native',
        ...stepParent(turnId, [entry]),
        sourceEventIds: [entry.row.eventId],
        detail: toJsonValue(data),
      };
      return {
        item,
        firstGeneration: entry.row.streamGeneration,
        firstSequence: entry.row.sequence,
      };
    }
    default:
      return null;
  }
}

function stepTraceId(turnId: string, stepId: string): string {
  return `step:${turnId}:${stepId}`;
}

function stepParent(
  turnId: string,
  rows: TimedRow[],
): Pick<TraceItem, 'parentId'> {
  for (const entry of rows) {
    const stepId = stringValue(entry.row.data['stepId']);
    if (stepId) return { parentId: stepTraceId(turnId, stepId) };
  }
  return { parentId: `turn:${turnId}` };
}

function nativeActivityTimestamp(
  rows: TimedRow[],
  phase: 'started' | 'completed',
): number | null {
  for (const entry of rows) {
    const details = entry.row.data['details'];
    const timing = entry.row.data['timing'] ?? (
      details && typeof details === 'object' && !Array.isArray(details)
        ? (details as Record<string, unknown>)['timing']
        : undefined
    );
    if (!timing || typeof timing !== 'object' || Array.isArray(timing)) continue;
    const record = timing as Record<string, unknown>;
    if (record['phase'] !== phase) continue;
    const timestampMs = record['timestampMs'];
    if (typeof timestampMs === 'number' && Number.isFinite(timestampMs)) return timestampMs;
  }
  return null;
}

function nativeActivityTiming(
  startMs: number | null,
  endMs: number | null,
): Partial<TraceItem> | null {
  if (endMs === null) return null;
  return {
    endAt: new Date(endMs).toISOString(),
    ...(startMs !== null && endMs >= startMs ? { durationMs: endMs - startMs } : {}),
  };
}

/**
 * endAt is a fact whenever a terminal event exists; durationMs is only
 * computed when the start event is authoritative (a real started event, not
 * a fallback) and start/end are distinct events ordered in time. Missing or
 * approximate starts never fabricate a duration.
 */
function terminalTiming(
  start: TimedRow | undefined,
  end: TimedRow | undefined,
): Partial<TraceItem> {
  if (!end) return {};
  const result: Partial<TraceItem> = { endAt: end.row.emittedAt };
  if (
    start
    && start.row.eventId !== end.row.eventId
    && start.atMs !== null
    && end.atMs !== null
    && end.atMs >= start.atMs
  ) {
    result['durationMs'] = end.atMs - start.atMs;
  }
  return result;
}

function lastWith(group: TimedRow[], method: string): TimedRow | undefined {
  for (let index = group.length - 1; index >= 0; index--) {
    if (group[index]!.row.method === method) return group[index]!;
  }
  return undefined;
}

function isToolMethod(method: string): boolean {
  return method === 'tool.started' || method === 'tool.updated' || method === 'tool.completed';
}

function mapStopReason(reason: unknown): TraceStatus {
  if (reason === 'completed') return 'succeeded';
  if (reason === 'interrupted' || reason === 'cancelled') return 'interrupted';
  return 'failed';
}

function mapToolStatus(status: unknown): TraceStatus {
  return status === 'succeeded'
    ? 'succeeded'
    : status === 'failed'
      ? 'failed'
      : status === 'interrupted' || status === 'cancelled'
        ? 'interrupted'
        : 'running';
}

function mapAgentStatus(status: unknown): TraceStatus | undefined {
  if (status === 'running') return 'running';
  if (status === 'completed') return 'succeeded';
  if (status === 'failed') return 'failed';
  if (status === 'interrupted') return 'interrupted';
  return undefined;
}

function parseIso(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function boundedString(value: unknown, max = TRACE_SUMMARY_MAX_CHARS): string | undefined {
  const text = stringValue(value);
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function boundedJson(value: unknown, max = TRACE_SUMMARY_MAX_CHARS): string | undefined {
  if (value === undefined || value === null) return undefined;
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (!encoded) return undefined;
  return encoded.length > max ? `${encoded.slice(0, max)}…` : encoded;
}

/** JSON-safe boundary cast: parsed evidence payloads are already JSON; this
 *  normalizes the TS types without ever using any. */
function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(record).map(([key, item]) => [key, toJsonValue(item)]),
    );
  }
  return null;
}

function firstInputText(data: Record<string, unknown>): string | undefined {
  const input = data['input'];
  if (!Array.isArray(input)) return undefined;
  for (const item of input) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      if (record['type'] === 'text' && typeof record['text'] === 'string' && record['text']) {
        return record['text'];
      }
    }
  }
  return undefined;
}
