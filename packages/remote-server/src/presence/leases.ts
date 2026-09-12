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
}
