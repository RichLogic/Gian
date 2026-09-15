/**
 * Timer surface controllers (Issue #51 / ADR-0053): list + detail state for
 * conversation-bound Schedules. All data comes from the schedules REST API;
 * freshness comes from the coarse `schedule:changed` WS signal (and a full
 * resync on reconnect / window focus) via presentation/schedule-sync.ts.
 *
 * Race discipline: every fetch captures a generation; a response from an
 * older generation is dropped so a slow earlier request can never overwrite
 * a newer result (contract N invalidation can arrive mid-flight).
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Schedule, ScheduleRun, ScheduleStatus } from '@gian/shared';
import { loadSchedule, loadScheduleRuns, loadSchedules } from '../api.js';
import { onScheduleChanged, onScheduleResync } from '../presentation/schedule-sync.js';

const PAGE_SIZE = 50;

export interface ScheduleListState {
  schedules: Schedule[];
  /** First-page load in flight (no data shown yet or refreshing). */
  loading: boolean;
  error: string | null;
  nextCursor: string | null;
  loadingMore: boolean;
}

export function useScheduleList(statuses: ScheduleStatus[]) {
  const [state, setState] = useState<ScheduleListState>({
    schedules: [],
    loading: true,
    error: null,
    nextCursor: null,
    loadingMore: false,
  });
  const generationRef = useRef(0);
  const statusesKey = statuses.join(',');
  const statusesRef = useRef(statuses);
  statusesRef.current = statuses;

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    setState(previous => ({ ...previous, loading: true, error: null }));
    try {
      const page = await loadSchedules({ statuses: statusesRef.current, limit: PAGE_SIZE });
      if (generation !== generationRef.current) return;
      setState({
        schedules: page.schedules,
        loading: false,
        error: null,
        nextCursor: page.next_cursor,
        loadingMore: false,
      });
    } catch (error) {
      if (generation !== generationRef.current) return;
      setState(previous => ({
        ...previous,
        loading: false,
        loadingMore: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, []);

  const loadMore = useCallback(async () => {
    const cursor = state.nextCursor;
    if (!cursor || state.loadingMore || state.loading) return;
    const generation = generationRef.current;
    setState(previous => ({ ...previous, loadingMore: true }));
    try {
      const page = await loadSchedules({ statuses: statusesRef.current, limit: PAGE_SIZE, cursor });
      if (generation !== generationRef.current) return;
      setState(previous => ({
        ...previous,
        schedules: [
          ...previous.schedules,
          ...page.schedules.filter(entry =>
            !previous.schedules.some(existing => existing.id === entry.id)),
        ],
        nextCursor: page.next_cursor,
        loadingMore: false,
      }));
    } catch (error) {
      if (generation !== generationRef.current) return;
      setState(previous => ({
        ...previous,
        loadingMore: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [state.nextCursor, state.loadingMore, state.loading]);

  // Initial load + filter change.
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusesKey, refresh]);

  // Live invalidation + reconnect/focus resync.
  useEffect(() => onScheduleChanged(() => { void refresh(); }), [refresh]);
  useEffect(() => onScheduleResync(() => { void refresh(); }), [refresh]);
  useEffect(() => {
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);
  // Invalidate in-flight requests on unmount so their responses cannot
  // setState a dead tree.
  useEffect(() => () => { generationRef.current += 1; }, []);

  return { ...state, refresh, loadMore };
}

export interface ScheduleRunsState {
  runs: ScheduleRun[];
  loading: boolean;
  error: string | null;
  nextCursor: string | null;
  loadingMore: boolean;
}

export function useScheduleDetail(scheduleId: string | null) {
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<ScheduleRunsState>({
    runs: [],
    loading: true,
    error: null,
    nextCursor: null,
    loadingMore: false,
  });
  const generationRef = useRef(0);
  const runsGenerationRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!scheduleId) return;
    const generation = ++generationRef.current;
    setLoading(true);
    try {
      const fresh = await loadSchedule(scheduleId);
      if (generation !== generationRef.current) return;
      setSchedule(fresh);
      setError(null);
      setLoading(false);
    } catch (thrown) {
      if (generation !== generationRef.current) return;
      setError(thrown instanceof Error ? thrown.message : String(thrown));
      setLoading(false);
    }
  }, [scheduleId]);

  const refreshRuns = useCallback(async () => {
    if (!scheduleId) return;
    const generation = ++runsGenerationRef.current;
    setRuns(previous => ({ ...previous, loading: true, error: null }));
    try {
      const page = await loadScheduleRuns(scheduleId, { limit: PAGE_SIZE });
      if (generation !== runsGenerationRef.current) return;
      setRuns({
        runs: page.runs,
        loading: false,
        error: null,
        nextCursor: page.next_cursor,
        loadingMore: false,
      });
    } catch (thrown) {
      if (generation !== runsGenerationRef.current) return;
      setRuns(previous => ({
        ...previous,
        loading: false,
        loadingMore: false,
        error: thrown instanceof Error ? thrown.message : String(thrown),
      }));
    }
  }, [scheduleId]);

  const loadMoreRuns = useCallback(async () => {
    if (!scheduleId) return;
    const cursor = runs.nextCursor;
    if (!cursor || runs.loadingMore || runs.loading) return;
    const generation = runsGenerationRef.current;
    setRuns(previous => ({ ...previous, loadingMore: true }));
    try {
      const page = await loadScheduleRuns(scheduleId, { limit: PAGE_SIZE, cursor });
      if (generation !== runsGenerationRef.current) return;
      setRuns(previous => ({
        ...previous,
        runs: [
          ...previous.runs,
          ...page.runs.filter(entry => !previous.runs.some(existing => existing.id === entry.id)),
        ],
        nextCursor: page.next_cursor,
        loadingMore: false,
      }));
    } catch (thrown) {
      if (generation !== runsGenerationRef.current) return;
      setRuns(previous => ({
        ...previous,
        loadingMore: false,
        error: thrown instanceof Error ? thrown.message : String(thrown),
      }));
    }
  }, [scheduleId, runs.nextCursor, runs.loadingMore, runs.loading]);

  // Load both lanes when the selected schedule changes.
  useEffect(() => {
    setSchedule(null);
    setError(null);
    setLoading(scheduleId !== null);
    setRuns({ runs: [], loading: scheduleId !== null, error: null, nextCursor: null, loadingMore: false });
    void refresh();
    void refreshRuns();
  }, [scheduleId, refresh, refreshRuns]);

  // schedule:changed → refresh both lanes: run signals also move the
  // Schedule's last_run_at / next_run_at, and the payloads are identities
  // only, so re-pulling both keeps the detail canonical.
  useEffect(() => onScheduleChanged(message => {
    if (!scheduleId || message.schedule_id !== scheduleId) return;
    void refresh();
    void refreshRuns();
  }), [scheduleId, refresh, refreshRuns]);
  useEffect(() => onScheduleResync(() => {
    void refresh();
    void refreshRuns();
  }), [refresh, refreshRuns]);
  // Invalidate in-flight requests on unmount / schedule switch.
  useEffect(() => () => {
    generationRef.current += 1;
    runsGenerationRef.current += 1;
  }, []);

  return {
    schedule,
    loading,
    error,
    refresh,
    runs: { ...runs, refresh: refreshRuns, loadMore: loadMoreRuns },
  };
}

// ── Sidebar schedule badge store (2026-09-15 owner) ────────────────────────
// Which sessions own at least one live (active/paused) Schedule — the rail's
// session rows render a small timer glyph for them. A module-level store
// (same shape as schedule-confirmations.ts) so one fetch serves every row;
// freshness rides the same coarse `schedule:changed` / resync signals the
// Timer lanes use. Completed once-Schedules and archived ones do not count.

const badgeListeners = new Set<() => void>();
let badgeSessionIds: ReadonlySet<string> = new Set();
let badgeHydrated = false;
let badgeFlight: Promise<void> | null = null;
let badgeInvalidationArmed = false;

function emitBadge(): void {
  for (const listener of badgeListeners) listener();
}

async function refreshBadgeSessionIds(): Promise<void> {
  badgeFlight ??= (async () => {
    try {
      const ids = new Set<string>();
      let cursor: string | null = null;
      do {
        const page = await loadSchedules({
          statuses: ['active', 'paused'],
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        for (const schedule of page.schedules) ids.add(schedule.control_session_id);
        cursor = page.next_cursor;
      } while (cursor);
      badgeSessionIds = ids;
      badgeHydrated = true;
      emitBadge();
    } catch {
      // Keep the last known set — the badge is a hint, never a gate.
    } finally {
      badgeFlight = null;
    }
  })();
  return badgeFlight;
}

function armBadgeInvalidation(): void {
  if (badgeInvalidationArmed) return;
  badgeInvalidationArmed = true;
  onScheduleChanged(() => { void refreshBadgeSessionIds(); });
  onScheduleResync(() => { void refreshBadgeSessionIds(); });
}

function subscribeBadge(listener: () => void): () => void {
  badgeListeners.add(listener);
  armBadgeInvalidation();
  if (!badgeHydrated) void refreshBadgeSessionIds();
  return () => { badgeListeners.delete(listener); };
}

function getBadgeSnapshot(): ReadonlySet<string> {
  return badgeSessionIds;
}

/** Control-Session ids of every live Schedule — `.has(session.id)` per row. */
export function useScheduledSessionIds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeBadge, getBadgeSnapshot, getBadgeSnapshot);
}

/** Test-only: drop hydrated state so each test re-fetches through its own
 *  mocked fetch router. */
export function __resetScheduleBadgeForTest(): void {
  badgeSessionIds = new Set();
  badgeHydrated = false;
  badgeFlight = null;
}
