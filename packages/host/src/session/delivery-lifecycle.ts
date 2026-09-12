import type { QueueEntry } from '../queue/manager.js';

export interface TurnReceipt {
  turnId: string;
  turnNumber: number;
}

export interface SteerReceipt {
  turnId: string;
  turnNumber: number;
}

export interface SendQueuedNowAffected {
  queueId: string;
  toolRequestId?: string;
  deliveryId?: string;
  state: 'started' | 'steered';
  turnId: string;
  turnNumber: number;
}

export interface SendQueuedNowReceipt {
  mode: 'noop' | 'started' | 'steered';
  affected: SendQueuedNowAffected[];
  queue: QueueEntry[];
  queueRevision: string;
}

/** Host-internal delivery sink. SessionManager must not import ToolService. */
export interface DeliveryLifecycleSink {
  queueRemoved(entry: QueueEntry, reason: 'queue_removed' | 'queue_cleared'): void;
  queueStarted(entry: QueueEntry, receipt: TurnReceipt): void;
  queueSteered(entry: QueueEntry, receipt: SteerReceipt): void;
  queueRestored(entry: QueueEntry): void;
}
