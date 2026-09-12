import {
  CONTROL_OUTBOX_MAX_BYTES,
  CONTROL_OUTBOX_MAX_FRAMES,
  type RemoteControlMessage,
} from '@gian/remote-protocol';

export interface ReplayEnvelope {
  eventSequence: number;
  revision: string;
  message: RemoteControlMessage;
  bytes: number;
}

export class RemoteReplayBuffer {
  private readonly frames: ReplayEnvelope[] = [];
  private bytes = 0;
  private nextSequence = 0;
  private revision = '0';
  private evicted = false;

  constructor(
    private readonly maxFrames = CONTROL_OUTBOX_MAX_FRAMES,
    private readonly maxBytes = CONTROL_OUTBOX_MAX_BYTES,
  ) {}

  get eventSequence(): number {
    return this.nextSequence;
  }

  get currentRevision(): string {
    return this.revision;
  }

  get evictedSinceBoot(): boolean {
    return this.evicted;
  }

  push(message: RemoteControlMessage, revision = this.revision): ReplayEnvelope {
    if (message.type === 'attachment.chunk' || message.type === 'download.metadata') {
      throw new Error('content frames must not enter the control replay buffer');
    }
    const encoded = Buffer.byteLength(JSON.stringify(message), 'utf8');
    const envelope: ReplayEnvelope = {
      eventSequence: this.nextSequence,
      revision,
      message,
      bytes: encoded,
    };
    this.frames.push(envelope);
    this.bytes += encoded;
    this.nextSequence += 1;
    this.revision = revision;
    while (
      this.frames.length > this.maxFrames
      || this.bytes > this.maxBytes
    ) {
      const removed = this.frames.shift();
      if (!removed) break;
      this.bytes -= removed.bytes;
      this.evicted = true;
    }
    return envelope;
  }

  setRevision(revision: string): void {
    this.revision = revision;
  }

  replayAfter(afterEventSequence: number, currentRevision: string): ReplayEnvelope[] | 'snapshot' {
    if (this.evicted && (this.frames[0]?.eventSequence ?? 0) > afterEventSequence + 1) {
      return 'snapshot';
    }
    if (afterEventSequence > this.nextSequence - 1) return 'snapshot';
    if (currentRevision !== this.revision && afterEventSequence < this.nextSequence - 1) {
      const match = this.frames.find(frame => frame.eventSequence === afterEventSequence);
      if (!match || match.revision !== currentRevision) return 'snapshot';
    }
    return this.frames.filter(frame => frame.eventSequence > afterEventSequence);
  }
}
