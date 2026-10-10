import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  executorIdForPluginId,
  productExecutorForPluginId,
  type ProxyCatalogItem,
  type UserAgentStatus,
} from '@gian/shared';
import { loadAgentDraftDefaults } from '../api.js';
import { AgentLogo } from '../components/AgentLogo.js';
import { useT } from '../i18n/index.js';
import { DialogShell } from './workspace-dialog.js';

export interface CreateAgentDialogInput {
  pluginId: string;
  name: string;
  home?: { kind: 'managed' } | { kind: 'custom'; path: string };
  /** ADR-0102: present only for Custom integrations; the Host probes the path
   *  before persisting the Agent. */
  runtime?: { kind: 'custom'; path: string };
}

/** Sentinel value of the Integration <select> for the Custom mode (ADR-0102):
 *  the user supplies the Runtime and HOME; the Proxy stays an installed
 *  Integration. Never a real pluginId. */
export const CUSTOM_INTEGRATION = '__custom__';

/** Field-scoped create errors, keyed by the input that caused them. The Host
 *  error codes map here: RUNTIME_* → runtime, AGENT_HOME_* → home. */
export interface AgentDialogFieldErrors {
  runtime?: string;
  home?: string;
}

function nextAgentName(base: string, agents: UserAgentStatus[]): string {
  const taken = new Set(agents.map(agent => agent.name.trim().toLowerCase()));
  if (!taken.has(base.trim().toLowerCase())) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export function AgentDialog({
  integrations,
  customIntegrations = integrations,
  agents,
  initialPluginId,
  busy,
  error,
  fieldErrors,
  onPickHome,
  onPickRuntime,
  onSubmit,
  onClose,
}: {
  integrations: ProxyCatalogItem[];
  customIntegrations?: ProxyCatalogItem[];
  agents: UserAgentStatus[];
  initialPluginId?: string;
  busy: boolean;
  error: string;
  fieldErrors?: AgentDialogFieldErrors;
  onPickHome: () => Promise<string | null>;
  onPickRuntime: () => Promise<string | null>;
  onSubmit: (input: CreateAgentDialogInput) => void;
  onClose: () => void;
}) {
  const t = useT();
  const initial = initialPluginId === CUSTOM_INTEGRATION
    || integrations.some(item => item.pluginId === initialPluginId)
    ? initialPluginId!
    : integrations[0]?.pluginId ?? CUSTOM_INTEGRATION;
  const [pluginId, setPluginId] = useState(initial);
  const [homeMode, setHomeMode] = useState<'default' | 'managed' | 'custom'>('managed');
  const [customHome, setCustomHome] = useState('');
  const [defaultHome, setDefaultHome] = useState('');
  const [homeSupported, setHomeSupported] = useState(true);
  const [checkingHome, setCheckingHome] = useState(false);
  // Custom mode (ADR-0102): the Proxy is one of the installed Integrations;
  // Runtime/HOME are user-provided paths. Typed paths survive a Proxy switch
  // (owner design 2026-09-30) — they are re-validated on submit instead.
  const [customProxyId, setCustomProxyId] = useState(customIntegrations[0]?.pluginId ?? '');
  const [runtimePath, setRuntimePath] = useState('');

  const isCustom = pluginId === CUSTOM_INTEGRATION;

  useEffect(() => {
    if (pluginId === CUSTOM_INTEGRATION) return;
    if (integrations.some(item => item.pluginId === pluginId)) return;
    setPluginId(integrations[0]?.pluginId ?? CUSTOM_INTEGRATION);
  }, [integrations, pluginId]);

  useEffect(() => {
    if (customProxyId && customIntegrations.some(item => item.pluginId === customProxyId)) return;
    setCustomProxyId(customIntegrations[0]?.pluginId ?? '');
  }, [customIntegrations, customProxyId]);

  useEffect(() => {
    let alive = true;
    // Custom mode keeps the typed HOME across Proxy switches; the
    // managed/default radios only exist for plain Integrations.
    if (isCustom) {
      setHomeMode('managed');
      setDefaultHome('');
      setHomeSupported(true);
      setCheckingHome(false);
      return () => { alive = false; };
    }
    setHomeMode('managed');
    setCustomHome('');
    setDefaultHome('');
    const executor = executorIdForPluginId(pluginId);
    if (!executor) {
      setHomeSupported(true);
      setCheckingHome(false);
      return () => { alive = false; };
    }
    setCheckingHome(true);
    void loadAgentDraftDefaults(executor)
      .then(defaults => {
        if (!alive) return;
        setHomeSupported(defaults.home !== null);
        const path = defaults.home?.path ?? '';
        setDefaultHome(path);
        setHomeMode(path && !agents.some(agent => agent.home?.path === path)
          ? 'default' : 'managed');
      })
      .catch(() => { if (alive) setHomeSupported(true); })
      .finally(() => { if (alive) setCheckingHome(false); });
    return () => { alive = false; };
  }, [pluginId, isCustom]);

  const selected = isCustom
    ? customIntegrations.find(item => item.pluginId === customProxyId) ?? null
    : integrations.find(item => item.pluginId === pluginId) ?? null;
  const customRuntimeValid = runtimePath.trim().startsWith('/');
  const customHomeValid = customHome.trim().startsWith('/');
  const customValid = homeMode !== 'custom' || customHome.trim().length > 0;
  const defaultHomeInUse = agents.some(agent => agent.home?.path === defaultHome);
  const createDisabled = busy || checkingHome || !selected || !customValid
    || (isCustom && (!customRuntimeValid || !customHomeValid))
    || (!isCustom && homeMode === 'default' && (!defaultHome || defaultHomeInUse));

  function create() {
    if (createDisabled || !selected) return;
    if (isCustom) {
      onSubmit({
        pluginId: selected.pluginId,
        name: nextAgentName(selected.displayName, agents),
        home: { kind: 'custom', path: customHome.trim() },
        runtime: { kind: 'custom', path: runtimePath.trim() },
      });
      return;
    }
    onSubmit({
      pluginId: selected.pluginId,
      name: nextAgentName(selected.displayName, agents),
      ...(homeSupported && homeMode !== 'default'
        ? { home: homeMode === 'managed'
          ? { kind: 'managed' as const }
          : { kind: 'custom' as const, path: customHome.trim() } }
        : {}),
    });
  }

  return createPortal(
    <DialogShell title={t('agents.add.dialog.title')} busy={busy} onClose={onClose}>
      <div className="wsn-form" data-testid="agent-create-dialog">
        <div className="field">
          <div className="field-lbl">
            <span>{t('agents.integration')}</span>
            <span className="field-hint">{t(isCustom
              ? 'agents.add.dialog.customHint'
              : 'agents.add.dialog.installedOnly')}</span>
          </div>
          {integrations.length > 0 || customIntegrations.length > 0 ? (
            <select
              className="select"
              aria-label={t('agents.integration')}
              value={pluginId}
              disabled={busy}
              autoFocus
              onChange={event => setPluginId(event.target.value)}
            >
              {integrations.map(item => (
                <option key={item.pluginId} value={item.pluginId}>{item.displayName}</option>
              ))}
              <option value={CUSTOM_INTEGRATION}>{t('agents.add.dialog.custom')}</option>
            </select>
          ) : (
            <p className="s2-help">{t('agents.add.dialog.noneInstalled')}</p>
          )}
          {selected && (
            <span className="rt-line">
              <AgentLogo proxy={null} logo={selected.logo} fallback={selected.displayName} size={20} />
              <span className="hint">{selected.tagline}</span>
            </span>
          )}
        </div>

        {isCustom && (
          <>
            <div className="field">
              <div className="field-lbl">
                <span>{t('agents.add.dialog.customProxy')}</span>
                <span className="field-hint">{t('agents.add.dialog.customProxyHint')}</span>
              </div>
              <select
                className="select"
                aria-label={t('agents.add.dialog.customProxy')}
                value={customProxyId}
                disabled={busy}
                onChange={event => setCustomProxyId(event.target.value)}
              >
                {customIntegrations.map(item => (
                  <option key={item.pluginId} value={item.pluginId}>{item.displayName}</option>
                ))}
              </select>
            </div>

            <div className="field">
              <div className="field-lbl">
                <span>{t('agents.add.dialog.runtimePath')}</span>
                <span className="field-hint">{t('agents.add.dialog.runtimePathHint')}</span>
              </div>
              <div className="wsn-row">
                <input className="input mono" aria-label={t('agents.add.dialog.runtimePath')}
                       value={runtimePath} disabled={busy}
                       placeholder="/absolute/path/to/runtime"
                       onChange={event => setRuntimePath(event.target.value)}
                       onKeyDown={event => { if (event.key === 'Enter') create(); }} />
                <button type="button" className="btn sm secondary" disabled={busy}
                        onClick={() => { void onPickRuntime().then(path => {
                          if (path) setRuntimePath(path);
                        }); }}>
                  {t('settings.agents.browse')}
                </button>
              </div>
              {fieldErrors?.runtime && <p className="field-error" role="alert">{fieldErrors.runtime}</p>}
            </div>
          </>
        )}

        <div className="field">
          <div className="field-lbl">
            <span>HOME Path</span>
            <span className="field-hint">{t(isCustom
              ? 'agents.add.dialog.customHomeHint'
              : 'agents.add.dialog.homeFixed')}</span>
          </div>
          {isCustom ? (
            <>
              <div className="wsn-row">
                <input className="input mono" aria-label="HOME Path"
                       value={customHome} disabled={busy}
                       placeholder="/absolute/path/to/home"
                       onChange={event => setCustomHome(event.target.value)}
                       onKeyDown={event => { if (event.key === 'Enter') create(); }} />
                <button type="button" className="btn sm secondary" disabled={busy}
                        onClick={() => { void onPickHome().then(path => {
                          if (path) setCustomHome(path);
                        }); }}>
                  {t('settings.agents.browse')}
                </button>
              </div>
              {fieldErrors?.home && <p className="field-error" role="alert">{fieldErrors.home}</p>}
            </>
          ) : !homeSupported ? (
            <input className="input" aria-label="HOME Path"
                   value={t('agents.home.external')} disabled />
          ) : (
            <>
              {defaultHome && (
                <>
                  <label className="home-custom">
                    <input type="radio" name="agent-home-mode" value="default"
                           checked={homeMode === 'default'} disabled={busy || checkingHome || defaultHomeInUse}
                           onChange={() => setHomeMode('default')} />
                    {t('agents.add.dialog.defaultHome')} <span className="mono">{defaultHome}</span>
                  </label>
                  {defaultHomeInUse && <p className="s2-help">{t('agents.add.dialog.defaultInUse')}</p>}
                </>
              )}
              <label className="home-custom">
                <input type="radio" name="agent-home-mode" value="managed"
                       checked={homeMode === 'managed'} disabled={busy || checkingHome}
                       onChange={() => setHomeMode('managed')} />
                {t('agents.add.dialog.newHome')}
              </label>
              <label className="home-custom">
                <input type="radio" name="agent-home-mode" value="custom"
                       checked={homeMode === 'custom'} disabled={busy || checkingHome}
                       onChange={() => setHomeMode('custom')} />
                {t('agents.add.dialog.existingHome')}
              </label>
              {homeMode === 'custom' && (
                <div className="wsn-row">
                  <input className="input mono" aria-label="HOME Path"
                         value={customHome} disabled={busy}
                         placeholder="/absolute/path/to/home"
                         onChange={event => setCustomHome(event.target.value)}
                         onKeyDown={event => { if (event.key === 'Enter') create(); }} />
                  <button type="button" className="btn sm secondary" disabled={busy}
                          onClick={() => { void onPickHome().then(path => {
                            if (path) setCustomHome(path);
                          }); }}>
                    {t('settings.agents.browse')}
                  </button>
                </div>
              )}
              {homeMode === 'custom' && productExecutorForPluginId(pluginId) === 'zcode'
                && <p className="s2-help">{t('agents.add.dialog.zcodeHomeHelp')}</p>}
            </>
          )}
        </div>

        {error && <p className="spaces-error" role="alert">{error}</p>}
        <div className="wsn-actions">
          <button type="button" className="btn sm ghost" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn sm primary" data-testid="agent-create-save"
                  disabled={createDisabled} onClick={create}>
            {busy ? t('agents.add.dialog.creating') : t('agents.add.dialog.create')}
          </button>
        </div>
      </div>
    </DialogShell>,
    document.body,
  );
}
