import { useEffect, useState } from 'react';
import type { GitHubDeviceAuthorization as Authorization } from '@gian/shared';
import { useT } from '../i18n/index.js';

/** Shared by initial Gian sign-in and App-owned account confirmation. */
export function GitHubDeviceAuthorization({ authorization, onCancel, retrying = false, openAgain = true }: {
  authorization: Authorization; onCancel(): void; retrying?: boolean; openAgain?: boolean;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [authorization.userCode]);
  async function copyCode() {
    try { await navigator.clipboard.writeText(authorization.userCode); setCopied(true); }
    catch { setCopied(false); }
  }
  return <div className="login-device">
    <p>{t('login.github.code.help')}</p>
    <button className="login-device-code" type="button" onClick={() => void copyCode()}
      aria-label={t('login.github.code.copy')}>{authorization.userCode}</button>
    <span className="login-device-copy" role="status">
      {t(retrying ? 'login.github.retrying' : copied ? 'login.github.code.copied' : 'login.github.waiting')}
    </span>
    <a href={authorization.verificationUri} target="_blank" rel="noreferrer">{t(openAgain ? 'login.github.openAgain' : 'login.github.open')}</a>
    <button className="login-cancel" type="button" onClick={onCancel}>{t('common.cancel')}</button>
  </div>;
}
