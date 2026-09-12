import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ScheduleErrorCode, ScheduleStatus } from '@gian/shared';
import { REST_IDEMPOTENCY_KEY_BYTES } from '@gian/shared';
import type { ScheduleCommandLedger } from '../../schedule/command-ledger.js';
import { scheduleCommandHash } from '../../schedule/command-ledger.js';
import { ScheduleError, scheduleHttpStatus } from '../../schedule/errors.js';
import type { ScheduleService } from '../../schedule/service.js';

/**
 * Schedules REST surface (contract M/N). The Desktop may list, inspect, and
 * manage any Schedule globally, but creation is Tool-only and always passes
 * through a Host-enforced user confirmation. Reads are plain GETs; every
 * write requires an `Idempotency-Key` (1..256 bytes) and goes through the
 * command receipt ledger before the shared ScheduleService. Errors always use
 * the `{ error: { code, message, retryable, details? } }` envelope.
 */

const RETRYABLE_CODES = new Set<ScheduleErrorCode>([
  'INTERNAL_ERROR',
]);

interface ErrorEnvelope {
  error: {
    code: ScheduleErrorCode;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}

function errorEnvelope(error: unknown): { status: ContentfulStatusCode; body: ErrorEnvelope } {
  if (error instanceof ScheduleError) {
    return {
      status: error.httpStatus as ContentfulStatusCode,
      body: {
        error: {
          code: error.code,
          message: error.message,
          retryable: RETRYABLE_CODES.has(error.code),
          ...(error.details ? { details: error.details } : {}),
        },
      },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'schedule operation failed',
        retryable: true,
      },
    },
  };
}

function missingKeyResponse(): { json: ErrorEnvelope; status: ContentfulStatusCode } {
  return {
    json: {
      error: { code: 'INVALID_ARGUMENT', message: 'Idempotency-Key header is required', retryable: false },
    },
    status: 400,
  };
}

function idempotencyKey(header: string | undefined): string | null {
  if (header === undefined || header.length === 0 || header.length > REST_IDEMPOTENCY_KEY_BYTES) {
    return null;
  }
  return header;
}

interface ScheduleRouteDependencies {
  service: ScheduleService;
  ledger: ScheduleCommandLedger;
}

const WEB_ACTOR_KEY = 'web:user';

