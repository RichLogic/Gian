/**
 * UI Operation Layer — Schedule-domain definitions (Issue #51 / ADR-0053,
 * contract M/N/L). Every Schedule mutation the Timer UI can trigger is
 * registered here; views dispatch by name instead of calling the schedules
 * REST helpers directly.
 *
 * All operations are REST-backed (`execute`) with the `pending` policy:
 * the row/form shows an in-progress state and the dispatcher's same-entity
 * dedupe blocks double submission. Each execute mints ONE stable
 * `Idempotency-Key` for its logical command — the Host's command receipt
 * ledger replays it byte-for-word on retry.
 *
 * Canonical convergence: the Host broadcasts `schedule:changed` for every
 * mutation (contract N) and the schedule controllers re-pull on that signal
 * (see presentation/schedule-sync.ts), so these definitions deliberately do
 * not patch local state. A `SCHEDULE_REVISION_CONFLICT` on update is rethrown
 * as the SCHEDULE_REVISION_CONFLICT_MESSAGE sentinel — the Definition form
 * maps it to a localized conflict notice and re-reads the canonical row.
 */
import type {
  Schedule,
  ScheduleConfirmation,
  ScheduleMisfirePolicy,
  ScheduleRun,
  ScheduleTrigger,
} from '@gian/shared';

import {
  ScheduleApiError,
  resolveScheduleConfirmation,
  scheduleAction,
  updateSchedule,
} from '../api.js';
import { toast } from '../feedback.js';
import { registry } from './registry.js';
import type { OperationDefinition } from './types.js';

export function scheduleEntityKey(scheduleId: string): string {
  return `schedule:${scheduleId}`;
}

export function scheduleConfirmationEntityKey(confirmationId: string): string {
  return `schedule-confirmation:${confirmationId}`;
}

/** Sentinel run error for a 409 revision conflict on schedule.update. The
 *  Definition form recognizes it to show the localized conflict notice. */
export const SCHEDULE_REVISION_CONFLICT_MESSAGE = 'SCHEDULE_REVISION_CONFLICT';

/** REST round-trips are normally well under this; expiry marks the outcome
 *  unknown (never failed), same semantics as the WS operations. */
const REST_TIMEOUT_MS = 10_000;

function mintIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `schedule-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function toastFailure(error: { message: string }): void {
  toast({ kind: 'error', message: error.message });
}

export interface ScheduleUpdateOperationInput {
  scheduleId: string;
  expectedRevision: number;
  name?: string;
  prompt?: string;
  trigger?: ScheduleTrigger;
  timezone?: string;
  misfirePolicy?: ScheduleMisfirePolicy;
}

const scheduleUpdate: OperationDefinition<ScheduleUpdateOperationInput, Schedule> = {
  policy: 'pending',
  entityKey: input => scheduleEntityKey(input.scheduleId),
  execute: async input => {
    try {
      return await updateSchedule(input.scheduleId, {
        expectedRevision: input.expectedRevision,
        idempotencyKey: mintIdempotencyKey(),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        ...(input.trigger !== undefined ? { trigger: input.trigger } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        ...(input.misfirePolicy !== undefined ? { misfirePolicy: input.misfirePolicy } : {}),
      });
    } catch (error) {
      if (error instanceof ScheduleApiError && error.code === 'SCHEDULE_REVISION_CONFLICT') {
        throw new Error(SCHEDULE_REVISION_CONFLICT_MESSAGE);
      }
      throw error;
    }
  },
  // No toast: the Definition form renders the run error inline.
  timeoutMs: REST_TIMEOUT_MS,
};

interface ScheduleActionInput {
  scheduleId: string;
  expectedRevision?: number;
}

const schedulePause: OperationDefinition<ScheduleActionInput, Schedule> = {
  policy: 'pending',
  entityKey: input => scheduleEntityKey(input.scheduleId),
  execute: input => scheduleAction(input.scheduleId, 'pause', {
    idempotencyKey: mintIdempotencyKey(),
    ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
  }) as Promise<Schedule>,
  rollback: toastFailure,
  timeoutMs: REST_TIMEOUT_MS,
};

const scheduleResume: OperationDefinition<ScheduleActionInput, Schedule> = {
  policy: 'pending',
  entityKey: input => scheduleEntityKey(input.scheduleId),
  execute: input => scheduleAction(input.scheduleId, 'resume', {
    idempotencyKey: mintIdempotencyKey(),
    ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
  }) as Promise<Schedule>,
  rollback: toastFailure,
  timeoutMs: REST_TIMEOUT_MS,
};

/** Manual run needs no expected_revision (contract M): it converges on the
 *  canonical Run through the receipt's preallocated domain id. */
const scheduleRunNow: OperationDefinition<{ scheduleId: string }, ScheduleRun> = {
  policy: 'pending',
  entityKey: input => scheduleEntityKey(input.scheduleId),
  execute: input => scheduleAction(input.scheduleId, 'run', {
    idempotencyKey: mintIdempotencyKey(),
  }) as Promise<ScheduleRun>,
  rollback: toastFailure,
  timeoutMs: REST_TIMEOUT_MS,
};

const scheduleArchive: OperationDefinition<ScheduleActionInput, Schedule> = {
  policy: 'pending',
  entityKey: input => scheduleEntityKey(input.scheduleId),
  execute: input => scheduleAction(input.scheduleId, 'archive', {
    idempotencyKey: mintIdempotencyKey(),
    ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
  }) as Promise<Schedule>,
  rollback: toastFailure,
  timeoutMs: REST_TIMEOUT_MS,
};

/** Host-enforced create confirmation (contract L). The resolve REST route
 *  does not take an Idempotency-Key (the confirmation id itself is the
 *  dedupe); the run result is the resolved Confirmation, which the card
 *  upserts into the pending store on `confirmed`. */
const scheduleResolveConfirmation: OperationDefinition<
  { confirmationId: string; decision: 'approve' | 'reject' },
  ScheduleConfirmation
> = {
  policy: 'pending',
  entityKey: input => scheduleConfirmationEntityKey(input.confirmationId),
  execute: input => resolveScheduleConfirmation(input.confirmationId, input.decision),
  // No toast: the card keeps the failure visible and offers retry.
  timeoutMs: REST_TIMEOUT_MS,
};

registry.register('schedule.update', scheduleUpdate);
registry.register('schedule.pause', schedulePause);
registry.register('schedule.resume', scheduleResume);
registry.register('schedule.runNow', scheduleRunNow);
registry.register('schedule.archive', scheduleArchive);
registry.register('schedule.resolveConfirmation', scheduleResolveConfirmation);
