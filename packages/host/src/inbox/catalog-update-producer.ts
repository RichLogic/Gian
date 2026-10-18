import type { Db } from '../storage/db.js';

/** Catalog projects only `entry.stable`. That is the Integration channel. */
export const INTEGRATION_UPDATE_CHANNEL = 'stable';

export interface CatalogUpdateCandidate {
  pluginId: string;
  displayName: string;
  version: string;
  channel: typeof INTEGRATION_UPDATE_CHANNEL;
  phase: 'available' | 'failed';
  catalogSequence: number;
}

/**
 * `ignore` is an unready, stale, or torn snapshot. It must not open or expire.
 * `complete` is one ready Catalog generation whose installed receipts did not
 * change while they were read.
 */
export interface CatalogUpdateSnapshot {
  mode: 'complete' | 'ignore';
  catalogSequence: number | null;
  candidates: readonly CatalogUpdateCandidate[];
}

export type CatalogObservationResult = 'applied' | 'stale' | 'ignored';

export interface CatalogInboxObserver {
  /** Inbox collection fence, captured before Catalog and receipt reads. */
  begin(): number;
  /**
   * `stale` means the collection fence moved. The caller recaptures it.
   * `ignored` writes nothing.
   */
  finish(fence: number, snapshot: CatalogUpdateSnapshot): CatalogObservationResult;
}

interface CatalogInboxSink {
  collectionRevision(): number;
  reconcile(input: {
    scope: 'product.update.integration';
    mode: 'complete';
    snapshot_revision: number;
    live: readonly unknown[];
  }): unknown;
}

interface EpochRow {
  epoch: number;
  version: string;
  channel: string;
  phase: string;
  catalog_sequence: number;
}

const IDENT = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * One Inbox item per plugin id. Agent aliases are not a second key: the
 * candidate is the projected plugin, and `update_proxy` is the eligibility
 * decision. A later observation of the same version and channel, including a
 * phase change, keeps that generation and does not mark it unread.
 */
export function catalogUpdateInboxObserver(db: Db, inbox: CatalogInboxSink): CatalogInboxObserver {
  return {
    begin() {
      return inbox.collectionRevision();
    },
    finish(fence, snapshot) {
      if (snapshot.mode !== 'complete' || snapshot.catalogSequence === null) return 'ignored';
      const planned = planCandidates(db, snapshot.candidates);
      if (!planned) {
        console.error('[catalog-inbox] skipped an observation with a candidate the Inbox cannot store');
        return 'ignored';
      }
      try {
        inbox.reconcile({
          scope: 'product.update.integration',
          mode: 'complete',
          snapshot_revision: fence,
          live: planned.map(item => item.signal),
        });
      } catch (error) {
        if (isStaleCollection(error)) return 'stale';
        console.error('[catalog-inbox] observation was not applied', error);
        return 'ignored';
      }
      const save = db.prepare(
        `INSERT INTO inbox_source_epochs
           (source_key, epoch, version, channel, phase, catalog_sequence)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_key) DO UPDATE SET
           epoch = excluded.epoch,
           version = excluded.version,
           channel = excluded.channel,
           phase = excluded.phase,
           catalog_sequence = excluded.catalog_sequence`,
      );
      db.transaction(() => {
        for (const item of planned) {
          save.run(
            item.sourceKey,
            item.epoch,
            item.candidate.version,
            item.candidate.channel,
            item.candidate.phase,
            item.candidate.catalogSequence,
          );
        }
      })();
      return 'applied';
    },
  };
}

function isStaleCollection(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'STALE';
}

interface PlannedCandidate {
  sourceKey: string;
  epoch: number;
  candidate: CatalogUpdateCandidate;
  signal: Record<string, unknown>;
}

function planCandidates(db: Db, candidates: readonly CatalogUpdateCandidate[]): PlannedCandidate[] | null {
  const seen = new Set<string>();
  const planned: PlannedCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.pluginId)) continue;
    seen.add(candidate.pluginId);
    if (!identifies(candidate)) return null;
    const sourceKey = `product.update:integration:${candidate.pluginId}`;
    const epoch = plannedEpoch(db, sourceKey, candidate);
    planned.push({
      sourceKey,
      epoch,
      candidate,
      signal: {
        kind: 'product.update',
        product: 'integration',
        target_id: candidate.pluginId,
        version: candidate.version,
        channel: candidate.channel,
        epoch,
        phase: candidate.phase,
        title: candidate.displayName.trim() || candidate.pluginId,
        summary: candidate.phase === 'failed'
          ? `${candidate.version} failed validation on the stable channel.`
          : `${candidate.version} is available on the stable channel.`,
      },
    });
  }
  return planned;
}

function plannedEpoch(db: Db, sourceKey: string, candidate: CatalogUpdateCandidate): number {
  const row = db.prepare(
    `SELECT epoch, version, channel, phase, catalog_sequence
       FROM inbox_source_epochs
      WHERE source_key = ?`,
  ).get(sourceKey) as EpochRow | undefined;
  if (!row) return candidate.catalogSequence;
  const same = row.version === candidate.version
    && row.channel === candidate.channel
    && row.phase === candidate.phase
    && row.catalog_sequence === candidate.catalogSequence;
  if (same) return row.epoch;
  return Math.max(row.epoch + 1, candidate.catalogSequence);
}

function identifies(candidate: CatalogUpdateCandidate): boolean {
  return IDENT.test(candidate.pluginId)
    && IDENT.test(candidate.version)
    && candidate.channel === INTEGRATION_UPDATE_CHANNEL
    && Number.isSafeInteger(candidate.catalogSequence)
    && candidate.catalogSequence >= 1;
}