export function registerScheduleRoutes(app: Hono, deps: ScheduleRouteDependencies): void {
  const { service, ledger } = deps;

  // ── reads ──────────────────────────────────────────────────────────────────

  app.get('/api/schedules', c => {
    try {
      const status = c.req.query('status');
      const statuses = status !== undefined && status.length > 0
        ? status.split(',').map(value => value.trim()).filter(Boolean) as ScheduleStatus[]
        : undefined;
      const result = service.listSchedules({
        statuses,
        controlSessionId: c.req.query('control_session_id') || undefined,
        limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
        cursor: c.req.query('cursor'),
      });
      return c.json(result);
    } catch (error) {
      const { status, body } = errorEnvelope(error);
      return c.json(body, status);
    }
  });

  app.get('/api/schedules/:id', c => {
    try {
      return c.json(service.getSchedule(c.req.param('id')));
    } catch (error) {
      const { status, body } = errorEnvelope(error);
      return c.json(body, status);
    }
  });

  app.get('/api/schedules/:id/runs', c => {
    try {
      const result = service.listRuns(c.req.param('id'), {
        limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
        cursor: c.req.query('cursor'),
      });
      return c.json(result);
    } catch (error) {
      const { status, body } = errorEnvelope(error);
      return c.json(body, status);
    }
  });

  app.get('/api/schedule-runs/:id', c => {
    try {
      return c.json(service.getRun(c.req.param('id')));
    } catch (error) {
      const { status, body } = errorEnvelope(error);
      return c.json(body, status);
    }
  });

  // ── writes (Idempotency-Key enforced; no REST create — contract M) ─────────

  app.patch('/api/schedules/:id', async c => {
    const key = idempotencyKey(c.req.header('Idempotency-Key'));
    if (!key) {
      const { json, status } = missingKeyResponse();
      return c.json(json, status);
    }
    const scheduleId = c.req.param('id');
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({
        error: { code: 'INVALID_ARGUMENT', message: 'request body must be JSON', retryable: false },
      }, 400);
    }
    const inputHash = scheduleCommandHash('PATCH', `/api/schedules/${scheduleId}`, body);
    let claim;
    try {
      claim = ledger.claim({
        actorKey: WEB_ACTOR_KEY,
        idempotencyKey: key,
        method: 'PATCH /api/schedules/:id',
        inputHash,
        preallocateDomainId: false,
      });
    } catch (error) {
      const { status, body: errorBody } = errorEnvelope(error);
      return c.json(errorBody, status);
    }
    if (claim.kind === 'busy') {
      return c.json({
        error: { code: 'IDEMPOTENCY_CONFLICT', message: 'an identical command is still in progress', retryable: false },
      }, 409, { 'Retry-After': '1' });
    }
    if (claim.kind === 'replay') {
      return replayResponse(c, claim.status, claim.response, claim.error);
    }
    try {
      const expectedRevision = typeof body.expected_revision === 'number' ? body.expected_revision : undefined;
      if (expectedRevision === undefined) {
        throw new ScheduleError('INVALID_ARGUMENT', 'expected_revision is required');
      }
      const schedule = await service.updateSchedule({
        schedule_id: scheduleId,
        expected_revision: expectedRevision,
        name: body.name as string | undefined,
        prompt: body.prompt as string | undefined,
        trigger: body.trigger,
        timezone: body.timezone as string | undefined,
        misfire_policy: body.misfire_policy as never,
      });
      ledger.succeed({ actorKey: WEB_ACTOR_KEY, idempotencyKey: key, response: schedule });
      return c.json(schedule);
    } catch (error) {
      const { status, body: errorBody } = errorEnvelope(error);
      ledger.fail({ actorKey: WEB_ACTOR_KEY, idempotencyKey: key, error: errorBody });
      return c.json(errorBody, status);
    }
  });

  for (const action of ['pause', 'resume', 'run', 'archive'] as const) {
    app.post(`/api/schedules/:id/${action}`, async c => {
      const key = idempotencyKey(c.req.header('Idempotency-Key'));
      if (!key) {
        const { json, status } = missingKeyResponse();
        return c.json(json, status);
      }
      const scheduleId = c.req.param('id');
      let body: Record<string, unknown> = {};
      const text = await c.req.text();
      if (text.length > 0) {
        try {
          body = JSON.parse(text) as Record<string, unknown>;
        } catch {
          return c.json({
            error: { code: 'INVALID_ARGUMENT', message: 'request body must be JSON', retryable: false },
          }, 400);
        }
      }
      const inputHash = scheduleCommandHash('POST', `/api/schedules/${scheduleId}/${action}`, body);
      let claim;
      try {
        claim = ledger.claim({
          actorKey: WEB_ACTOR_KEY,
          idempotencyKey: key,
          method: `POST /api/schedules/:id/${action}`,
          inputHash,
          preallocateDomainId: action === 'run',
        });
      } catch (error) {
        const { status, body: errorBody } = errorEnvelope(error);
        return c.json(errorBody, status);
      }
      if (claim.kind === 'busy') {
        return c.json({
          error: { code: 'IDEMPOTENCY_CONFLICT', message: 'an identical command is still in progress', retryable: false },
        }, 409, { 'Retry-After': '1' });
      }
      if (claim.kind === 'replay') {
        return replayResponse(c, claim.status, claim.response, claim.error);
      }
      const expectedRevision = typeof body.expected_revision === 'number' ? body.expected_revision : undefined;
      try {
        let response: unknown;
        if (action === 'pause') {
          response = service.pauseSchedule(scheduleId, { expectedRevision });
        } else if (action === 'resume') {
          response = await service.resumeSchedule(scheduleId, { expectedRevision });
        } else if (action === 'archive') {
          response = service.archiveSchedule(scheduleId, { expectedRevision });
        } else {
          // runNow converges on the canonical Run for a recovered receipt.
          response = service.runNow({ schedule_id: scheduleId, domainId: claim.domainId });
        }
        ledger.succeed({ actorKey: WEB_ACTOR_KEY, idempotencyKey: key, response });
        return c.json(response);
      } catch (error) {
        const { status, body: errorBody } = errorEnvelope(error);
        ledger.fail({ actorKey: WEB_ACTOR_KEY, idempotencyKey: key, error: errorBody });
        return c.json(errorBody, status);
      }
    });
  }

  // ── create confirmations (contract L) ─────────────────────────────────────

  app.get('/api/schedule-confirmations', c => {
    try {
      const status = c.req.query('status');
      return c.json({
        confirmations: service.listConfirmations({
          controlSessionId: c.req.query('control_session_id') || undefined,
          status: status === 'pending' || status === 'approved' || status === 'rejected' || status === 'expired'
            ? status
            : undefined,
          limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
        }),
      });
    } catch (error) {
      const { status, body } = errorEnvelope(error);
      return c.json(body, status);
    }
  });

  app.get('/api/schedule-confirmations/:id', c => {
    try {
      return c.json(service.getConfirmation(c.req.param('id')));
    } catch (error) {
      const { status, body } = errorEnvelope(error);
      return c.json(body, status);
    }
  });

  app.post('/api/schedule-confirmations/:id/resolve', async c => {
    try {
      const body = await c.req.json<Record<string, unknown>>();
      if (body.decision !== 'approve' && body.decision !== 'reject') {
        throw new ScheduleError('INVALID_ARGUMENT', "decision must be 'approve' or 'reject'");
      }
      const confirmation = service.resolveConfirmation({
        confirmationId: c.req.param('id'),
        decision: body.decision,
      });
      return c.json(confirmation);
    } catch (error) {
      const { status, body } = errorEnvelope(error);
      return c.json(body, status);
    }
  });
}

/** Terminal receipts replay byte-for-byte: success payloads as-is, failures
 *  re-wrap the stored envelope with its original HTTP status. */
function replayResponse(
  c: Context,
  status: 'succeeded' | 'failed',
  response: unknown,
  error: unknown,
): Response {
  if (status === 'succeeded') return c.json(response);
  const envelope = (error ?? {
    error: { code: 'INTERNAL_ERROR', message: 'failed command replay', retryable: false },
  }) as ErrorEnvelope;
  return c.json(envelope, scheduleHttpStatus(envelope.error.code) as ContentfulStatusCode);
}
