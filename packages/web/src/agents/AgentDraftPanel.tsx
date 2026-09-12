import type { ManagedRuntimeStatus, ProxyCatalogItem, UserAgentStatus } from '@gian/shared';
import { useT } from '../i18n/index.js';
import { AgentLogo } from '../components/AgentLogo.js';

export interface AgentDraftState {
  name: string;
  /** null keeps Gian's freshly-created managed HOME. */
  customHome: string | null;
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18" /><path d="m6 6 12 12" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" /><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" />
    </svg>
  );
}

export function AgentDraftPanel({
  draft,
  draftError,
  item,
  runtime,
  developmentFallback,
  homeSupported,
  showBack,
  busy,
  onChange,
  onPickHome,
  onOpenProxy,
  onSave,
  onClose,
}: {
  draft: AgentDraftState;
  draftError: 'empty' | 'taken' | null;
  item: ProxyCatalogItem;
  runtime: ManagedRuntimeStatus | null;
  developmentFallback?: UserAgentStatus;
  homeSupported: boolean;
  showBack: boolean;
  busy: boolean;
  onChange: (draft: AgentDraftState) => void;
  onPickHome: () => Promise<string | null>;
  onOpenProxy: () => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const active = runtime?.active ?? null;
  const cliPath = active?.runtime?.entryPath ?? developmentFallback?.cli.path ?? null;
  const cliVersion = active?.runtime?.version ?? developmentFallback?.cli.version ?? null;
  const proxyVersion = active?.proxy.pluginVersion
    ?? developmentFallback?.plugin.version
    ?? item.installation.installedVersion
    ?? item.installation.latestVersion;
  const custom = draft.customHome !== null;
  const installsRuntime = !active && item.availableActions.includes('install_runtime');
  const defaultHome = t('agents.home.draftDefault').replace('{pluginId}', item.pluginId);

  return (
    <>
      <div className="p2-head">
        {showBack && (
          <button type="button" className="btn icon ghost" aria-label={t('agents.detail.back')}
                  onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
        )}
        <AgentLogo proxy={null} logo={item.logo} fallback={item.displayName} size={28} />
        <span className="p2-title">{t('agents.draft.newAgent')}</span>
        <span className="spacer" />
        <button type="button" className="btn icon ghost" aria-label={t('agents.detail.close')}
                onClick={onClose}>
          <CloseIcon />
        </button>
      </div>

      <div className="p2-body">
        <section className="ag-sec">
          <span className="s2-subhead">{t('settings.agents.name')}</span>
          <input
            className={`input ${draftError === 'taken' ? 'bad' : ''}`}
            value={draft.name}
            spellCheck={false}
            aria-label={t('settings.agents.name')}
            disabled={busy}
            onChange={event => onChange({ ...draft, name: event.target.value })}
          />
          <span className="hint">{t('agents.draft.nameHelp')}</span>
          {draftError === 'taken' && (
            <span className="field-error">{t('settings.agents.nameTaken')}</span>
          )}
        </section>

        <section className="ag-sec">
          <dl className="kv-grid">
            <dt>{t('settings.agents.proxy')}</dt>
            <dd>
              <span className="rt-line">
                <AgentLogo proxy={null} logo={item.logo} fallback={item.displayName} size={20} />
                <span className="catalog-name">{item.displayName}</span>
                <button type="button" className="btn icon ghost compact"
                        title={t('agents.detail.viewInCatalog')}
                        aria-label={t('agents.detail.viewInCatalog')}
                        onClick={onOpenProxy}>
                  <InfoIcon />
                </button>
              </span>
              <span className="mono hint">{item.pluginId}</span>
              <span className="hint">{t('agents.draft.proxyLocked')}</span>
            </dd>

            <dt>{t('agents.runtime.combination')}</dt>
            <dd>
              {active || (developmentFallback?.ready ?? false) ? (
                <>
                  <span className="mono">
                    {t('agents.runtime.cliVersion').replace('{version}', cliVersion ?? '—')}
                    {' · '}
                    {t('agents.runtime.proxyVersion').replace('{version}', proxyVersion ?? '—')}
                  </span>
                  <span className="hint">
                    {active ? t('agents.runtime.managedHelp') : t('agents.runtime.developmentHelp')}
                  </span>
                </>
              ) : (
                <>
                  <span>{t('agents.runtime.notInstalled')}</span>
                  <span className="hint">
                    {t('agents.runtime.notInstalledHelp')}
                    {proxyVersion ? ` ${t('agents.runtime.proxyVersion').replace('{version}', proxyVersion)}.` : ''}
                  </span>
                </>
              )}
            </dd>

            <dt>{cliPath ? t('agents.runtime.cliPath') : t('agents.runtime.installLocation')}</dt>
            <dd>
              {cliPath ? (
                <span className="rt-line">
                  <span className="cli-path-val" title={cliPath}>{cliPath}</span>
                  <button type="button" className="btn icon ghost compact"
                          title={t('common.copy')} aria-label={t('common.copy')}
                          onClick={() => { void navigator.clipboard?.writeText(cliPath); }}>
                    <CopyIcon />
                  </button>
                </span>
              ) : (
                <>
                  <span className="mono">~/.gian/runtimes</span>
                  <span className="hint">{t('agents.runtime.installLocationHelp')}</span>
                </>
              )}
            </dd>

            {homeSupported ? (
              <>
                <dt>HOME</dt>
                <dd>
                  <div className="sec-line">
                    {custom ? (
                      <div className="cli-path-row">
                        <input className="input mono" value={draft.customHome ?? ''}
                               placeholder="/absolute/path/to/home"
                               aria-label={t('agents.home.custom')} disabled={busy}
                               onChange={event => onChange({ ...draft, customHome: event.target.value })} />
                        <button type="button" className="btn xs secondary" disabled={busy}
                                onClick={() => { void onPickHome().then(path => {
                                  if (path) onChange({ ...draft, customHome: path });
                                }); }}>
                          {t('settings.agents.browse')}
                        </button>
                      </div>
                    ) : (
                      <span className="mono cli-path-val">{defaultHome}</span>
                    )}
                    <span className="hint">
                      {custom ? t('agents.home.customHelp') : t('agents.home.defaultHelp')}
                    </span>
                    <label className="home-custom">
                      <input type="checkbox" checked={custom} disabled={busy}
                             onChange={event => onChange({
                               ...draft,
                               customHome: event.target.checked ? (draft.customHome ?? '') : null,
                             })} />
                      {t('agents.home.useCustom')}
                    </label>
                  </div>
                </dd>
              </>
            ) : (
              <>
                <dt>{t('agents.home.state')}</dt>
                <dd>
                  <span>{t('agents.home.external')}</span>
                  <span className="hint">{t('agents.home.externalHelp')}</span>
                </dd>
              </>
            )}
          </dl>
        </section>
      </div>

      <div className="p2-foot">
        <span className="spacer" />
        <button type="button" className="btn sm ghost" disabled={busy} onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button type="button" className="btn sm primary" data-testid="agent-draft-save"
                disabled={busy || draftError !== null || (custom && !(draft.customHome?.trim()))}
                onClick={onSave}>
          {t(installsRuntime ? 'agents.draft.installAndCreate' : 'agents.draft.save')}
        </button>
      </div>
    </>
  );
}
