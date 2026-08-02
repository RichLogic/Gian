import { useEffect, useState } from 'react';
import type {
  AgentInstallStatus,
  AgentProxyDefaults,
  Executor,
  ExternalEditor,
  OpenFileCategory,
  ProxyCapabilities,
  SystemConfig,
} from '@gian/shared';
import { THEME_DEFAULT_ACCENT } from '@gian/shared';
import {
  installAgentCli,
  installAgentProxy,
  loadAgents,
  loadProxyCapabilities,
  resetOnboarding,
  saveSettings,
  setAgentCliPath,
  setAgentProxyDefaults,
} from '../api.js';
import { useMinimapEnabled, setMinimapEnabled } from '../display-prefs.js';
import { AppIcon } from './AppIcon.js';
import { DEFAULT_OPEN_TARGET } from './sheet-model.js';
import { useT } from '../i18n/index.js';
import type { AppIdentity } from '../controllers/use-app-auth.js';

const OPEN_CATEGORIES: Array<{ key: OpenFileCategory; labelKey: string }> = [
  { key: 'code', labelKey: 'settings.openapps.code' },
  { key: 'web', labelKey: 'settings.openapps.web' },
  { key: 'images', labelKey: 'settings.openapps.images' },
  { key: 'pdf', labelKey: 'settings.openapps.pdf' },
  { key: 'other', labelKey: 'settings.openapps.other' },
];
import {
  browserNotificationPermission,
  loadNotificationPrefs,
  requestDesktopNotificationPermission,
  saveNotificationPrefs,
  type BrowserNotificationPermission,
  type NotificationPrefs,
} from '../notifications.js';

export type NavKey = 'appearance' | 'notifications' | 'shortcuts' | 'executors' | 'openwith' | 'account';

/** Left-nav groups (locator). `labelKey` is an i18n key; `items` map a
 *  section anchor id (`sec-<key>`) to its nav label key. */
const NAV_GROUPS: Array<{
  labelKey: string;
  items: Array<[NavKey, string]>;
}> = [
  {
    labelKey: 'settings.nav.group.preferences',
    items: [
      ['appearance', 'settings.section.appearance'],
      ['notifications', 'settings.section.notifications'],
      ['shortcuts', 'settings.section.shortcuts'],
    ],
  },
  {
    labelKey: 'settings.nav.group.runtime',
    items: [
      ['executors', 'settings.section.executor'],
      ['openwith', 'settings.section.openwith'],
    ],
  },
  {
    labelKey: 'settings.nav.group.account',
    items: [['account', 'settings.section.account']],
  },
];

