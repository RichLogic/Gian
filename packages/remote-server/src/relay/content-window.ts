import {
  CONTENT_WINDOW_CHUNKS,
  RemoteProtocolError,
  type RelayFrame,
} from '@gian/remote-protocol';

interface InFlightContent {
  sequence: number;
  routeId: string;
}

export class ContentFlowWindow {
  readonly #inFlight = new Map<string, InFlightContent[]>();
  readonly #contentFrameIds = new Set<string>();

  accept(connectionId: string, frame: RelayFrame): void {
    if (frame.frame_class !== 'content') {
      throw new RemoteProtocolError('INVALID_FRAME', 'only content frames use the content window.');
    }
    const current = this.#inFlight.get(connectionId) ?? [];
    if (current.length >= CONTENT_WINDOW_CHUNKS) {
      throw new RemoteProtocolError('RATE_LIMITED', 'content window is full.');
    }
    current.push({ sequence: frame.transport_sequence, routeId: frame.route_id });
    this.#inFlight.set(connectionId, current);
    this.#contentFrameIds.add(frame.frame_id);
  }

  ack(connectionId: string, count = 1): void {
    const current = this.#inFlight.get(connectionId) ?? [];
    this.#inFlight.set(connectionId, current.slice(Math.max(0, count)));
  }

  releaseThrough(connectionId: string, routeId: string, transportAck: number): number {
    const current = this.#inFlight.get(connectionId) ?? [];
    const kept = current.filter((item) => !(item.routeId === routeId && item.sequence <= transportAck));
    this.#inFlight.set(connectionId, kept);
    return current.length - kept.length;
  }

  drop(connectionId: string): void {
    this.#inFlight.delete(connectionId);
  }

  inFlight(connectionId: string): number {
    return this.#inFlight.get(connectionId)?.length ?? 0;
  }

  sawContentFrame(frameId: string): boolean {
    return this.#contentFrameIds.has(frameId);
  }
}
