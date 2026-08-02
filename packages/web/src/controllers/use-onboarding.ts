import { useCallback, useEffect, useState } from 'react';
import type { OnboardingState } from '@gian/shared';
import { loadOnboarding } from '../api.js';
import { desktopBridge } from '../desktop-bridge.js';
import type { AppAuthStatus } from './use-app-auth.js';

export type OnboardingStatus = 'checking' | 'required' | 'complete';

export function useOnboarding(authStatus: AppAuthStatus) {
  const [status, setStatus] = useState<OnboardingStatus>('checking');
  const [state, setState] = useState<OnboardingState | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    if (!desktopBridge()?.githubAuth) {
      setState(null);
      setStatus('complete');
      setError('');
      return;
    }
    setStatus('checking');
    try {
      const next = await loadOnboarding();
      setState(next);
      setStatus(next.completed ? 'complete' : 'required');
      setError('');
    } catch (value) {
      setStatus('required');
      setError(value instanceof Error ? value.message : String(value));
    }
  }, []);

  useEffect(() => {
    if (authStatus !== 'authenticated') {
      setStatus('checking');
      setState(null);
      setError('');
      return;
    }
    void refresh();
  }, [authStatus, refresh]);

  const complete = useCallback((next: OnboardingState) => {
    setState(next);
    setError('');
    setStatus('complete');
  }, []);

  return { status, state, error, refresh, complete };
}
