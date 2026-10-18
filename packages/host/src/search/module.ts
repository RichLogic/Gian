import type { Hono } from 'hono';
import { registerSearchRoutes } from '../web/routes/search.js';
import { drainSearchOnce, type MaintainLimits } from './maintain.js';
import {
  SEARCH_DIRTY_PAGE,
  SEARCH_SCAN_BUDGET,
  SEARCH_SOURCE_PAGE,
  SEARCH_TURN_PAGE,
  dirtyCount,
  readState,
} from './store.js';
import type { SearchModule, SearchModuleDeps } from './types.js';

const BUSY_DELAY_MS = 25;
const IDLE_DELAY_MS = 2000;

/**
 * Persistent index worker. `start` is idempotent and is not called from
 * `register`. `dispose` clears the timer, stops the in-flight drain, and
 * waits until that drain leaves the database. Inventory refresh uses the
 * caller's `listWorkingTrees` cache. This module does not scan git worktrees.
 */
export function createSearchModule(deps: SearchModuleDeps): SearchModule {
  const limits: MaintainLimits = {
    dirtyPage: positive(deps.limits?.dirtyPage, SEARCH_DIRTY_PAGE),
    sourcePage: positive(deps.limits?.sourcePage, SEARCH_SOURCE_PAGE),
    turnPage: positive(deps.limits?.turnPage, SEARCH_TURN_PAGE),
  };
  const scanBudget = positive(deps.limits?.scanBudget, SEARCH_SCAN_BUDGET);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  let disposed = false;
  let inFlight: Promise<void> | null = null;
  let inventoryCursor: string | null = null;
  let inventoryCheckedAt = 0;

  function schedule(delay: number): void {
    if (disposed || !started || timer) return;
    timer = setTimeout(() => {
      timer = null;
      tick();
    }, delay);
  }

  function tick(): void {
    if (disposed || inFlight) return;
    let release: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    inFlight = done;
    void runTick()
      .catch(() => undefined)
      .finally(() => {
        if (inFlight === done) inFlight = null;
        release();
        if (started && !disposed) schedule(nextDelay());
      });
  }

  async function runTick(): Promise<void> {
    try {
      const now = Date.now();
      const refreshInventory = now - inventoryCheckedAt >= IDLE_DELAY_MS;
      const result = await drainSearchOnce(
        deps.db,
        deps.dataDir,
        deps.listWorkingTrees,
        limits,
        { refreshInventory, inventoryCursor, stop: () => disposed },
      );
      if (disposed) return;
      inventoryCursor = result.inventoryCursor;
      if (result.inventoryRefreshed) inventoryCheckedAt = now;
    } catch {
      // The drain records a bounded last_error. Closing the database must not reject the timer.
    }
  }

  function nextDelay(): number {
    try {
      const state = readState(deps.db);
      if (state.last_error) return IDLE_DELAY_MS;
      if (state.fts_rebuild === 1 || state.backfill_complete !== 1 || dirtyCount(deps.db) > 0) {
        return BUSY_DELAY_MS;
      }
    } catch {
      return IDLE_DELAY_MS;
    }
    return IDLE_DELAY_MS;
  }

  return {
    register(app: Hono): void {
      registerSearchRoutes(app, deps.db, scanBudget);
    },
    start(): void {
      if (disposed || started) return;
      started = true;
      schedule(BUSY_DELAY_MS);
    },
    async dispose(): Promise<void> {
      disposed = true;
      started = false;
      if (timer) clearTimeout(timer);
      timer = null;
      await inFlight;
    },
  };
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
