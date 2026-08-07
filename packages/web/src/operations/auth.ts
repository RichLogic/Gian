/**
 * UI Operation Layer — Auth-domain definitions (Phase 3b of
 * `docs/proposals/ui-operation-layer.md`): password login, logout, and the
 * desktop GitHub device flow. All PENDING; all entity-keyed `auth:current`
 * (there is exactly one auth session, and a second submission while one is
 * in flight is a duplicate).
 *
 * AUTH SINK: the operations never touch app state directly. `wireAuthSink`
 * (wired by `use-app-auth`, which owns the status/identity state) receives
 * the settled identity transitions:
 * - `auth.login` / `auth.githubLogin` confirm → `signedIn(identity)`;
 * - `auth.logout` confirm → `signedOut()`.
 *
 * LOGOUT has two transports depending on the auth mode (pre-migration
 * use-app-auth :53-62, preserved): GitHub desktop sessions sign out through
 * the bridge (`githubAuth.signOut`), password/host sessions through REST
 * `logout`.
 *
 * GITHUB DEVICE FLOW MODELING (`auth.githubLogin`): the flow is a phase
 * state machine (checking → idle → starting → waiting), and only the
 * start+settle segment is an operation. The VIEW owns the phases and the
 * cancel affordance; the operation wraps `githubAuth.start()` →
 * `githubAuth.finish()`:
 * - `start()` failure rejects with the `GitHubAuthError` code as the run
 *   error (the view maps it to `login.github.error.*`);
 * - on `start()` success the executor calls the input's `onAuthorization`
 *   callback so the view can render the device code and enter `waiting`
 *   WHILE the run is still pending;
 * - `finish()` resolves the run: `signedIn` on success, the error code on
 *   failure.
 * - CANCEL is honest: the view calls `githubAuth.cancel()` directly (a
 *   bridge call, Phase 4 bridge-gate scope) and invalidates the attempt; the
 *   in-flight `finish()` then settles the run failed with `'cancelled'`,
 *   which the view ignores for the stale attempt. `getState()` is a
 *   bootstrap query (inventory §3), not an operation.
 */
import type { GitHubDeviceAuthorization, GitHubUserProfile } from '@gian/shared';

import { login, logout } from '../api.js';
import { desktopBridge } from '../desktop-bridge.js';
import { toast } from '../feedback.js';
import { registry } from './registry.js';
import type { OperationDefinition } from './types.js';

/** The settled app identity (the operation layer's name for what
 *  `use-app-auth` re-exports as `AppIdentity`). */
export type AuthIdentity =
  | { provider: 'github'; user: GitHubUserProfile }
  | { provider: 'host'; username: string };

/** Single auth entity — one auth session, one in-flight auth operation. */
export const AUTH_ENTITY_KEY = 'auth:current';

/** REST login/logout are quick; expiry marks the outcome unknown (§4.3). */
const REST_TIMEOUT_MS = 15_000;
/** The device flow waits on the USER authorizing in a browser; GitHub device
 *  codes live ~15 minutes. */
const DEVICE_FLOW_TIMEOUT_MS = 900_000;

/** Marker thrown when the host rejects the password — the view maps it back
 *  to `login.error.invalid` (any other error renders as a network failure). */
export const AUTH_INVALID_CREDENTIALS = 'auth.invalid';

export interface AuthSink {
  signedIn(identity: AuthIdentity): void;
  signedOut(): void;
}

let authSink: AuthSink | null = null;

export function wireAuthSink(sink: AuthSink | null): void {
  authSink = sink;
}

const authLogin: OperationDefinition<{ username: string; password: string }, { user: string }> = {
  policy: 'pending',
  entityKey: () => AUTH_ENTITY_KEY,
  execute: async input => {
    const result = await login(input.username, input.password);
    if (!result) throw new Error(AUTH_INVALID_CREDENTIALS);
    return result;
  },
  reconcile: result => authSink?.signedIn({ provider: 'host', username: result.user }),
  // The login view renders the run's error inline — no toast.
  timeoutMs: REST_TIMEOUT_MS,
};

const authLogout: OperationDefinition<{ provider: AuthIdentity['provider'] }> = {
  policy: 'pending',
  entityKey: () => AUTH_ENTITY_KEY,
  execute: async input => {
    const githubAuth = desktopBridge()?.githubAuth;
    if (input.provider === 'github' && githubAuth) {
      await githubAuth.signOut();
    } else {
      await logout();
    }
  },
  reconcile: () => authSink?.signedOut(),
  rollback: error => toast({ kind: 'error', message: error.message }),
  timeoutMs: REST_TIMEOUT_MS,
};

export interface GitHubLoginInput {
  /** Called with the device authorization as soon as `start()` succeeds so
   *  the view can show the code while the run stays pending. */
  onAuthorization(authorization: GitHubDeviceAuthorization): void;
}

const authGithubLogin: OperationDefinition<GitHubLoginInput, GitHubUserProfile> = {
  policy: 'pending',
  entityKey: () => AUTH_ENTITY_KEY,
  execute: async input => {
    const githubAuth = desktopBridge()?.githubAuth;
    if (!githubAuth) throw new Error('network');
    const started = await githubAuth.start().catch(() => ({ ok: false as const, error: 'network' as const }));
    if (!started.ok) throw new Error(started.error);
    input.onAuthorization(started.authorization);
    const finished = await githubAuth.finish().catch(() => ({ ok: false as const, error: 'network' as const }));
    if (!finished.ok) throw new Error(finished.error);
    return finished.user;
  },
  reconcile: user => authSink?.signedIn({ provider: 'github', user }),
  // The login view renders the run's error inline — no toast.
  timeoutMs: DEVICE_FLOW_TIMEOUT_MS,
};

registry.register('auth.login', authLogin);
registry.register('auth.logout', authLogout);
registry.register('auth.githubLogin', authGithubLogin);
