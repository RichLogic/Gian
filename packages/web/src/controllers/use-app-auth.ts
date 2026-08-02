import { useCallback, useEffect, useState } from 'react';
import type { GitHubUserProfile } from '@gian/shared';
import { logout as hostLogout, whoAmI } from '../api.js';
import { desktopBridge } from '../desktop-bridge.js';

export type AppAuthStatus = 'checking' | 'login' | 'authenticated';
export type AppIdentity =
  | { provider: 'github'; user: GitHubUserProfile }
  | { provider: 'host'; username: string };

/**
 * Resolve the HTTP login before the realtime client starts. Password-backed
 * deployments otherwise open a socket with an empty token and reconnect
 * forever without ever rendering the login form.
 */
export function useAppAuth() {
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

  const onLoginOk = useCallback((nextIdentity: AppIdentity) => {
    setIdentity(nextIdentity);
    setStatus('authenticated');
  }, []);

  const signOut = useCallback(async () => {
    const githubAuth = desktopBridge()?.githubAuth;
    if (identity?.provider === 'github' && githubAuth) {
      await githubAuth.signOut();
    } else {
      await hostLogout();
    }
    setIdentity(null);
    setStatus('login');
  }, [identity]);

  return { status, identity, onLoginOk, signOut };
}
