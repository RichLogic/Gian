import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '../storage/db.js';
import { ScheduleError } from './errors.js';
import { ScheduleRepository } from './repository.js';

/**
 * REST `Idempotency-Key` receipts (design §6/§11). SQL lives on the
 * ScheduleRepository; this module owns the hash/lease/replay semantics:
 * same key + different input always conflicts, a terminal receipt replays
 * byte-for-byte, an unexpired in-progress lease answers 409 + Retry-After,
 * and an expired lease can be taken over by the same input hash only,
 * reusing the pre-allocated domain id.
 */

export const COMMAND_LEASE_MS = 30_000;

export type ClaimOutcome =
  | { kind: 'claimed'; domainId: string | null; recovered: false }
  | { kind: 'claimed'; domainId: string | null; recovered: true }
  | { kind: 'replay'; status: 'succeeded' | 'failed'; response: unknown; error: unknown }
  | { kind: 'busy' };

/** Canonical JSON: sorted keys, undefined dropped — mirrors the Tool ledger. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonical(item)).join(',')}]`;
  const input = value as Record<string, unknown>;
  return `{${Object.keys(input).filter(key => input[key] !== undefined).sort()
    .map(key => `${JSON.stringify(key)}:${canonical(input[key])}`).join(',')}}`;
}

export function scheduleCommandHash(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method}\0${path}\0${canonical(body ?? null)}`)
    .digest('hex');
}

export class ScheduleCommandLedger {
  private readonly repository: ScheduleRepository;

  constructor(
    db: Db,
    private readonly now: () => { ms: number; iso: string } = () => {
      const ms = Date.now();
      return { ms, iso: new Date(ms).toISOString() };
    },
  ) {
    this.repository = new ScheduleRepository(db);
  }

  /** `preallocateDomainId` must be true for create/run so a crash+retry
   *  converges on the same Schedule/Run id. */
  claim(options: {
    actorKey: string;
    idempotencyKey: string;
    method: string;
    inputHash: string;
    preallocateDomainId: boolean;
  }): ClaimOutcome {
    const { ms, iso } = this.now();
    const existing = this.repository.receipt(options.actorKey, options.idempotencyKey);
    if (existing) {
      if (existing.method !== options.method || existing.input_hash !== options.inputHash) {
        throw new ScheduleError(
          'IDEMPOTENCY_CONFLICT',
          'Idempotency-Key was already used with different input',
        );
      }
      if (existing.status === 'succeeded' || existing.status === 'failed') {
        return {
          kind: 'replay',
          status: existing.status,
          response: existing.response_json === null ? null : JSON.parse(existing.response_json),
          error: existing.error_json === null ? null : JSON.parse(existing.error_json),
        };
      }
      const leaseExpired = existing.lease_expires_at === null
        || Date.parse(existing.lease_expires_at) <= ms;
      if (!leaseExpired) return { kind: 'busy' };
      const leaseToken = randomUUID();
      const tookOver = this.repository.takeoverExpiredReceipt({
        actorKey: options.actorKey,
        idempotencyKey: options.idempotencyKey,
        inputHash: options.inputHash,
        leaseToken,
        leaseExpiresAt: new Date(ms + COMMAND_LEASE_MS).toISOString(),
        nowIso: iso,
      });
      if (!tookOver) return { kind: 'busy' };
      return { kind: 'claimed', domainId: existing.domain_id, recovered: true };
    }
    const domainId = options.preallocateDomainId ? randomUUID() : null;
    this.repository.insertReceipt({
      actor_key: options.actorKey,
      idempotency_key: options.idempotencyKey,
      method: options.method,
      input_hash: options.inputHash,
      status: 'in_progress',
      domain_id: domainId,
      lease_token: randomUUID(),
      lease_expires_at: new Date(ms + COMMAND_LEASE_MS).toISOString(),
      response_json: null,
      error_json: null,
      created_at: iso,
      updated_at: iso,
    });
    return { kind: 'claimed', domainId, recovered: false };
  }

  succeed(options: {
    actorKey: string;
    idempotencyKey: string;
    response: unknown;
  }): void {
    this.repository.succeedReceipt(
      options.actorKey,
      options.idempotencyKey,
      options.response,
      this.now().iso,
    );
    this.repository.pruneReceipts();
  }

  fail(options: {
    actorKey: string;
    idempotencyKey: string;
    /** Full REST error envelope; replayed byte-for-byte with its status. */
    error: unknown;
  }): void {
    this.repository.failReceipt(
      options.actorKey,
      options.idempotencyKey,
      options.error,
      this.now().iso,
    );
    this.repository.pruneReceipts();
  }
}
