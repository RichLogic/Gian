export interface GitHubUserProfile {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string;
  profileUrl: string;
}

export type GitHubAuthUnavailableReason =
  | 'not_configured'
  | 'secure_storage_unavailable';

export type GitHubAuthState =
  | { status: 'unavailable'; reason: GitHubAuthUnavailableReason }
  | { status: 'signed_out' }
  | { status: 'signed_in'; user: GitHubUserProfile };

export interface GitHubDeviceAuthorization {
  userCode: string;
  verificationUri: string;
  expiresAt: string;
}

export type GitHubAuthError =
  | 'not_configured'
  | 'secure_storage_unavailable'
  | 'network'
  | 'invalid_response'
  | 'expired'
  | 'denied'
  | 'cancelled'
  | 'not_started';

export type GitHubAuthStartResult =
  | { ok: true; authorization: GitHubDeviceAuthorization }
  | { ok: false; error: GitHubAuthError };

export type GitHubAuthFinishResult =
  | { ok: true; user: GitHubUserProfile }
  | { ok: false; error: GitHubAuthError };

export interface GitHubDesktopAuthApi {
  getState(): Promise<GitHubAuthState>;
  start(): Promise<GitHubAuthStartResult>;
  finish(): Promise<GitHubAuthFinishResult>;
  cancel(): Promise<void>;
  signOut(): Promise<void>;
}
