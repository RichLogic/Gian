import type { HostServiceDescriptor } from '@gian/proxy-protocol';
import type { GianToolCredentialManager, GianToolRole } from './credentials.js';

const INTERNAL_CREDENTIAL_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export interface GianSessionHostServiceIdentity {
  sessionId: string;
  agentId: string | null;
  workspaceId: string | null;
  taskId: string | null;
  role: GianToolRole;
}

export interface GianSessionHostServiceLease {
  readonly descriptor: HostServiceDescriptor;
  readonly credentialId: string;
  readonly provisional: boolean;
  activate(): void;
  revoke(): void;
}

export class GianSessionHostServiceIssuer {
  constructor(
    private readonly credentials: GianToolCredentialManager,
    private readonly endpoint: string,
  ) {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Gian Session Host Service requires an HTTP(S) endpoint');
    }
  }

  issue(
    identity: GianSessionHostServiceIdentity,
    options: { provisional: boolean },
  ): GianSessionHostServiceLease {
    this.credentials.revokeSession(identity.sessionId);
    const issued = options.provisional
      ? this.credentials.issueProvisionalInternalSession({
          ...identity,
          ttlMs: INTERNAL_CREDENTIAL_TTL_MS,
        })
      : this.credentials.issueInternalSession({
          sessionId: identity.sessionId,
          role: identity.role,
          ttlMs: INTERNAL_CREDENTIAL_TTL_MS,
          renewable: true,
        });
    let state: 'provisional' | 'active' | 'revoked' = options.provisional
      ? 'provisional'
      : 'active';
    return {
      credentialId: issued.credentialId,
      provisional: options.provisional,
      descriptor: {
        id: 'gian',
        protocol: 'mcp',
        transport: {
          type: 'streamable-http',
          url: this.endpoint,
          headers: { Authorization: `Bearer ${issued.token}` },
        },
      },
      activate: () => {
        if (state === 'active') return;
        if (state === 'revoked') throw new Error('Gian Session Host Service lease was revoked');
        this.credentials.activateProvisionalInternalSession(issued.credentialId);
        state = 'active';
      },
      revoke: () => {
        if (state === 'revoked') return;
        this.credentials.revoke(issued.credentialId);
        state = 'revoked';
      },
    };
  }

  revokeSession(sessionId: string): number {
    return this.credentials.revokeSession(sessionId);
  }

  revokeAll(): number {
    return this.credentials.revokeAllInternalSessions();
  }
}
