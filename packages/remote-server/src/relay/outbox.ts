import {
  RemoteProtocolError,
  type RelayFrame,
  type TransportDirection,
  utf8ByteLength,
} from '@gian/remote-protocol';

interface DirectionBucket {
  frames: RelayFrame[];
  bytes: number;
}

export class ControlOutbox {
  readonly #routes = new Map<string, Map<TransportDirection, DirectionBucket>>();
  readonly #hostRoutes = new Map<string, Set<string>>();

  constructor(
    private readonly maxFrames: number,
    private readonly maxBytes: number,
  ) {}

  enqueue(frame: RelayFrame, direction: TransportDirection): void {
    if (frame.frame_class !== 'control') {
      throw new RemoteProtocolError('INVALID_FRAME', 'content frames cannot enter the control outbox.');
    }
    const route = this.#routes.get(frame.route_id) ?? new Map<TransportDirection, DirectionBucket>();
    const totals = this.#totals(route);
    const size = utf8ByteLength(frame.ciphertext);
    if (totals.frames + 1 > this.maxFrames || totals.bytes + size > this.maxBytes) {
      throw new RemoteProtocolError('RATE_LIMITED', 'control outbox overflow.');
    }
    const bucket = route.get(direction) ?? { frames: [], bytes: 0 };
    bucket.frames.push(frame);
    bucket.bytes += size;
    route.set(direction, bucket);
    this.#routes.set(frame.route_id, route);
    const hostRoutes = this.#hostRoutes.get(frame.host_id) ?? new Set<string>();
    hostRoutes.add(frame.route_id);
    this.#hostRoutes.set(frame.host_id, hostRoutes);
  }

  ack(routeId: string, direction: TransportDirection, transportAck: number): void {
    const route = this.#routes.get(routeId);
    const bucket = route?.get(direction);
    if (!route || !bucket) return;
    const kept = bucket.frames.filter((frame) => frame.transport_sequence > transportAck);
    bucket.bytes = kept.reduce((sum, frame) => sum + utf8ByteLength(frame.ciphertext), 0);
    bucket.frames = kept;
    route.set(direction, bucket);
  }

  snapshot(routeId: string, direction?: TransportDirection): RelayFrame[] {
    const route = this.#routes.get(routeId);
    if (!route) return [];
    if (direction) return [...(route.get(direction)?.frames ?? [])];
    return [...route.values()].flatMap((bucket) => bucket.frames);
  }

  routesForHost(hostId: string): string[] {
    return [...(this.#hostRoutes.get(hostId) ?? [])];
  }

  snapshotForHost(hostId: string, direction?: TransportDirection): RelayFrame[] {
    return this.routesForHost(hostId).flatMap((routeId) => this.snapshot(routeId, direction));
  }

  size(routeId: string): { frames: number; bytes: number } {
    return this.#totals(this.#routes.get(routeId) ?? new Map());
  }

  dropRoute(routeId: string): void {
    this.#routes.delete(routeId);
    for (const [hostId, routes] of this.#hostRoutes) {
      routes.delete(routeId);
      if (routes.size === 0) this.#hostRoutes.delete(hostId);
    }
  }

  dropDevice(deviceId: string): void {
    for (const routeId of [...this.#routes.keys()]) {
      const frames = this.snapshot(routeId);
      if (routeId === deviceId || frames.some((frame) => frame.device_id === deviceId)) {
        this.dropRoute(routeId);
      }
    }
  }

  clear(): void {
    this.#routes.clear();
    this.#hostRoutes.clear();
  }

  #totals(route: Map<TransportDirection, DirectionBucket>): { frames: number; bytes: number } {
    let frames = 0;
    let bytes = 0;
    for (const bucket of route.values()) {
      frames += bucket.frames.length;
      bytes += bucket.bytes;
    }
    return { frames, bytes };
  }
}
