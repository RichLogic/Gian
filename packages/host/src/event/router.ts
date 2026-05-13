import type { EventType, UnifiedEvent } from '@gian/shared';

type Listener = (e: UnifiedEvent) => void;
type TypedListener<T extends EventType> = (e: UnifiedEvent<T>) => void;

/**
 * In-process pub/sub bus for unified events.
 *
 * Intentionally thin: no persistence, no buffering, no replay, no IM
 * filtering. Those layers are added in M1 (normalization) and M3 (IM bridge).
 */
export class EventRouter {
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Type-narrowing subscribe. The callback only fires for events whose `type`
   * matches `eventType`, saving each subscriber from writing the if-check.
   */
  subscribeByType<T extends EventType>(
    eventType: T,
    fn: TypedListener<T>,
  ): () => void {
    const wrapped: Listener = e => {
      if (e.type === eventType) fn(e as UnifiedEvent<T>);
    };
    this.listeners.add(wrapped);
    return () => this.listeners.delete(wrapped);
  }

  publish(e: UnifiedEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        // Swallow — a bad listener must not stall the event pipeline.
      }
    }
  }
}
