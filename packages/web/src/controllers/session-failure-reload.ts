import type { Session } from '@gian/shared';
import { loadSessions } from '../api.js';
import type { OperationName, OperationRun } from '../operations/types.js';

const SESSION_METADATA_OPERATIONS: ReadonlySet<OperationName> = new Set([
  'session.rename',
  'session.archive',
  'session.pin',
  'session.setUnread',
  'session.setMode',
  'session.setModel',
  'session.setEffort',
  'session.setServiceTier',
  'session.assignTask',
]);

/** Restore Host truth after a definitive metadata rejection. The operation
 * overlay has already rolled back; this reload closes races with broadcasts
 * or other writers that may have changed the canonical Session meanwhile. */
export async function reloadFailedSessionMetadata(
  run: Pick<OperationRun, 'name'>,
  apply: (sessions: Session[]) => void,
  loader: () => Promise<Session[]> = loadSessions,
): Promise<boolean> {
  if (!SESSION_METADATA_OPERATIONS.has(run.name)) return false;
  apply(await loader());
  return true;
}
