import { useEffect, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { cancelGitHubAuthorization, getGitHubAuthorization, retryGitHubAuthorization,
  subscribeGitHubAuthorization } from '../auth/github-authorization.js';
import { useT } from '../i18n/index.js';
import { DialogShell } from '../views/workspace-dialog.js';
import { GitHubDeviceAuthorization } from './GitHubDeviceAuthorization.js';

export function GitHubAuthorizationHost({ login }: { login?: string }) {
  const t = useT();
  const state = useSyncExternalStore(subscribeGitHubAuthorization, getGitHubAuthorization, getGitHubAuthorization);
  useEffect(() => () => cancelGitHubAuthorization(), []);
  if (!state) return null;
  return createPortal(<div data-github-authorization-layer style={{ position: 'fixed', inset: 0, zIndex: 1400 }}>
    <DialogShell title={t('login.github.reauthorize')} busy={false}
    onClose={() => cancelGitHubAuthorization(state.id)}>
    {login && <p className="s2-help">GitHub: {login}</p>}
    <p className="s2-help" style={{ overflowWrap: 'anywhere' }}>{state.serverUrl}</p>
    {state.authorization ? <GitHubDeviceAuthorization authorization={state.authorization}
      onCancel={() => cancelGitHubAuthorization(state.id)} retrying={state.retrying} openAgain={false} /> : <>
      {state.error && <p className="login-error" role="alert">{t(`login.github.error.${state.error}`)}</p>}
      {state.phase === 'checking' && <p role="status">{t('login.github.starting')}</p>}
      <div className="rs-actions">
        <button type="button" className="btn ghost" onClick={() => cancelGitHubAuthorization(state.id)}>{t('common.cancel')}</button>
        {state.phase === 'error' && <button type="button" className="btn primary"
          onClick={() => retryGitHubAuthorization(state.id)}>{t('login.github.submit')}</button>}
      </div>
    </>}
  </DialogShell></div>, document.body);
}
