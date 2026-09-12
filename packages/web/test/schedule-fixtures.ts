/**
 * Shared fixtures + fetch routing for the Timer/Schedule web tests
 * (Issue #51). Builders produce contract-complete objects (shared/schedule.ts
 * key sets are exact); the fetch router records every call so tests can
 * assert URLs, methods, bodies, and the Idempotency-Key header.
 */
import type {
  Schedule,
  ScheduleConfirmation,
  ScheduleRun,
  ScheduleStatus,
} from '@gian/shared';

export function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'sch-1',
    name: 'Nightly digest',
    status: 'active',
    status_reason: null,
    control_session_id: 'session-1',
    control_session_title: 'Release watch',
    agent_id: 'agent-1',
    agent_name: 'Claude',
    workspace_id: 'ws-1',
    workspace_name: 'Gian',
    prompt: 'Summarize the overnight CI results.',
    trigger: { kind: 'cron', expression: '0 9 * * *' },
    timezone: 'Asia/Shanghai',
    overlap_policy: 'skip',
    misfire_policy: 'skip',
    next_run_at: '2026-09-04T01:00:00.000Z',
    last_run_at: null,
    creator_kind: 'internal_session',
    creator_actor_id: 'internal:session-1',
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    archived_at: null,
    revision: 3,
    ...overrides,
  };
}

export function makeRun(overrides: Partial<ScheduleRun> = {}): ScheduleRun {
  return {
    id: 'run-1',
    schedule_id: 'sch-1',
    trigger_kind: 'scheduled',
    scheduled_for: '2026-09-03T01:00:00.000Z',
    status: 'succeeded',
    execution_mode: 'bound_session',
    target_session_id: 'session-1',
    fork_anchor: null,
    turn_id: 'turn-1',
    missed_count: 0,
    missed_from: null,
    missed_until: null,
    resolved_config: { model: 'sonnet' },
    summary: 'Posted the digest.',
    error_code: null,
    error_message: null,
    created_at: '2026-09-03T01:00:00.000Z',
    started_at: '2026-09-03T01:00:01.000Z',
    finished_at: '2026-09-03T01:00:09.000Z',
    updated_at: '2026-09-03T01:00:09.000Z',
    revision: 2,
    ...overrides,
  };
}

export function makeConfirmation(overrides: Partial<ScheduleConfirmation> = {}): ScheduleConfirmation {
  return {
    id: 'conf-1',
    status: 'pending',
    payload: {
      name: 'Nightly digest',
      prompt: 'Summarize the overnight CI results and post the digest.',
      prompt_summary: 'Summarize the overnight CI results…',
      trigger: { kind: 'cron', expression: '0 9 * * *' },
      trigger_summary: 'Cron · 0 9 * * *',
      timezone: 'Asia/Shanghai',
      misfire_policy: 'skip',
      next_occurrences: [
        '2026-09-04T01:00:00.000Z',
        '2026-09-05T01:00:00.000Z',
        '2026-09-06T01:00:00.000Z',
      ],
      control_session: {
        id: 'session-1',
        title: 'Release watch',
        agent_name: 'Claude',
        workspace_name: 'Gian',
      },
      risk_note: 'Runs inside the bound conversation with its permissions and quota.',
    },
    control_session_id: 'session-1',
    schedule_id: null,
    expires_at: '2026-09-03T04:30:00.000Z',
    created_at: '2026-09-03T04:00:00.000Z',
    updated_at: '2026-09-03T04:00:00.000Z',
    resolved_at: null,
    ...overrides,
  };
}

export interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

interface Route {
  match: (url: string, method: string) => boolean;
  respond: (call: RecordedCall) => Response | Promise<Response>;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Schedule error envelope matching the Host's closed shape. */
export function scheduleErrorResponse(code: string, status: number, message = code): Response {
  return jsonResponse({ error: { code, message, retryable: false } }, status);
}

export function scheduleListResponse(
  schedules: Schedule[],
  nextCursor: string | null = null,
  statuses: ScheduleStatus[] = ['active', 'paused', 'completed'],
): Response {
  void statuses;
  return jsonResponse({ schedules, next_cursor: nextCursor });
}

export function createFetchRouter(routes: Route[]) {
  const calls: RecordedCall[] = [];
  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(init?.headers ?? {})) {
      headers[key.toLowerCase()] = String(value);
    }
    let body: unknown = null;
    if (typeof init?.body === 'string' && init.body.length > 0) {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    const call: RecordedCall = { url, method, body, headers };
    calls.push(call);
    for (const route of routes) {
      if (route.match(url, method)) return route.respond(call);
    }
    return jsonResponse({ error: { code: 'INTERNAL_ERROR', message: `unrouted ${method} ${url}`, retryable: false } }, 404);
  };
  return { calls, handler };
}
