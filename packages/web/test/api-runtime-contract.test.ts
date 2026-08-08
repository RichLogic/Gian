import { RuntimeContractError } from '@gian/shared';
import { describe, expect, it } from 'vitest';
import { loadArchivedSessions, loadSessions } from '../src/api.js';
import { sessionContractFixture } from './fixtures/ws-contract.js';
import { mockFetch } from './setup.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('CONTRACT-005: Session REST runtime boundary', () => {
  it('accepts the complete canonical Session list from /api/sessions', async () => {
    const fixture = sessionContractFixture();
    mockFetch(async () => json([fixture]));

    await expect(loadSessions()).resolves.toEqual([fixture]);
  });

  it('rejects malformed active Session payloads instead of casting them into UI state', async () => {
    mockFetch(async () => json([sessionContractFixture({ status: 'done' }), { id: 'partial' }]));

    await expect(loadSessions()).rejects.toBeInstanceOf(RuntimeContractError);
  });

  it('does not treat a failed canonical Session refresh as an empty list', async () => {
    mockFetch(async () => json([], 500));

    await expect(loadSessions()).rejects.toThrow('Session list load failed (500)');
  });

  it('rejects malformed archived Session payloads at the same boundary', async () => {
    const malformed = { ...sessionContractFixture({ archived: 1 }), unread: 2 };
    mockFetch(async () => json([malformed]));

    await expect(loadArchivedSessions()).rejects.toBeInstanceOf(RuntimeContractError);
  });

  it.each([401, 500])('surfaces archived Session HTTP %s as a stable load error', async status => {
    mockFetch(async () => json({ error: 'not a session list' }, status));

    await expect(loadArchivedSessions()).rejects.toThrow(
      `Archived sessions load failed (${status})`,
    );
  });
});
