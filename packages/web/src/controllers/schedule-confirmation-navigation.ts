/**
 * Schedule-confirmation navigation decision (0.6.7): the async core of the
 * desktop/Inbox confirmation deep link, extracted so the arbitration is
 * testable without mounting the App. The caller binds the real navigation
 * generation: after the (possibly slow) hydrate, a newer user choice or a
 * newer notification must win — a superseded delivery is reported, never
 * applied. A failed hydrate is NOT verified: report 'pending' so the
 * desktop keeps the target for a later retry, never a fake settled ack.
 */
import type { ScheduleConfirmation } from '@gian/shared';

export interface ConfirmationNavigationTarget {
  confirmationId: string;
  controlSessionId: string;
  inboxRef: { id: string; generation: number };
}

export interface ConfirmationNavigationDeps {
  hydrate: () => Promise<boolean>;
  findConfirmation: (confirmationId: string) => ScheduleConfirmation | undefined;
  focus: (confirmationId: string, inboxRef: { id: string; generation: number }) => void;
  openControlSession: (controlSessionId: string) => void;
  unavailable: () => void;
  /** Post-await arbitration check: false when a newer intent owns the view. */
  isCurrent: () => boolean;
}

export type ConfirmationNavigationOutcome = 'settled' | 'pending' | 'superseded';

export async function resolveScheduleConfirmationNavigation(
  target: ConfirmationNavigationTarget,
  deps: ConfirmationNavigationDeps,
): Promise<ConfirmationNavigationOutcome> {
  const ok = await deps.hydrate();
  if (!deps.isCurrent()) return 'superseded';
  if (!ok) return 'pending';
  const confirmation = deps.findConfirmation(target.confirmationId);
  if (confirmation?.status === 'pending') {
    // The exact confirmation card is the detail (focused with the observed
    // ref); the control conversation opens for context.
    deps.focus(target.confirmationId, target.inboxRef);
    deps.openControlSession(target.controlSessionId);
  } else {
    deps.unavailable();
  }
  return 'settled';
}
