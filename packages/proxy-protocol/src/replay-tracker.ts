import { createHash } from 'node:crypto';

import { requestViolation } from './errors.js';
import type { ProxyNotification } from './schemas.js';

export interface NativeReplaySnapshot {
  streamId: string;
  events: ProxyNotification[];
}

export interface ReplayPage<T> {
  replayStreamId: string;
  events: T[];
  nextCursor: string | null;
}

/** Pins one immutable snapshot for the duration of a replay paging pass. Live
 * history refreshes may replace the latest snapshot without changing page two
 * underneath a Host that is still consuming page one. */
export class ReplaySnapshotPager<T> {
  private readonly active = new Map<string, { streamId: string; events: readonly T[] }>();

  page(
    sessionId: string,
    latest: { streamId: string; events: readonly T[] },
    cursor: string | null,
    limit: number,
  ): ReplayPage<T> {
    const snapshot = cursor === null
      ? latest
      : this.active.get(sessionId);
    if (snapshot === undefined) {
      throw requestViolation('INVALID_REQUEST', 'Replay cursor has no active snapshot.');
    }
    if (cursor === null) this.active.set(sessionId, snapshot);

    const offset = cursor === null || /^(0|[1-9]\d*)$/.test(cursor)
      ? Number(cursor ?? 0)
      : Number.NaN;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > snapshot.events.length) {
      throw requestViolation('INVALID_REQUEST', 'Invalid replay cursor.');
    }
    const end = Math.min(offset + limit, snapshot.events.length);
    const nextCursor = end < snapshot.events.length ? String(end) : null;
    if (nextCursor === null) this.active.delete(sessionId);
    return {
      replayStreamId: snapshot.streamId,
      events: snapshot.events.slice(offset, end),
      nextCursor,
    };
  }

  close(sessionId: string): void {
    this.active.delete(sessionId);
  }
}

function turnGroups(snapshot: NativeReplaySnapshot): Map<string, ProxyNotification[]> {
  const groups = new Map<string, ProxyNotification[]>();
  for (const event of snapshot.events) {
    if (!('turnId' in event.params)) continue;
    const events = groups.get(event.params.turnId) ?? [];
    events.push(event);
    groups.set(event.params.turnId, events);
  }
  return groups;
}

function groupFingerprint(events: ProxyNotification[]): string {
  return JSON.stringify(events.map(event => ({
    method: event.method,
    params: {
      ...event.params,
      streamId: undefined,
      sequence: undefined,
    },
  })));
}

/** Tracks complete replay turns instead of raw file bytes. A changed turn is
 * replayed as one lifecycle-complete unit, while turns already observed from
 * Gian's own runtime writes stay out of external-history refreshes. */
export class IncrementalReplayTracker {
  private observed = new Map<string, string>();
  private includedTurns = new Set<string>();
  private latest: NativeReplaySnapshot = { streamId: 'replay-empty', events: [] };
  private replayStreamId = 'replay-empty';

  attach(snapshot: NativeReplaySnapshot, includeHistory: boolean): void {
    this.latest = snapshot;
    const groups = turnGroups(snapshot);
    this.observed = new Map(
      [...groups].map(([turnId, events]) => [turnId, groupFingerprint(events)]),
    );
    this.includedTurns = includeHistory ? new Set(groups.keys()) : new Set();
    this.replayStreamId = snapshot.streamId;
  }

  observe(snapshot: NativeReplaySnapshot): boolean {
    const groups = turnGroups(snapshot);
    const nextFingerprints = new Map(
      [...groups].map(([turnId, events]) => [turnId, groupFingerprint(events)]),
    );
    const currentOrder = [...groups.keys()];
    const previousIncluded = [...this.includedTurns];
    const lastPreviousIndex = previousIncluded.reduce(
      (last, turnId) => Math.max(last, currentOrder.indexOf(turnId)),
      -1,
    );
    let changed = false;
    let rewritten = snapshot.streamId !== this.latest.streamId;

    for (const [turnId, events] of groups) {
      const fingerprint = groupFingerprint(events);
      const previous = this.observed.get(turnId);
      if (previous === fingerprint) continue;
      changed = true;
      if (previous !== undefined || currentOrder.indexOf(turnId) < lastPreviousIndex) {
        rewritten = true;
      }
      this.includedTurns.add(turnId);
    }
    for (const turnId of previousIncluded) {
      if (groups.has(turnId)) continue;
      this.includedTurns.delete(turnId);
      changed = true;
      rewritten = true;
    }
    this.observed = nextFingerprints;
    this.latest = snapshot;
    if (rewritten) this.replayStreamId = revisionStreamId(snapshot, nextFingerprints);
    return changed;
  }

  /** Rebase after a Gian-owned turn while retaining any external turns that
   * were already queued but have not yet been acknowledged by Host. */
  rebase(snapshot: NativeReplaySnapshot): void {
    const included = new Set(this.includedTurns);
    this.latest = snapshot;
    const groups = turnGroups(snapshot);
    this.observed = new Map(
      [...groups].map(([turnId, events]) => [turnId, groupFingerprint(events)]),
    );
    this.includedTurns = new Set([...included].filter(turnId => groups.has(turnId)));
  }

  replay(): NativeReplaySnapshot {
    const selected = this.latest.events.filter(event => (
      'turnId' in event.params && this.includedTurns.has(event.params.turnId)
    ));
    return {
      streamId: this.replayStreamId,
      events: selected.map((event, index) => ({
        ...event,
        params: {
          ...event.params,
          streamId: this.replayStreamId,
          sequence: index + 1,
        },
      } as ProxyNotification)),
    };
  }

  acknowledge(): void {
    // Acknowledgement ends the current paging pass. Published turns stay in
    // the replay snapshot so later append-only refreshes preserve their
    // sequence numbers and Host can deduplicate them by stable eventId.
  }
}

function revisionStreamId(
  snapshot: NativeReplaySnapshot,
  fingerprints: Map<string, string>,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([...fingerprints]))
    .digest('hex')
    .slice(0, 24);
  return `${snapshot.streamId}-revision-${digest}`;
}
