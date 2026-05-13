import { useEffect, useRef, useState } from 'react';
import type { CcModelCapabilities, CodexModelCapabilities, SystemConfig } from '@gian/shared';
import { loadProxyModels, saveSettings, changePassword, logout } from '../api.js';
import { useT } from '../i18n/index.js';

const SAVE_DEBOUNCE_MS = 500;

const ACCENT_PRESETS: { key: string; bg: string }[] = [
  { key: 'plum',  bg: 'oklch(0.55 0.13 310)' },
  { key: 'moss',  bg: 'oklch(0.58 0.10 150)' },
  { key: 'ink',   bg: 'oklch(0.55 0.11 255)' },
  { key: 'ember', bg: 'oklch(0.62 0.13 30)'  },
];

const THEME_SWATCHES: Record<SystemConfig['theme'], [string, string, string]> = {
  light: ['#f2f2f6', '#fff', 'oklch(0.55 0.13 310)'],
  warm:  ['oklch(0.955 0.020 80)', 'oklch(0.990 0.012 82)', 'oklch(0.52 0.13 310)'],
  dark:  ['oklch(0.165 0.012 250)', 'oklch(0.24 0.016 250)', 'oklch(0.72 0.13 310)'],
};

export function SettingsPanel({
  open,
  onClose,
  config,
  onChange,
  onLogout,
}: {
  open: boolean;
  onClose: () => void;
  config: SystemConfig | null;
  onChange: (updated: SystemConfig) => void;
  onLogout?: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<Partial<SystemConfig>>({});
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // AUTH password change state
  const [pwOpen, setPwOpen] = useState(false);
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [pwSaving, setPwSaving] = useState(false);
  const [pwStatus, setPwStatus] = useState<'idle' | 'ok' | 'error'>('idle');

  const draftRef = useRef(draft);
  draftRef.current = draft;

  // Auto-save with debounce. Each draft change resets the timer; flush after
  // SAVE_DEBOUNCE_MS of quiescence.
  useEffect(() => {
    if (!Object.keys(draft).length) return;
    const handle = setTimeout(async () => {
      const pending = draftRef.current;
      if (!Object.keys(pending).length) return;
      setSaving(true);
      const updated = await saveSettings(pending);
      setSaving(false);
      if (updated) {
        setDraft({});
        setSavedAt(Date.now());
        onChange(updated);
        setTimeout(() => setSavedAt(null), 2000);
      }
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [draft, onChange]);

  if (!open) return null;

  const merged: SystemConfig | null = config ? { ...config, ...draft } : null;

  function field<K extends keyof SystemConfig>(key: K): SystemConfig[K] | undefined {
    return merged ? merged[key] : undefined;
  }

  function set<K extends keyof SystemConfig>(key: K, value: SystemConfig[K]) {
    setDraft(d => ({ ...d, [key]: value }));
  }

  async function handleSignOut() {
    await logout();
    if (onLogout) onLogout();
    else window.location.reload();
  }

  async function handleChangePassword() {
    if (!currentPw || !newPw) return;
    setPwSaving(true);
    setPwStatus('idle');
    const result = await changePassword(currentPw, newPw);
    setPwSaving(false);
    if ('ok' in result) {
      setPwStatus('ok');
      setCurrentPw('');
      setNewPw('');
      setTimeout(() => {
        setPwStatus('idle');
        setPwOpen(false);
      }, 1800);
    } else {
      setPwStatus('error');
    }
  }

  const username = field('auth_username') ?? '';
  const initial = (username.trim().charAt(0) || 'R').toUpperCase();
  const tunnelMode = field('tunnel_mode') ?? 'none';
  const forceHttps = field('force_https') ?? false;

  return (
    <div className="settings-overlay" onClick={onClose}>
      <aside className="settings-panel" onClick={e => e.stopPropagation()}>
        <div className="sheet-body">

          {/* Header */}
          <header className="sheet-head">
            <h2 className="sheet-title">{t('settings.title')}</h2>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              {savedAt && <span className="sheet-saved">{t('settings.saved')}</span>}
              {saving && <span className="sheet-saved" style={{ color: 'var(--text-3)' }}>{t('settings.saving')}</span>}
              <button className="btn ghost sm icon" onClick={onClose} title={t('settings.close')}>
                <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                  <path d="M3 3l6 6M9 3l-6 6" />
                </svg>
              </button>
            </div>
          </header>

          {/* Account */}
          <section className="sheet-section">
            <div className="sheet-lbl">{t('settings.section.account')}</div>
            <div className="account-card">
              <div className="account-av">{initial}</div>
              <div className="account-body">
                <div className="account-name">{username || 'guest'}</div>
                <div className="account-role">{t('settings.account.role')}</div>
              </div>
              <button className="btn secondary sm" onClick={() => void handleSignOut()}>
                {t('settings.account.signout')}
              </button>
            </div>
          </section>

          {/* Theme */}
          <section className="sheet-section">
            <div className="sheet-lbl">{t('settings.section.theme')}</div>
            <div className="theme-picker">
              {(['light', 'warm', 'dark'] as SystemConfig['theme'][]).map(th => {
                const [c1, c2, c3] = THEME_SWATCHES[th];
                return (
                  <button
                    key={th}
                    className={`theme-chip${field('theme') === th ? ' active' : ''}`}
                    onClick={() => set('theme', th)}
                  >
                    <span className="theme-swatch">
                      <i style={{ background: c1 }} />
                      <i style={{ background: c2 }} />
                      <i style={{ background: c3 }} />
                    </span>
                    <span>{t(`settings.theme.${th}` as 'settings.theme.light')}</span>
                  </button>
                );
              })}
            </div>
          </section>

          {/* Accent */}
          <section className="sheet-section">
            <div className="sheet-lbl">{t('settings.section.accent')}</div>
            <div className="accent-picker">
              {ACCENT_PRESETS.map(a => (
                <button
                  key={a.key}
                  className={`accent-swatch${field('accent') === a.key ? ' active' : ''}`}
                  style={{ background: a.bg }}
                  onClick={() => set('accent', a.key)}
                  title={a.key}
                />
              ))}
            </div>
          </section>

          {/* System · runner */}
          <section className="sheet-section">
            <div className="sheet-lbl">{t('settings.section.system')}</div>
            <div className="kv-grid">
              <div className="field">
                <label className="field-lbl">
                  {t('settings.host.label')}
                  <span className="field-hint">{t('settings.host.hint')}</span>
                </label>
                <input className="input" type="text" value={field('host') ?? ''} disabled />
              </div>
              <div className="field">
                <label className="field-lbl">
                  {t('settings.port.label')}
                  <span className="field-hint">{t('settings.port.hint')}</span>
                </label>
                <input className="input" type="text" value={String(field('port') ?? '')} disabled />
              </div>
            </div>
            <div className="field">
              <label className="field-lbl">{t('settings.wsroot.label')}</label>
              <input
                className="input"
                type="text"
                value={field('workspace_root') ?? ''}
                onChange={e => set('workspace_root', e.target.value)}
              />
            </div>
            <div className="field">
              <label className="field-lbl">{t('settings.datadir.label')}</label>
              <input className="input" type="text" value="~/.config/gian" disabled />
            </div>
          </section>

          {/* Executors */}
          <section className="sheet-section">
            <div className="sheet-lbl">{t('settings.section.executor')}</div>
            <div className="kv-grid">
              <div className="field">
                <label className="field-lbl">
                  {t('settings.codexbin.label')}
                  <span className="field-hint">GIAN_CODEX_BIN</span>
                </label>
                <input
                  className="input"
                  type="text"
                  value={(import.meta.env['GIAN_CODEX_BIN'] as string | undefined) ?? 'from PATH'}
                  disabled
                />
              </div>
              <div className="field">
                <label className="field-lbl">{t('settings.codexver.label')}</label>
                <input className="input" type="text" value="—" disabled />
              </div>
              <div className="field">
                <label className="field-lbl">
                  {t('settings.ccbin.label')}
                  <span className="field-hint">GIAN_CC_BIN</span>
                </label>
                <input
                  className="input"
                  type="text"
                  value={(import.meta.env['GIAN_CC_BIN'] as string | undefined) ?? 'from PATH'}
                  disabled
                />
              </div>
              <div className="field">
                <label className="field-lbl">{t('settings.ccver.label')}</label>
                <input className="input" type="text" value="—" disabled />
              </div>
            </div>
          </section>

          {/* Default model + effort for new sessions */}
          <ExecutorDefaultsSection field={field} set={set} />

          {/* Auth */}
          <section className="sheet-section">
            <div className="sheet-lbl">{t('settings.section.auth')}</div>
            <div className="kv-grid">
              <div className="field">
                <label className="field-lbl">{t('settings.authuser.label')}</label>
                <input
                  className="input"
                  type="text"
                  value={field('auth_username') ?? ''}
                  onChange={e => set('auth_username', e.target.value)}
                />
              </div>
              <div className="field">
                <label className="field-lbl">{t('settings.authpass.label')}</label>
                <input
                  className="input"
                  type="text"
                  value="••••••••"
                  readOnly
                  onClick={() => setPwOpen(o => !o)}
                  style={{ cursor: 'pointer' }}
                />
              </div>
            </div>
            {pwOpen && (
              <div className="kv-grid" style={{ marginTop: 4 }}>
                <div className="field">
                  <label className="field-lbl">{t('settings.auth.currentpw.label')}</label>
                  <input
                    className="input"
                    type="password"
                    placeholder={t('settings.auth.currentpw.placeholder')}
                    value={currentPw}
                    onChange={e => { setCurrentPw(e.target.value); setPwStatus('idle'); }}
                    autoComplete="current-password"
                  />
                </div>
                <div className="field">
                  <label className="field-lbl">{t('settings.auth.newpw.label')}</label>
                  <input
                    className="input"
                    type="password"
                    placeholder={t('settings.auth.newpw.placeholder')}
                    value={newPw}
                    onChange={e => { setNewPw(e.target.value); setPwStatus('idle'); }}
                    autoComplete="new-password"
                  />
                </div>
                <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <button
                    className="btn primary sm"
                    disabled={!currentPw || !newPw || pwSaving}
                    onClick={() => void handleChangePassword()}
                  >
                    {pwSaving ? t('settings.auth.changepw.saving') : t('settings.auth.changepw')}
                  </button>
                  {pwStatus === 'ok' && (
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--ok)' }}>
                      {t('settings.auth.changepw.saved')}
                    </span>
                  )}
                  {pwStatus === 'error' && (
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--danger)' }}>
                      {t('settings.auth.changepw.error')}
                    </span>
                  )}
                </div>
              </div>
            )}
            <div className="field-hint">{t('settings.auth.hint')}</div>
          </section>

          {/* Density */}
          <section className="sheet-section">
            <div className="sheet-lbl">{t('settings.section.density')}</div>
            <div className="segm" style={{ width: 'fit-content' }}>
              {(['compact', 'cozy', 'roomy'] as SystemConfig['density'][]).map(d => (
                <button
                  key={d}
                  className={`segm-item${field('density') === d ? ' active' : ''}`}
                  onClick={() => set('density', d)}
                >
                  {t(`settings.density.${d}` as 'settings.density.compact')}
                </button>
              ))}
            </div>
          </section>

          {/* Language */}
          <section className="sheet-section">
            <div className="sheet-lbl">{t('settings.section.language')}</div>
            <div className="segm" style={{ width: 'fit-content' }}>
              {(
                [
                  ['zh-CN', '中文 (zh-CN)'],
                  ['en', 'English'],
                ] as [SystemConfig['locale'], string][]
              ).map(([val, label]) => (
                <button
                  key={val}
                  className={`segm-item${field('locale') === val ? ' active' : ''}`}
                  onClick={() => set('locale', val)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="field-hint">{t('settings.language.hint')}</div>
          </section>

          {/* Public access */}
          <section className="sheet-section">
            <div className="sheet-lbl">{t('settings.section.remote')}</div>
            <div className="field">
              <label className="field-lbl">{t('settings.publicurl.label')}</label>
              <input
                className="input"
                type="text"
                placeholder="https://..."
                value={field('public_url') ?? ''}
                onChange={e => set('public_url', e.target.value)}
              />
              <div className="field-hint">{t('settings.publicurl.hint')}</div>
            </div>
            <div className="field">
              <label className="field-lbl">{t('settings.tunnel.label')}</label>
              <div className="segm" style={{ width: 'fit-content' }}>
                {(
                  [
                    ['none', t('settings.tunnel.none')],
                    ['cloudflare-tunnel', t('settings.tunnel.cloudflare')],
                    ['tailscale-funnel', t('settings.tunnel.tailscale')],
                    ['reverse-proxy', t('settings.tunnel.reverseproxy')],
                  ] as [SystemConfig['tunnel_mode'], string][]
                ).map(([val, label]) => (
                  <button
                    key={val}
                    className={`segm-item${tunnelMode === val ? ' active' : ''}`}
                    onClick={() => set('tunnel_mode', val)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="kv-grid">
              <div className="field">
                <label className="field-lbl">{t('settings.tunnelid.label')}</label>
                <input
                  className="input"
                  type="text"
                  value={field('tunnel_id') ?? ''}
                  onChange={e => set('tunnel_id', e.target.value)}
                />
              </div>
              <div className="field">
                <label className="field-lbl">{t('settings.forcehttps.label')}</label>
                <div className="segm" style={{ width: 'fit-content' }}>
                  <button
                    className={`segm-item${forceHttps ? ' active' : ''}`}
                    onClick={() => set('force_https', true)}
                  >
                    {t('settings.forcehttps.on')}
                  </button>
                  <button
                    className={`segm-item${!forceHttps ? ' active' : ''}`}
                    onClick={() => set('force_https', false)}
                  >
                    {t('settings.forcehttps.off')}
                  </button>
                </div>
              </div>
            </div>
            <div className="field-hint">{t('settings.remote.hint')}</div>
          </section>

        </div>
      </aside>
    </div>
  );
}

function ExecutorDefaultsSection({
  field,
  set,
}: {
  field: <K extends keyof SystemConfig>(k: K) => SystemConfig[K] | undefined;
  set: <K extends keyof SystemConfig>(k: K, v: SystemConfig[K]) => void;
}) {
  const t = useT();
  const [ccModels, setCcModels] = useState<CcModelCapabilities[]>([]);
  const [codexModels, setCodexModels] = useState<CodexModelCapabilities[]>([]);

  useEffect(() => {
    let alive = true;
    void loadProxyModels('claude').then(list => {
      if (!alive) return;
      setCcModels(list as CcModelCapabilities[]);
    });
    void loadProxyModels('codex').then(list => {
      if (!alive) return;
      setCodexModels(list as CodexModelCapabilities[]);
    });
    return () => { alive = false; };
  }, []);

  const ccModelName = (field('default_claude_model') ?? '').trim();
  const ccModelMeta = ccModels.find(m => m.model === ccModelName);
  const ccSupportedEfforts = ccModelMeta?.supportedEfforts ?? [];
  const ccEffortValue = field('default_claude_effort') ?? '';

  const codexModelName = (field('default_codex_model') ?? '').trim();
  const codexModelMeta = codexModels.find(m => m.model === codexModelName);
  const codexSupportedEfforts = codexModelMeta?.supportedThinking ?? [];
  const codexEffortValue = field('default_codex_effort') ?? '';

  return (
    <section className="sheet-section">
      <div className="sheet-lbl">{t('settings.section.defaults')}</div>

      <div className="kv-grid">
        <div className="field">
          <label className="field-lbl">{t('settings.defaults.ccmodel.label')}</label>
          <select
            className="select"
            value={ccModelName}
            onChange={e => {
              set('default_claude_model', e.target.value);
              const next = ccModels.find(m => m.model === e.target.value);
              if (!next || next.supportedEfforts.length === 0) {
                set('default_claude_effort', '');
              } else if (ccEffortValue && !next.supportedEfforts.includes(ccEffortValue as never)) {
                set('default_claude_effort', '');
              }
            }}
          >
            <option value="">{t('settings.defaults.usedefault')}</option>
            {ccModels.filter(m => !m.hidden).map(m => (
              <option key={m.id} value={m.model}>{m.displayName || m.model}</option>
            ))}
          </select>
        </div>

        {ccSupportedEfforts.length > 0 && (
          <div className="field">
            <label className="field-lbl">{t('settings.defaults.cceffort.label')}</label>
            <select
              className="select"
              value={ccEffortValue}
              onChange={e => set('default_claude_effort', e.target.value)}
            >
              <option value="">{t('settings.defaults.usedefault')}</option>
              {ccSupportedEfforts.map(level => (
                <option key={level} value={level}>{level}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="kv-grid">
        <div className="field">
          <label className="field-lbl">{t('settings.defaults.codexmodel.label')}</label>
          <select
            className="select"
            value={codexModelName}
            onChange={e => {
              set('default_codex_model', e.target.value);
              const next = codexModels.find(m => m.model === e.target.value);
              if (!next || next.supportedThinking.length === 0) {
                set('default_codex_effort', '');
              } else if (codexEffortValue && !next.supportedThinking.includes(codexEffortValue as never)) {
                set('default_codex_effort', '');
              }
            }}
          >
            <option value="">{t('settings.defaults.usedefault')}</option>
            {codexModels.filter(m => !m.hidden).map(m => (
              <option key={m.id} value={m.model}>{m.displayName || m.model}</option>
            ))}
          </select>
        </div>

        {codexSupportedEfforts.length > 0 && (
          <div className="field">
            <label className="field-lbl">{t('settings.defaults.codexeffort.label')}</label>
            <select
              className="select"
              value={codexEffortValue}
              onChange={e => set('default_codex_effort', e.target.value)}
            >
              <option value="">{t('settings.defaults.usedefault')}</option>
              {codexSupportedEfforts.map(level => (
                <option key={level} value={level}>{level}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="field-hint">{t('settings.defaults.hint')}</div>
    </section>
  );
}
