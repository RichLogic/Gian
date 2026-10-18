/**
 * Schedule-confirmation navigation decision (0.6.7): the arbitration the
 * desktop/Inbox deep link runs — post-await re-verification, failed-hydrate
 * retry (never a fake settled ack), and exact-confirmation focus. Also the
 * hydrate freshness contract: a mid-flight WS/REST upsert discards the
 * stale GET response (terminal facts are one-way, newer pendings survive).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetScheduleConfirmations,
  getScheduleConfirmationsSnapshot,
  hydrateScheduleConfirmations,
  upsertScheduleConfirmation,
} from '../src/controllers/schedule-confirmations.js';
import { resolveScheduleConfirmationNavigation } from '../src/controllers/schedule-confirmation-navigation.js';
import { mockFetch } from './setup.js';
import { makeConfirmation } from './schedule-fixtures.js';

const TARGET = {
  confirmationId: 'conf-B',
  controlSessionId: 'session-1',
  inboxRef: { id: 'inbox-7', generation: 4 },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe('schedule confirmation navigation decision', () => {
  it('a newer user choice after the hydrate supersedes the delivery — no focus, no session open', async () => {
    const gate = deferred<boolean>();
    const focus = vi.fn();
    const openControlSession = vi.fn();
    const outcomePromise = resolveScheduleConfirmationNavigation(TARGET, {
      hydrate: () => gate.promise,
      findConfirmation: () => makeConfirmation({ id: 'conf-B' }),
      focus,
      openControlSession,
      unavailable: vi.fn(),
      isCurrent: () => false, // the user navigated elsewhere during the hydrate
    });
    gate.resolve(true);
    expect(await outcomePromise).toBe('superseded');
    expect(focus).not.toHaveBeenCalled();
    expect(openControlSession).not.toHaveBeenCalled();
  });

  it('a failed hydrate reports pending (retry), never a fake settled ack', async () => {
    const unavailable = vi.fn();
    const outcome = await resolveScheduleConfirmationNavigation(TARGET, {
      hydrate: async () => false,
      findConfirmation: () => makeConfirmation({ id: 'conf-B' }),
      focus: vi.fn(),
      openControlSession: vi.fn(),
      unavailable,
      isCurrent: () => true,
    });
    expect(outcome).toBe('pending');
    expect(unavailable).not.toHaveBeenCalled();
  });

  it('a verified pending confirmation focuses exactly that id with the observed ref', async () => {
    const focus = vi.fn();
    const openControlSession = vi.fn();
    const outcome = await resolveScheduleConfirmationNavigation(TARGET, {
      hydrate: async () => true,
      findConfirmation: () => makeConfirmation({ id: 'conf-B' }),
      focus,
      openControlSession,
      unavailable: vi.fn(),
      isCurrent: () => true,
    });
    expect(outcome).toBe('settled');
    expect(focus).toHaveBeenCalledWith('conf-B', { id: 'inbox-7', generation: 4 });
    expect(openControlSession).toHaveBeenCalledWith('session-1');
  });

  it('an expired/unknown confirmation is an explicit unavailable, not a new item', async () => {
    const unavailable = vi.fn();
    const outcome = await resolveScheduleConfirmationNavigation(TARGET, {
      hydrate: async () => true,
      findConfirmation: () => makeConfirmation({ id: 'conf-B', status: 'rejected' }),
      focus: vi.fn(),
      openControlSession: vi.fn(),
      unavailable,
      isCurrent: () => true,
    });
    expect(outcome).toBe('settled');
    expect(unavailable).toHaveBeenCalledTimes(1);
  });
});

describe('hydrate freshness', () => {
  beforeEach(() => __resetScheduleConfirmations());
  afterEach(() => __resetScheduleConfirmations());

  function pendingGet(pending: unknown[]) {
    return Response.json({ confirmations: pending });
  }

  it('a WS terminal mid-flight discards the stale pending response (terminal is one-way)', async () => {
    const gate = deferred<Response>();
    let reads = 0;
    mockFetch(async input => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/api/schedule-confirmations')) {
        reads += 1;
        return reads === 1 ? gate.promise : pendingGet([]);
      }
      return Response.json({ error: 'not_found' }, { status: 404 });
    });
    const hydratePromise = hydrateScheduleConfirmations();
    // The confirmation resolves elsewhere while the GET is in flight.
    upsertScheduleConfirmation(makeConfirmation({ id: 'conf-1', status: 'approved' }));
    gate.resolve(pendingGet([makeConfirmation({ id: 'conf-1', status: 'pending' })]));
    expect(await hydratePromise).toBe(true);
    expect(reads).toBe(2);
    expect(getScheduleConfirmationsSnapshot().hydrated).toBe(true);
    // The stale response was discarded and re-pulled; terminal stands.
    expect(
      getScheduleConfirmationsSnapshot().confirmations.find(entry => entry.id === 'conf-1')?.status,
    ).toBe('approved');
  });

  it('a failed re-pull reports false without reopening the mid-flight terminal', async () => {
    const gate = deferred<Response>();
    let reads = 0;
    mockFetch(async () => {
      reads += 1;
      return reads === 1 ? gate.promise : Response.json({ error: 'offline' }, { status: 500 });
    });
    const pending = hydrateScheduleConfirmations();
    upsertScheduleConfirmation(makeConfirmation({ id: 'conf-1', status: 'rejected' }));
    gate.resolve(pendingGet([makeConfirmation({ id: 'conf-1', status: 'pending' })]));
    expect(await pending).toBe(false);
    expect(reads).toBe(2);
    expect(getScheduleConfirmationsSnapshot().confirmations).toEqual([
      makeConfirmation({ id: 'conf-1', status: 'rejected' }),
    ]);
  });

  it('a NEW pending arriving via WS mid-flight is not dropped by the older response', async () => {
    const gate = deferred<Response>();
    let calls = 0;
    mockFetch(async input => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/api/schedule-confirmations')) {
        calls += 1;
        return calls === 1 ? gate.promise : pendingGet([makeConfirmation({ id: 'conf-2' })]);
      }
      return Response.json({ error: 'not_found' }, { status: 404 });
    });
    const hydratePromise = hydrateScheduleConfirmations();
    upsertScheduleConfirmation(makeConfirmation({ id: 'conf-2' }));
    gate.resolve(pendingGet([]));
    expect(await hydratePromise).toBe(true);
    // The re-pull kept the WS-pushed pending record.
    expect(
      getScheduleConfirmationsSnapshot().confirmations.some(entry => entry.id === 'conf-2'),
    ).toBe(true);
  });

  it('a transport failure reports false and keeps the last known state', async () => {
    mockFetch(async () => Response.json({ error: 'boom' }, { status: 500 }));
    expect(await hydrateScheduleConfirmations()).toBe(false);
    expect(getScheduleConfirmationsSnapshot().hydrated).toBe(true);
    expect(getScheduleConfirmationsSnapshot().confirmations).toEqual([]);
  });

  it('upsert itself is terminal-one-way: an older pending frame never reopens a terminal record', () => {
    upsertScheduleConfirmation(makeConfirmation({ id: 'conf-1', status: 'approved' }));
    upsertScheduleConfirmation(makeConfirmation({ id: 'conf-1', status: 'pending' }));
    expect(
      getScheduleConfirmationsSnapshot().confirmations.find(entry => entry.id === 'conf-1')?.status,
    ).toBe('approved');
  });

  it('continuous WS movement exhausts the bounded round loop and reports false with state kept', async () => {
    let reads = 0;
    mockFetch(async input => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/api/schedule-confirmations')) {
        reads += 1;
        // Every read sees a NEWER WS fact land before it resolves.
        upsertScheduleConfirmation(makeConfirmation({ id: `conf-${reads}` }));
        return Response.json({ confirmations: [] });
      }
      return Response.json({ error: 'not_found' }, { status: 404 });
    });
    expect(await hydrateScheduleConfirmations()).toBe(false);
    expect(reads).toBe(2);
    // The movement was preserved even though the reads never stabilized.
    expect(getScheduleConfirmationsSnapshot().confirmations.length).toBe(2);
  });

  it('concurrent hydrates share one flight, and a later hydrate gets a fresh one', async () => {
    const gate = deferred<Response>();
    let reads = 0;
    mockFetch(async input => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/api/schedule-confirmations')) {
        reads += 1;
        return reads === 1 ? gate.promise : Response.json({ confirmations: [makeConfirmation({ id: 'conf-2' })] });
      }
      return Response.json({ error: 'not_found' }, { status: 404 });
    });
    const first = hydrateScheduleConfirmations();
    const second = hydrateScheduleConfirmations();
    gate.resolve(Response.json({ confirmations: [makeConfirmation({ id: 'conf-1' })] }));
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(reads).toBe(1);
    expect(await hydrateScheduleConfirmations()).toBe(true);
    expect(reads).toBe(2);
  });
});
