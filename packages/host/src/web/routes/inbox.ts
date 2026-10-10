import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { InboxListFilter } from '../../inbox/repository.js';
import { InboxError, type InboxService } from '../../inbox/service.js';

const SCOPE_QUERIES = ['account_id', 'device_id', 'user_id'] as const;

/**
 * User Inbox routes. Producer upsert, resolve, and reconcile stay on
 * InboxService and are not mounted here. Approve and answer stay on the
 * domain services that already own those commands.
 */
export function registerInboxRoutes(app: Hono, service: InboxService): void {
  app.get('/api/inbox/count', c => {
    try {
      rejectScope(c);
      return c.json(service.count());
    } catch (error) {
      return fail(c, error);
    }
  });

  app.get('/api/inbox', c => {
    try {
      rejectScope(c);
      return c.json(service.list({
        status: parseStatus(c.req.query('status')),
        limit: parseLimit(c.req.query('limit')),
        cursor: parseCursor(c.req.query('cursor')),
      }));
    } catch (error) {
      return fail(c, error);
    }
  });

  app.get('/api/inbox/:id', c => {
    try {
      rejectScope(c);
      return c.json(service.get(c.req.param('id')));
    } catch (error) {
      return fail(c, error);
    }
  });

  app.post('/api/inbox/:id/read', async c => {
    try {
      rejectScope(c);
      const body = await objectBody(c, ['generation']);
      return c.json(service.markRead(c.req.param('id'), generationOf(body)));
    } catch (error) {
      return fail(c, error);
    }
  });

  app.post('/api/inbox/:id/unread', async c => {
    try {
      rejectScope(c);
      const body = await objectBody(c, ['generation']);
      return c.json(service.markUnread(c.req.param('id'), generationOf(body)));
    } catch (error) {
      return fail(c, error);
    }
  });

  app.post('/api/inbox/:id/skip-version', async c => {
    try {
      rejectScope(c);
      const body = await objectBody(c, ['generation', 'version']);
      const version = body.version;
      if (typeof version !== 'string') {
        throw new InboxError('INVALID_ARGUMENT', 'version must be a string');
      }
      return c.json(service.skipVersion(c.req.param('id'), generationOf(body), version));
    } catch (error) {
      return fail(c, error);
    }
  });
}

function rejectScope(c: Context): void {
  for (const key of SCOPE_QUERIES) {
    if (c.req.query(key) !== undefined) {
      throw new InboxError('INVALID_ARGUMENT', `${key} is not a valid inbox filter`);
    }
  }
}

function parseStatus(raw: string | undefined): InboxListFilter {
  if (raw === undefined) return 'pending';
  if (raw === 'pending' || raw === 'closed' || raw === 'all') return raw;
  throw new InboxError('INVALID_ARGUMENT', 'status is invalid');
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return 50;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new InboxError('INVALID_ARGUMENT', 'limit must be an integer from 1 to 100');
  }
  const limit = Number(raw);
  if (limit > 100) throw new InboxError('INVALID_ARGUMENT', 'limit must be an integer from 1 to 100');
  return limit;
}

function parseCursor(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  if (raw.length === 0) throw new InboxError('INVALID_ARGUMENT', 'cursor is invalid');
  return raw;
}

async function objectBody(c: Context, allowed: readonly string[]): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    throw new InboxError('INVALID_ARGUMENT', 'body must be a JSON object');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InboxError('INVALID_ARGUMENT', 'body must be a JSON object');
  }
  const body = parsed as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new InboxError('INVALID_ARGUMENT', `unexpected field ${key}`);
  }
  return body;
}

function generationOf(body: Record<string, unknown>): number {
  const value = body.generation;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new InboxError('INVALID_ARGUMENT', 'generation must be a positive integer');
  }
  return value;
}

function fail(c: Context, error: unknown): Response {
  if (error instanceof InboxError) {
    const status: ContentfulStatusCode = error.code === 'NOT_FOUND'
      ? 404
      : error.code === 'STALE' || error.code === 'FORBIDDEN_ACTION'
        ? 409
        : 400;
    const name = error.code === 'NOT_FOUND'
      ? 'not_found'
      : error.code === 'STALE'
        ? 'stale'
        : error.code === 'FORBIDDEN_ACTION'
          ? 'forbidden_action'
          : 'invalid_argument';
    return c.json({ error: name, message: error.message }, status);
  }
  throw error;
}
