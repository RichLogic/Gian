import { RemoteProtocolError, type RemoteMethod } from '@gian/remote-protocol';

export interface RecoverableCommand {
  commandId: string;
  hostId: string;
  method: RemoteMethod;
  label: string;
  params?: unknown;
  resolve?: (value: unknown) => void;
  reject?: (error: unknown) => void;
}

export interface PendingWaiter {
  hostId: string;
  method: RemoteMethod;
  label: string;
  params?: unknown;
  /** Recovery probes are bounded attempts. If their Relay closes, reject the
   *  probe and let the original command be queued once for the next Relay. */
  recoverOnDisconnect?: boolean;
  resolve?: (value: unknown) => void;
  reject?: (error: unknown) => void;
}

export function takePendingOnDisconnect(
  pending: Map<string, PendingWaiter>,
  hostId?: string,
): RecoverableCommand[] {
  const recovered: RecoverableCommand[] = [];
  for (const [commandId, waiter] of pending) {
    if (hostId && waiter.hostId !== hostId) continue;
    pending.delete(commandId);
    if (waiter.method === 'command.status' || waiter.recoverOnDisconnect === false) {
      waiter.reject?.(new RemoteProtocolError(
        'UNKNOWN_OUTCOME',
        `disconnected before ${waiter.label} returned`,
      ));
      continue;
    }
    recovered.push({
      commandId,
      hostId: waiter.hostId,
      method: waiter.method,
      label: waiter.label,
      ...(waiter.params !== undefined ? { params: waiter.params } : {}),
      ...(waiter.resolve ? { resolve: waiter.resolve } : {}),
      ...(waiter.reject ? { reject: waiter.reject } : {}),
    });
  }
  return recovered;
}

export function nextUnknownCommandId(
  current: string | null,
  commandId: string,
  phase: 'succeeded' | 'failed' | 'unknown',
): string | null {
  if (phase === 'unknown') return commandId;
  return current === commandId ? null : current;
}

export function statusNeedsRefresh(state: string): boolean {
  return state === 'unknown_outcome' || state === 'not_seen' || state === 'accepted' || state === 'expired';
}
