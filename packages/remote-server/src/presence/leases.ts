import { type RemoteRepositories } from '../storage/repositories.js';
import { type RemoteServerConfig } from '../config.js';

export class PresenceService {
  constructor(
    private readonly repos: RemoteRepositories,
    private readonly config: RemoteServerConfig,
  ) {}

  heartbeat(hostId: string): number {
    return this.repos.touchPresence(hostId, this.config.presenceLeaseMs);
  }

  isOnline(hostId: string): boolean {
    return this.repos.isHostOnline(hostId);
  }

  /** Drop the lease immediately when the Host's live WS closes instead of
   *  letting devices trust a stale lease for up to the full lease period. */
  expire(hostId: string): void {
    this.repos.expirePresence(hostId);
  }
}