function newEditorId(): string {
  return (globalThis.crypto?.randomUUID?.() ?? `ed-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function editorsEqual(a: ExternalEditor[], b: ExternalEditor[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!, y = b[i]!;
    if (x.id !== y.id || x.name !== y.name || x.command !== y.command) return false;
    if (x.args.length !== y.args.length) return false;
    for (let j = 0; j < x.args.length; j++) {
      if (x.args[j] !== y.args[j]) return false;
    }
  }
  return true;
}

interface Props {
  config: SystemConfig | null;
  /** Installed apps (macOS) for the "Add application" picker. */
  apps?: string[];
  onChange: (cfg: SystemConfig) => void;
  /** Which section to render — controlled by App (driven by the panel-3
   *  SettingsNavInspector; the state survives rail collapse/restore).
  *  Defaults to 'appearance'. */
  activeSection?: NavKey;
  identity?: AppIdentity | null;
  onSignOut?: () => Promise<void>;
}

/** Settings v3 — single-section switcher (dock Settings rail, phase 4).
 *  The nav lives in panel 3 (SettingsNavInspector); this panel-2 body renders
 *  ONLY the active section. Account is included because desktop GitHub login
 *  is part of first-run initialization; unrelated Public/System/About panels
 *  stay out of this compact workbench surface. */
export function SettingsBody({
  config,
  apps,
  onChange,
  activeSection = 'appearance',
  identity = null,
  onSignOut,
}: Props) {
  const t = useT();
  if (!config) return <div style={{ padding: 20, color: 'var(--text-3)' }}>{t('common.loading')}</div>;
  return (
    <SettingsBodyInner
      config={config}
      apps={apps ?? []}
      onChange={onChange}
      activeSection={activeSection}
      identity={identity}
      onSignOut={onSignOut}
    />
  );
}

function SettingsBodyInner({
  config, apps, onChange, activeSection, identity, onSignOut,
}: {
  config: SystemConfig;
  apps: string[];
  onChange: (cfg: SystemConfig) => void;
  activeSection: NavKey;
  identity: AppIdentity | null;
  onSignOut?: () => Promise<void>;
}) {
  const t = useT();
  const minimapOn = useMinimapEnabled();
  const [editors, setEditors] = useState<ExternalEditor[]>(config.external_editors);

  // Sync local editor state when config is replaced from outside (e.g. initial load).
  useEffect(() => {
    setEditors(config.external_editors);
  }, [config.external_editors]);

  // Debounced auto-save: schedule a patch 500ms after the user stops typing.
  // Skip when local matches prop (initial mount, post-sync).
  useEffect(() => {
    if (editorsEqual(editors, config.external_editors)) return;
    const handle = setTimeout(() => {
      void saveSettings({ external_editors: editors }).then(cfg => { if (cfg) onChange(cfg); });
    }, 500);
    return () => clearTimeout(handle);
  }, [editors, config.external_editors, onChange]);

  function patch(partial: Partial<SystemConfig>) {
    void saveSettings(partial).then(cfg => { if (cfg) onChange(cfg); });
  }

  function patchEditors(next: ExternalEditor[]) {
    setEditors(next);
  }

  // "Default apps" (below) picks from the curated "Open with" list — the apps
  // the user added above — plus the two built-in system targets (@newtab /
  // @finder). It deliberately does NOT offer the full scanned app catalog.
  const editorAppNames = [...new Set(editors.map(e => e.name.trim()).filter(Boolean))];

  return (
    <div className="settings2" data-testid="settings-body">
      <div className="settings2-main">
        {/* ── Appearance ── */}
        {activeSection === 'appearance' && (
        <section className="s2-section">
          <h3 className="s2-sectiontitle">{t('settings.section.appearance')}</h3>
          <div className="s2-card">
            <dl className="kv-grid">
              <dt>{t('settings.appearance.theme')}</dt>
              <dd>
                <div className="theme-row">
                  {([
                    ['light', 'settings.theme.light', ['oklch(0.955 0.004 280)', 'oklch(0.935 0.005 280)', 'oklch(0.22 0.02 280)']],
                    ['warm', 'settings.theme.warm', ['oklch(0.955 0.020 80)', 'oklch(0.925 0.022 78)', 'oklch(0.30 0.04 55)']],
                    ['dark', 'settings.theme.dark', ['oklch(0.165 0.012 250)', 'oklch(0.240 0.016 250)', 'oklch(0.93 0.01 250)']],
                  ] as const).map(([key, labelKey, swatches]) => (
                    <button key={key} className={`theme-chip ${config.theme === key ? 'active' : ''}`}
                            onClick={() => patch({ theme: key, accent: THEME_DEFAULT_ACCENT[key] })}>
                      <div className="swatches">{swatches.map((c, i) => <i key={i} style={{ background: c }} />)}</div>
                      <div className="name">{t(labelKey)}</div>
                    </button>
                  ))}
                </div>
              </dd>
              <dt>{t('settings.appearance.accent')}</dt>
              <dd>
                <div className="accent-row">
                  {([
                    ['rose',   'Rose',   'oklch(0.55 0.15   5)'],
                    ['ember',  'Ember',  'oklch(0.55 0.14  35)'],
                    ['citron', 'Citron', 'oklch(0.55 0.13  95)'],
                    ['moss',   'Moss',   'oklch(0.55 0.11 150)'],
                    ['teal',   'Teal',   'oklch(0.55 0.11 195)'],
                    ['azure',  'Azure',  'oklch(0.55 0.13 230)'],
                    ['ink',    'Ink',    'oklch(0.55 0.13 270)'],
                    ['plum',   'Plum',   'oklch(0.55 0.14 320)'],
                  ] as const).map(([k, name, c]) => (
                    <button key={k} className={`accent-swatch ${config.accent === k ? 'active' : ''}`}
                            style={{ background: c }}
                            title={name}
                            onClick={() => patch({ accent: k })}>
                      <span className="accent-name">{name}</span>
                    </button>
                  ))}
                </div>
              </dd>
              <dt>{t('settings.appearance.density')}</dt>
              <dd>
                <div className="segm">
                  {(['compact', 'cozy', 'roomy'] as const).map(d => (
                    <button key={d} className={`segm-item ${config.density === d ? 'active' : ''}`}
                            onClick={() => patch({ density: d })}>
                      {t(`settings.density.${d}`)}
                    </button>
                  ))}
                </div>
              </dd>
              <dt>{t('settings.appearance.language')}</dt>
              <dd>
                <div className="segm">
                  {([
                    ['zh-CN', 'settings.language.zh'],
                    ['en', 'settings.language.en'],
                  ] as const).map(([locale, labelKey]) => (
                    <button
                      key={locale}
                      className={`segm-item ${config.locale === locale ? 'active' : ''}`}
                      onClick={() => patch({ locale })}
                    >
                      {t(labelKey)}
                    </button>
                  ))}
                </div>
              </dd>
              <dt>{t('settings.appearance.fontInterface')}</dt>
              <dd>
                <div className="segm">
                  {(['sm', 'md', 'lg', 'xl'] as const).map(s => (
                    <button key={s} className={`segm-item ${config.font_scale_chrome === s ? 'active' : ''}`}
                            onClick={() => patch({ font_scale_chrome: s })}>
                      {s.toUpperCase()}
                    </button>
                  ))}
                </div>
              </dd>
              <dt>{t('settings.appearance.fontTranscript')}</dt>
              <dd>
                <div className="segm">
                  {(['sm', 'md', 'lg', 'xl'] as const).map(s => (
                    <button key={s} className={`segm-item ${config.font_scale_chat === s ? 'active' : ''}`}
                            onClick={() => patch({ font_scale_chat: s })}>
                      {s.toUpperCase()}
                    </button>
                  ))}
                </div>
              </dd>
              <dt>{t('settings.appearance.fontCode')}</dt>
              <dd>
                <div className="segm">
                  {(['sm', 'md', 'lg', 'xl'] as const).map(s => (
                    <button key={s} className={`segm-item ${config.font_scale_code === s ? 'active' : ''}`}
                            onClick={() => patch({ font_scale_code: s })}>
                      {s.toUpperCase()}
                    </button>
                  ))}
                </div>
              </dd>
              <dt>{t('settings.appearance.fontFamily')}</dt>
              <dd className="mono" style={{ color: 'var(--text-3)' }}>Instrument Sans · JetBrains Mono</dd>
              <dt>{t('settings.display.minimap')}</dt>
              <dd>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={minimapOn}
                    onChange={e => setMinimapEnabled(e.target.checked)}
                  />
                  <span>{t('settings.display.minimap.hint')}</span>
                </label>
              </dd>
            </dl>
          </div>
        </section>
        )}

        {/* ── Notifications ── */}
        {activeSection === 'notifications' && (
        <section className="s2-section">
          <h3 className="s2-sectiontitle">{t('settings.section.notifications')}</h3>
          <div className="s2-card">
            <NotificationsBlock />
          </div>
        </section>
        )}

        {/* ── Shortcuts ── */}
        {activeSection === 'shortcuts' && (
        <section className="s2-section">
          <h3 className="s2-sectiontitle">{t('settings.section.shortcuts')}</h3>
          <div className="s2-card">
            <dl className="kv-grid shortcuts">
              <dt>{t('settings.shortcuts.commandPalette')}</dt><dd><kbd>⌘</kbd><kbd>⇧</kbd><kbd>K</kbd></dd>
              <dt>{t('settings.shortcuts.steerOrSendNow')}</dt><dd><kbd>⌘</kbd><kbd>⏎</kbd></dd>
              <dt>{t('settings.shortcuts.createClaudeChild')}</dt><dd><kbd>⌘</kbd><kbd>J</kbd></dd>
              <dt>{t('settings.shortcuts.createCodexChild')}</dt><dd><kbd>⌘</kbd><kbd>K</kbd></dd>
              <dt>{t('settings.shortcuts.markUnread')}</dt><dd><kbd>⌘</kbd><kbd>U</kbd></dd>
              <dt>{t('settings.shortcuts.approveDecline')}</dt><dd><kbd>⏎</kbd>&nbsp;<kbd>⌫</kbd></dd>
            </dl>
          </div>
        </section>
        )}

        {/* ── Executors ── */}
        {activeSection === 'executors' && (
        <section className="s2-section">
          <h3 className="s2-sectiontitle">{t('settings.section.executor')}</h3>
          <div className="s2-card">
            <AgentInstallBlock />
            <div className="s2-taskpm">
              <div className="s2-taskpm-head">
                <span className="s2-taskpm-label">{t('settings.executors.taskDefault')}</span>
                <div className="segm">
                  {(['claude', 'codex', 'kimi'] as const).map(ex => (
                    <button
                      key={ex}
                      className={`segm-item ${config.default_task_executor === ex ? 'active' : ''}`}
                      onClick={() => patch({ default_task_executor: ex })}
                    >
                      {ex === 'claude' ? 'Claude' : ex === 'codex' ? 'Codex' : 'Kimi'}
                    </button>
                  ))}
                </div>
              </div>
              <p className="s2-help">{t('settings.executors.taskDefault.help')}</p>
            </div>
          </div>
        </section>
        )}

        {/* ── Open with (merged: external editors + default app by file type) ── */}
        {activeSection === 'openwith' && (
        <section className="s2-section">
          <h3 className="s2-sectiontitle">{t('settings.section.openwith')}</h3>
          <div className="s2-card">
            <p className="s2-help">{t('settings.openwith.help')}</p>

            <div className="s2-subhead">{t('settings.openwith.applications')}</div>
            <div className="ee-list">
              {editors.length === 0 && (
                <p className="settings-empty">{t('settings.editors.empty')}</p>
              )}
              {editors.map(ed => (
                <div key={ed.id} className="ee-app-row">
                  <span className="ee-app-name"><AppIcon name={ed.name} /> {ed.name || ed.id}</span>
                  <button
                    type="button"
                    aria-label={t('settings.editors.remove')}
                    className="ee-remove"
                    onClick={() => patchEditors(editors.filter(x => x.id !== ed.id))}
                  >
                    ✕
                  </button>
                </div>
              ))}
              {apps.length > 0 && (
                <label className="ee-add-app">
                  <span className="rfc-lbl">{t('settings.editors.addApp')}</span>
                  <select
                    aria-label={t('settings.editors.addApp')}
                    value=""
                    onChange={e => {
                      const app = e.target.value;
                      if (!app) return;
                      // A picked app is stored as an opener that shells out via
                      // `open -a "<App>" <path>` (host buildEditorArgs substitutes {path}).
                      patchEditors([
                        ...editors,
                        { id: newEditorId(), name: app, command: 'open', args: ['-a', app, '{path}'] },
                      ]);
                      e.target.value = '';
                    }}
                  >
                    <option value="">{t('settings.editors.addApp.placeholder')}</option>
                    {apps.filter(a => !editors.some(ed => ed.name === a)).map(a => <option key={a} value={a}>{a}</option>)}
                  </select>
                </label>
              )}
            </div>

            <div className="s2-subhead">{t('settings.openwith.defaults')}</div>
            <div className="openapps">
              {OPEN_CATEGORIES.map(({ key, labelKey }) => {
                const cur = (config.open_apps?.[key]) || DEFAULT_OPEN_TARGET[key];
                // Options = the curated "Open with" apps only. Keep the current value
                // selectable even if it's not in that list (a built-in default like
                // TextEdit, or an app the user has since removed from "Open with").
                const appOpts = cur.startsWith('@') || editorAppNames.includes(cur)
                  ? editorAppNames
                  : [cur, ...editorAppNames];
                return (
                  <div key={key} className="open-cat-row">
                    <span className="open-cat-label">{t(labelKey)}</span>
                    <span className="open-cat-pick">
                      {cur === '@newtab'
                        ? <span className="app-icon app-icon-newtab" aria-hidden>↗</span>
                        : <AppIcon name={cur === '@finder' ? 'Finder' : cur} />}
                      <select
                        aria-label={t(labelKey)}
                        value={cur}
                        onChange={e => patch({ open_apps: { ...(config.open_apps ?? {}), [key]: e.target.value } })}
                      >
                        <option value="@newtab">{t('settings.openapps.newtab')}</option>
                        <option value="@finder">{t('settings.openapps.finder')}</option>
                        {appOpts.map(a => <option key={a} value={a}>{a}</option>)}
                      </select>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
        )}

        {activeSection === 'account' && (
        <section className="s2-section">
          <h3 className="s2-sectiontitle">{t('settings.section.account')}</h3>
          <div className="s2-card">
            <AccountBlock identity={identity} onSignOut={onSignOut} />
          </div>
        </section>
        )}
      </div>
    </div>
  );
}

function AccountBlock({
  identity,
  onSignOut,
}: {
  identity: AppIdentity | null;
  onSignOut?: () => Promise<void>;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [resettingSetup, setResettingSetup] = useState(false);
  const githubUser = identity?.provider === 'github' ? identity.user : null;
  const displayName = githubUser
    ? githubUser.name || githubUser.login
    : identity?.provider === 'host'
      ? identity.username
      : t('settings.account.signedIn');

  async function signOut() {
    if (!onSignOut) return;
    setBusy(true);
    try {
      await onSignOut();
    } finally {
      setBusy(false);
    }
  }

  async function restartSetup() {
    setResettingSetup(true);
    try {
      await resetOnboarding();
      window.location.reload();
    } finally {
      setResettingSetup(false);
    }
  }

  return (
    <div className="settings-account">
      <div className="settings-account-user">
        {githubUser ? (
          <img
            className="settings-account-avatar"
            src={githubUser.avatarUrl}
            alt=""
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="settings-account-avatar settings-account-avatar-fallback" aria-hidden>G</div>
        )}
        <div>
          <div className="settings-account-name">{displayName}</div>
          {githubUser && (
            <a href={githubUser.profileUrl} target="_blank" rel="noreferrer">
              @{githubUser.login}
            </a>
          )}
        </div>
      </div>
      <p className="s2-help">{t('settings.account.local')}</p>
      {githubUser && (
        <button
          className="btn secondary"
          type="button"
          disabled={busy || resettingSetup}
          onClick={() => void restartSetup()}
        >
          {resettingSetup ? t('settings.account.reconfiguring') : t('settings.account.reconfigure')}
        </button>
      )}
      <button
        className="btn danger-ghost"
        type="button"
        disabled={busy || resettingSetup || !onSignOut}
        onClick={() => void signOut()}
      >
        {busy ? t('settings.account.signingOut') : t('settings.account.signOut')}
      </button>
    </div>
  );
}

function AgentInstallBlock() {
  const t = useT();
  const [agents, setAgents] = useState<AgentInstallStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Executor | null>(null);
  const [error, setError] = useState('');

  async function refresh() {
    setLoading(true);
    try {
      setAgents(await loadAgents());
      setError('');
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function run(id: Executor, operation: () => Promise<unknown>) {
    setBusy(id);
    setError('');
    try {
      await operation();
      await refresh();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(null);
    }
  }

  async function setup(agent: AgentInstallStatus) {
    await run(agent.id, async () => {
      if (agent.proxy.state !== 'ready') await installAgentProxy(agent.id);
      if (agent.cli.state !== 'ready') await installAgentCli(agent.id);
    });
  }

  if (loading && agents.length === 0) {
    return <p className="s2-help">{t('settings.agents.loading')}</p>;
  }

  return (
    <>
      <p className="s2-help">{t('settings.agents.help')}</p>
      {agents.map(agent => (
        <AgentInstallRow
          key={agent.id}
          agent={agent}
          busy={busy === agent.id}
          onSetup={() => setup(agent)}
          onInstallCli={() => run(agent.id, () => installAgentCli(agent.id))}
          onInstallProxy={() => run(agent.id, () => installAgentProxy(agent.id))}
          onSetPath={path => run(agent.id, () => setAgentCliPath(agent.id, path))}
          onSetDefaults={defaults => run(
            agent.id,
            () => setAgentProxyDefaults(agent.id, defaults),
          )}
        />
      ))}
      {error && <p className="s2-help" role="alert">{error}</p>}
    </>
  );
}

function AgentInstallRow({
  agent,
  busy,
  onSetup,
  onInstallCli,
  onInstallProxy,
  onSetPath,
  onSetDefaults,
}: {
  agent: AgentInstallStatus;
  busy: boolean;
  onSetup: () => void;
  onInstallCli: () => void;
  onInstallProxy: () => void;
  onSetPath: (path: string | null) => void;
  onSetDefaults: (defaults: Partial<AgentProxyDefaults>) => void;
}) {
  const t = useT();
  const [path, setPath] = useState(agent.cli.path ?? '');
  const [capabilities, setCapabilities] = useState<ProxyCapabilities | null>(null);
  const [capabilityError, setCapabilityError] = useState(false);
  useEffect(() => setPath(agent.cli.path ?? ''), [agent.cli.path]);
  useEffect(() => {
    let alive = true;
    setCapabilities(null);
    setCapabilityError(false);
    if (agent.proxy.state !== 'ready') return () => { alive = false; };
    loadProxyCapabilities(agent.id)
      .then(value => {
        if (alive) setCapabilities(value);
      })
      .catch(() => {
        if (alive) setCapabilityError(true);
      });
    return () => { alive = false; };
  }, [agent.id, agent.proxy.state, agent.proxy.version]);

  const defaults = agent.proxy.defaults ?? { model: '', thinking: '', mode: '' };
  const models = capabilities?.models.filter(model => !model.hidden) ?? [];
  const selectedModel = models.find(model => model.model === defaults.model)
    ?? models.find(model => model.isDefault)
    ?? models[0];
  const thinkingLevels = selectedModel
    ? ('supportedEfforts' in selectedModel
        ? selectedModel.supportedEfforts
        : selectedModel.supportedThinking)
    : [];
  const modes = capabilities?.modes ?? [];
  const selectedMode = modes.some(mode => mode.id === defaults.mode)
    ? defaults.mode
    : modes.find(mode => mode.isDefault)?.id ?? modes[0]?.id ?? '';

  const state = agent.ready
    ? { cls: 'ok', label: t('settings.agents.ready') }
    : { cls: 'err', label: t('settings.agents.setupRequired') };

  return (
    <div className="exec-row">
      <div className="exec-head">
        <span className={`exec-dot ${agent.id}`} />
        <span className="exec-name">{agent.name}</span>
        <span className={`exec-status ${state.cls}`}>{state.label}</span>
        {!agent.ready && (
          <button className="btn xs primary" type="button" disabled={busy} onClick={onSetup}>
            {busy ? t('settings.agents.installing') : t('settings.agents.setup')}
          </button>
        )}
      </div>
      <dl className="kv-grid">
        <dt>CLI</dt>
        <dd>
          {agent.cli.state === 'ready'
            ? `${agent.cli.version ?? ''} · ${agent.cli.path ?? ''}`
            : t('settings.agents.notInstalled')}
          {agent.cli.state !== 'ready' && (
            <button className="btn xs secondary" type="button" disabled={busy} onClick={onInstallCli}>
              {t('settings.agents.installOfficial')}
            </button>
          )}
        </dd>
        <dt>{t('settings.agents.cliPath')}</dt>
        <dd>
          <input
            className="input mono"
            value={path}
            disabled={busy}
            placeholder="/absolute/path/to/cli"
            onChange={event => setPath(event.target.value)}
          />
          <button
            className="btn xs secondary"
            type="button"
            disabled={busy || path.trim() === (agent.cli.path ?? '')}
            onClick={() => onSetPath(path.trim() || null)}
          >
            {t('settings.agents.savePath')}
          </button>
        </dd>
        <dt>Proxy</dt>
        <dd>
          {agent.proxy.state === 'ready'
            ? `${agent.proxy.version ?? ''} · GitHub`
            : t('settings.agents.notInstalled')}
          {agent.proxy.state !== 'ready' && (
            <button className="btn xs secondary" type="button" disabled={busy} onClick={onInstallProxy}>
              {t('settings.agents.installProxy')}
            </button>
          )}
        </dd>
        {models.length > 0 && (
          <>
            <dt>{t('settings.executors.defaultModel')}</dt>
            <dd>
              <select
                className="select mono"
                style={{ width: '100%' }}
                value={defaults.model}
                disabled={busy || !capabilities}
                onChange={event => {
                  const model = event.target.value;
                  const nextModel = models.find(candidate => candidate.model === model)
                    ?? models.find(candidate => candidate.isDefault)
                    ?? models[0];
                  const supported = nextModel
                    ? ('supportedEfforts' in nextModel
                        ? nextModel.supportedEfforts
                        : nextModel.supportedThinking)
                    : [];
                  onSetDefaults({
                    model,
                    ...(defaults.thinking && !supported.includes(defaults.thinking)
                      ? { thinking: '' }
                      : {}),
                  });
                }}
              >
                <option value="">{t('settings.executors.proxyDefault')}</option>
                {models.filter(model => model.model !== '').map(model => (
                  <option key={model.id} value={model.model}>
                    {model.displayName || model.model}
                  </option>
                ))}
              </select>
            </dd>
          </>
        )}
        {thinkingLevels.length > 0 && (
          <>
            <dt>{agent.id === 'claude'
              ? t('settings.executors.effort')
              : t('settings.executors.thinking')}</dt>
            <dd>
              <select
                className="select mono"
                style={{ width: '100%' }}
                value={defaults.thinking}
                disabled={busy || !capabilities}
                onChange={event => onSetDefaults({ thinking: event.target.value })}
              >
                <option value="">{t('settings.executors.modelDefault')}</option>
                {thinkingLevels.map(level => (
                  <option key={level} value={level}>{level}</option>
                ))}
              </select>
            </dd>
          </>
        )}
        <dt>{t('settings.executors.mode')}</dt>
        <dd>
          {!capabilities && !capabilityError ? (
            <span className="s2-help">{t('settings.executors.status.loading')}</span>
          ) : modes.length > 0 ? (
            <select
              className="select mono"
              style={{ width: '100%' }}
              value={selectedMode}
              disabled={busy || !capabilities}
              onChange={event => onSetDefaults({ mode: event.target.value })}
            >
              {modes.map(mode => (
                <option key={mode.id} value={mode.id}>{mode.label}</option>
              ))}
            </select>
          ) : (
            <span className="s2-help">{capabilityError
              ? t('settings.executors.status.unavailable')
              : t('settings.executors.sessionMode')}</span>
          )}
        </dd>
      </dl>
    </div>
  );
}

function NotificationsBlock() {
  const t = useT();
  const [prefs, setPrefs] = useState<NotificationPrefs>(() => loadNotificationPrefs());
  const [permission, setPermission] = useState<BrowserNotificationPermission>(() => browserNotificationPermission());
  const desktopEnabled = prefs.desktop && permission === 'granted';
  const unavailable = permission === 'unsupported' || permission === 'denied';

  function patch(partial: Partial<NotificationPrefs>) {
    setPrefs(prev => saveNotificationPrefs({ ...prev, ...partial }));
  }

  async function setDesktop(enabled: boolean) {
    if (!enabled) {
      patch({ desktop: false });
      return;
    }
    const nextPermission = await requestDesktopNotificationPermission();
    setPermission(nextPermission);
    patch({ desktop: nextPermission === 'granted' });
  }

  const statusText =
    permission === 'granted'
      ? t('settings.notifications.status.enabled')
      : permission === 'denied'
        ? t('settings.notifications.status.blocked')
        : permission === 'unsupported'
          ? t('settings.notifications.status.unsupported')
          : t('settings.notifications.status.allow');

  return (
    <dl className="kv-grid">
      <dt>{t('settings.notifications.desktop')}</dt>
      <dd>
        <label className="switch">
          <input
            type="checkbox"
            checked={desktopEnabled}
            disabled={unavailable}
            onChange={e => { void setDesktop(e.target.checked); }}
          />
          <span>{statusText}</span>
        </label>
      </dd>
      <dt>{t('settings.notifications.events')}</dt>
      <dd>
        <label className="switch">
          <input
            type="checkbox"
            checked={prefs.sessionDone}
            disabled={!desktopEnabled}
            onChange={e => patch({ sessionDone: e.target.checked })}
          />
          <span>{t('settings.notifications.sessionDone')}</span>
        </label>
        <label className="switch">
          <input
            type="checkbox"
            checked={prefs.approvalNeeded}
            disabled={!desktopEnabled}
            onChange={e => patch({ approvalNeeded: e.target.checked })}
          />
          <span>{t('settings.notifications.approvalNeeded')}</span>
        </label>
        <label className="switch">
          <input
            type="checkbox"
            checked={prefs.errors}
            disabled={!desktopEnabled}
            onChange={e => patch({ errors: e.target.checked })}
          />
          <span>{t('settings.notifications.error')}</span>
        </label>
      </dd>
      <dt>{t('settings.notifications.sound')}</dt>
      <dd>
        <label className="switch">
          <input
            type="checkbox"
            checked={prefs.sound}
            disabled={!desktopEnabled}
            onChange={e => patch({ sound: e.target.checked })}
          />
          <span>{t('settings.notifications.chime')}</span>
        </label>
      </dd>
      <dt>{t('settings.notifications.dockBadge')}</dt>
      <dd>
        <label className="switch">
          <input
            type="checkbox"
            checked={prefs.badge}
            onChange={e => patch({ badge: e.target.checked })}
          />
          <span>{t('settings.notifications.badge')}</span>
        </label>
      </dd>
    </dl>
  );
}


/** Panel-3 nav for the dock Settings rail: renders the same NAV_GROUPS the
 *  panel-2 SettingsBody switches on. Clicking an item replaces panel 2's
 *  content with that section (single-section switcher — the in-body nav and
 *  scrollspy were removed in phase 4). `active` is controlled by App so the
 *  selection survives rail collapse/restore. */
export function SettingsNavInspector({ active, onSelect }: { active: NavKey; onSelect: (key: NavKey) => void }) {
  const t = useT();
  return (
    <aside className="inspector settings-nav-inspector">
      <div className="insp-head">
        <span className="label">{t('settings.title')}</span>
      </div>
      <div className="settings-nav-body">
        {NAV_GROUPS.map(group => (
          <div className="s2-group" key={group.labelKey}>
            <div className="s2-grouplabel">{t(group.labelKey)}</div>
            {group.items.map(([key, labelKey]) => (
              <button
                key={key}
                type="button"
                className={`s2-navitem ${active === key ? 'active' : ''}`}
                onClick={() => onSelect(key)}
              >
                {t(labelKey)}
              </button>
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}
