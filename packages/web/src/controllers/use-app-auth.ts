import { useCallback, useEffect, useState } from 'react';
import { whoAmI } from '../api.js';

export type AppAuthStatus = 'checking' | 'login' | 'authenticated';

/**
 * Resolve the HTTP login before the realtime client starts. Password-backed
 * deployments otherwise open a socket with an empty token and reconnect
 * forever without ever rendering the login form.
 */
export function useAppAuth() {
  const [status, setStatus] = useState<AppAuthStatus>('checking');

  useEffect(() => {
    let cancelled = false;
    void whoAmI().then(user => {
      if (!cancelled) setStatus(user ? 'authenticated' : 'login');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const onLoginOk = useCallback(() => {
    setStatus('authenticated');
  }, []);

  return { status, onLoginOk };
}
