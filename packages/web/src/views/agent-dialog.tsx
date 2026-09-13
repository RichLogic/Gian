import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
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
  agents,
  initialPluginId,
  busy,
  error,
  onPickHome,
  onSubmit,
  onClose,
}: {
  integrations: ProxyCatalogItem[];
  agents: UserAgentStatus[];
  initialPluginId?: string;
  busy: boolean;
  error: string;
  onPickHome: () => Promise<string | null>;
  onSubmit: (input: CreateAgentDialogInput) => void;
  onClose: () => void;
}) {
  const t = useT();
  const initial = integrations.some(item => item.pluginId === initialPluginId)
    ? initialPluginId!
    : integrations[0]?.pluginId ?? '';
  const [pluginId, setPluginId] = useState(initial);
  const [homeMode, setHomeMode] = useState<'managed' | 'custom'>('managed');
  const [customHome, setCustomHome] = useState('');
  const [homeSupported, setHomeSupported] = useState(true);
  const [checkingHome, setCheckingHome] = useState(false);

  useEffect(() => {
    if (integrations.some(item => item.pluginId === pluginId)) return;
    setPluginId(integrations[0]?.pluginId ?? '');
  }, [integrations, pluginId]);

  useEffect(() => {
    let alive = true;
    setHomeMode('managed');
    setCustomHome('');
    const executor = productExecutorForPluginId(pluginId);
    if (!executor) {
      setHomeSupported(true);
      setCheckingHome(false);
      return () => { alive = false; };
    }
    setCheckingHome(true);
    void loadAgentDraftDefaults(executor)
      .then(defaults => { if (alive) setHomeSupported(defaults.home !== null); })
      .catch(() => { if (alive) setHomeSupported(true); })
      .finally(() => { if (alive) setCheckingHome(false); });
    return () => { alive = false; };
  }, [pluginId]);

  const selected = integrations.find(item => item.pluginId === pluginId) ?? null;
  const customValid = homeMode !== 'custom' || customHome.trim().length > 0;
  const createDisabled = busy || checkingHome || !selected || !customValid;

  function create() {
    if (createDisabled || !selected) return;
    onSubmit({
      pluginId: selected.pluginId,
      name: nextAgentName(selected.displayName, agents),
      ...(homeSupported
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
            <span className="field-hint">{t('agents.add.dialog.installedOnly')}</span>
          </div>
          {integrations.length > 0 ? (
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

        <div className="field">
          <div className="field-lbl">
            <span>HOME Path</span>
            <span className="field-hint">{t('agents.add.dialog.homeFixed')}</span>
          </div>
          {!homeSupported ? (
            <input className="input" aria-label="HOME Path"
                   value={t('agents.home.external')} disabled />
          ) : (
            <>
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
