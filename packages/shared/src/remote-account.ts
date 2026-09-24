/** Main-process secure storage / local Host broker contract, never a UI DTO. */
export interface RemoteAccountCredential {
  role: 'host' | 'controller';
  serverOrigin: string;
  serverFingerprint: string;
  installationId: string;
  accountId: string;
  accountLogin: string;
  /** Opaque session secret minted by this Remote Server, NOT a GitHub OAuth token. */
  token: string;
  expiresAt: number;
}
