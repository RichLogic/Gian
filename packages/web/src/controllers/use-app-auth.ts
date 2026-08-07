import { useCallback, useEffect, useState } from 'react';
import { whoAmI } from '../api.js';
import { desktopBridge } from '../desktop-bridge.js';
import { wireAuthSink, type AuthIdentity } from '../operations/auth.js';
import type { OperationDispatcher } from '../operations/dispatcher.js';

export type AppAuthStatus = 'checking' | 'login' | 'authenticated';
export type AppIdentity = AuthIdentity;

/**
 * Resolve the HTTP login before the realtime client starts. Password-backed
 * deployments otherwise open a socket with an empty token and reconnect
 * forever without ever rendering the login form.
 *
 * Phase 3b (UI Operation Layer): `signOut` dispatches the `auth.logout`
 * operation (REST for host sessions, the desktop bridge for GitHub sessions
 * — the definition picks per provider); login/logout state transitions
 * arrive through the auth sink, wired here because this hook owns the
 * status/identity state. Takes the dispatcher as a parameter — App creates
 * it before calling this hook.
 */
export function useAppAuth(dispatch: OperationDispatcher['dispatch']) {
  const [status, setStatus] = useState<AppAuthStatus>('checking');
  const [identity, setIdentity] = useState<AppIdentity | null>(null);

  useEffect(() => {
    let cancelled = false;
    const githubAuth = desktopBridge()?.githubAuth;
    if (githubAuth) {
      void githubAuth.getState().then(state => {
        if (cancelled) return;
        if (state.status === 'signed_in') {
          setIdentity({ provider: 'github', user: state.user });
          setStatus('authenticated');
          return;
        }
        setIdentity(null);
        setStatus('login');
      }).catch(() => {
        if (!cancelled) setStatus('login');
      });
    } else {
      void whoAmI().then(user => {
        if (cancelled) return;
        setIdentity(user ? { provider: 'host', username: user.user } : null);
        setStatus(user ? 'authenticated' : 'login');
      });
    }
    return () => {
      cancelled = true;
    };
  }, []);

  // Settled auth operations land here (see operations/auth.ts).
  useEffect(() => {
    wireAuthSink({
      signedIn: next => {
        setIdentity(next);
        setStatus('authenticated');
      },
      signedOut: () => {
        setIdentity(null);
        setStatus('login');
      },
    });
    return () => wireAuthSink(null);
  }, []);

  const signOut = useCallback(() => {
    dispatch('auth.logout', { provider: identity?.provider ?? 'host' });
  }, [dispatch, identity]);

  return { status, identity, signOut };
}
