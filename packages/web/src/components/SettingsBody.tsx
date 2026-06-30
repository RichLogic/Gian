import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { CcModelCapabilities, CodexModelCapabilities, ExternalEditor, OpenFileCategory, SystemConfig } from '@gian/shared';
import { THEME_DEFAULT_ACCENT } from '@gian/shared';
import { loadProxyModels, saveSettings } from '../api.js';
import { reseedClaudeCli, type ClaudeChatSurface } from '../session-routing.js';
import { confirm } from '../feedback.js';
import { useMinimapEnabled, setMinimapEnabled } from '../display-prefs.js';
import { AppIcon } from './AppIcon.js';
import { DEFAULT_OPEN_TARGET } from './Sheet.js';
import { useT } from '../i18n/index.js';

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

type NavKey = 'appearance' | 'notifications' | 'shortcuts' | 'executors' | 'chatview' | 'openwith';

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
      ['chatview', 'settings.section.chatview'],
      ['openwith', 'settings.section.openwith'],
    ],
  },
];

/** Render the executor caption with the `claude -p` token in monospace,
 *  matching the design prototype's `.exec-note` (it wraps just that token in
 *  `.mono`). Splits the translated string on the literal so both locales work. */
function renderExecNote(text: string): ReactNode {
  const token = 'claude -p';
  const idx = text.indexOf(token);
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <span className="mono">{token}</span>
      {text.slice(idx + token.length)}
    </>
  );
}

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
}

/** Settings v3 — left-nav scrollspy locator + vertically-stacked section
 *  cards (ported 1:1 from design/gian-design-v2). Two nav groups:
 *  Preferences (Appearance / Notifications / Shortcuts) and Runtime
 *  (Executors / Chat view / Open with). The nav is a locator, not a
 *  switcher — clicking scrolls to a section and the active highlight
 *  follows scroll position. Account/Auth/Public/System/About stay out of
 *  this compact workbench surface; locale lives here because the app only
 *  supports Chinese/English UI. */
export function SettingsBody({ config, apps, onChange }: Props) {
  const t = useT();
  if (!config) return <div style={{ padding: 20, color: 'var(--text-3)' }}>{t('common.loading')}</div>;
  return <SettingsBodyInner config={config} apps={apps ?? []} onChange={onChange} />;
}

function SettingsBodyInner({
  config, apps, onChange,
}: {
  config: SystemConfig;
  apps: string[];
  onChange: (cfg: SystemConfig) => void;
}) {
  const t = useT();
  const minimapOn = useMinimapEnabled();
  const [editors, setEditors] = useState<ExternalEditor[]>(config.external_editors);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [activeNav, setActiveNav] = useState<NavKey>('appearance');

  // Nav is a locator, not a switcher: clicking scrolls to the section; the
  // active highlight follows the scroll position (scrollspy). The scroller is
  // the enclosing `.sheet-content` island (matches the design prototype).
  function goTo(key: NavKey) {
    setActiveNav(key);
    const el = document.getElementById(`sec-${key}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  useEffect(() => {
    const root = rootRef.current;
    const scroller = root?.closest('.sheet-content') as HTMLElement | null;
    if (!scroller) return;
    const keys = NAV_GROUPS.flatMap(g => g.items.map(([k]) => k));
    const onScroll = () => {
      const top = scroller.getBoundingClientRect().top;
      let cur: NavKey = keys[0]!;
      for (const k of keys) {
        const el = document.getElementById(`sec-${k}`);
        if (el && el.getBoundingClientRect().top - top <= 56) cur = k;
      }
      setActiveNav(cur);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => scroller.removeEventListener('scroll', onScroll);
  }, []);

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

  // Chat-view prefs restructure the runtime tablist for every session, applied
  // with a hard reload (rather than reactively propagating into all mounted
  // session views). Confirm first so the reload isn't abrupt; on cancel nothing
  // is persisted and the control stays at its current value (it's config-driven).
  async function patchChatView(partial: Partial<SystemConfig>) {
    const ok = await confirm({
      title: t('settings.chatview.reload.title'),
      message: t('settings.chatview.reload.message'),
      confirmLabel: t('settings.chatview.reload.confirm'),
      cancelLabel: t('common.cancel'),
    });
    if (!ok) return;
    const cfg = await saveSettings(partial);
    if (cfg) onChange(cfg);
    try { window.location.reload(); } catch { /* jsdom / non-browser */ }
  }

  const claudeSurface: ClaudeChatSurface = config.claude_chat_surface ?? 'tty';
  const claudeCli = config.claude_chat_cli ?? true;
  const codexCli = config.codex_chat_cli ?? false;

  function patchEditors(next: ExternalEditor[]) {
    setEditors(next);
  }

  // "Default apps" (below) picks from the curated "Open with" list — the apps
  // the user added above — plus the two built-in system targets (@newtab /
  // @finder). It deliberately does NOT offer the full scanned app catalog.
  const editorAppNames = [...new Set(editors.map(e => e.name.trim()).filter(Boolean))];

  return (
    <div className="settings2" data-testid="settings-body" ref={rootRef}>
      <nav className="settings2-nav">
        <div className="settings2-title">{t('settings.title')}</div>
        {NAV_GROUPS.map(group => (
          <div className="s2-group" key={group.labelKey}>
            <div className="s2-grouplabel">{t(group.labelKey)}</div>
            {group.items.map(([key, labelKey]) => (
              <button
                key={key}
                type="button"
                className={`s2-navitem ${activeNav === key ? 'active' : ''}`}
                onClick={() => goTo(key)}
              >
                {t(labelKey)}
              </button>
            ))}
          </div>
        ))}
        <div className="s2-foot mono">{t('settings.foot')}</div>
      </nav>

      <div className="settings2-main">
        {/* ── Appearance ── */}
        <section id="sec-appearance" className="s2-section">
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

        {/* ── Notifications ── */}
        <section id="sec-notifications" className="s2-section">
          <h3 className="s2-sectiontitle">{t('settings.section.notifications')}</h3>
          <div className="s2-card">
            <NotificationsBlock />
          </div>
        </section>

        {/* ── Shortcuts ── */}
        <section id="sec-shortcuts" className="s2-section">
          <h3 className="s2-sectiontitle">{t('settings.section.shortcuts')}</h3>
          <div className="s2-card">
            <dl className="kv-grid shortcuts">
              <dt>{t('settings.shortcuts.commandPalette')}</dt><dd><kbd>⌘</kbd><kbd>⇧</kbd><kbd>K</kbd></dd>
              <dt>{t('settings.shortcuts.sendNow')}</dt><dd><kbd>⌘</kbd><kbd>⏎</kbd></dd>
              <dt>{t('settings.shortcuts.createClaudeChild')}</dt><dd><kbd>⌘</kbd><kbd>J</kbd></dd>
              <dt>{t('settings.shortcuts.createCodexChild')}</dt><dd><kbd>⌘</kbd><kbd>K</kbd></dd>
              <dt>{t('settings.shortcuts.markUnread')}</dt><dd><kbd>⌘</kbd><kbd>U</kbd></dd>
              <dt>{t('settings.shortcuts.approveDecline')}</dt><dd><kbd>⏎</kbd>&nbsp;<kbd>⌫</kbd></dd>
              <dt>{t('settings.shortcuts.showChat')}</dt><dd><kbd>⌃/⌘</kbd><kbd>1</kbd></dd>
              <dt>{t('settings.shortcuts.showCli')}</dt><dd><kbd>⌃/⌘</kbd><kbd>2</kbd></dd>
            </dl>
          </div>
        </section>

        {/* ── Executors ── */}
        <section id="sec-executors" className="s2-section">
          <h3 className="s2-sectiontitle">{t('settings.section.executor')}</h3>
          <div className="s2-card">
            <ExecutorRow
              name="Claude Code"
              executor="claude"
              effortLabelKey="settings.executors.effort"
              note={renderExecNote(t('settings.executors.note'))}
              model={config.default_claude_model}
              effort={config.default_claude_effort}
              onSetModel={v => patch({ default_claude_model: v })}
              onSetEffort={v => patch({ default_claude_effort: v })}
            />
            <ExecutorRow
              name="Codex"
              executor="codex"
              effortLabelKey="settings.executors.thinking"
              model={config.default_codex_model}
              effort={config.default_codex_effort}
              onSetModel={v => patch({ default_codex_model: v })}
              onSetEffort={v => patch({ default_codex_effort: v })}
            />
          </div>
        </section>

        {/* ── Chat view ── */}
        <section id="sec-chatview" className="s2-section">
          <h3 className="s2-sectiontitle">{t('settings.section.chatview')}</h3>
          <div className="s2-card">
            <p className="s2-help">{t('settings.chatview.help')}</p>
            <dl className="kv-grid">
              <dt>{t('settings.chatview.claudeSurface')}</dt>
              <dd>
                <div className="segm">
                  {([
                    ['structured', 'settings.chatview.claudep'],
                    ['tty', 'settings.chatview.tty'],
                  ] as const).map(([val, labelKey]) => (
                    <button
                      key={val}
                      className={`segm-item ${claudeSurface === val ? 'active' : ''}`}
                      onClick={() => { void patchChatView({ claude_chat_surface: val, claude_chat_cli: reseedClaudeCli(val) }); }}
                    >
                      {t(labelKey)}
                    </button>
                  ))}
                </div>
              </dd>
              <dt>{t('settings.chatview.claudeCli')}</dt>
              <dd>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={claudeCli}
                    onChange={e => { void patchChatView({ claude_chat_cli: e.target.checked }); }}
                  />
                  <span>{t('settings.chatview.claudeCli.hint')}</span>
                </label>
              </dd>
              <dt>{t('settings.chatview.codexCli')}</dt>
              <dd>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={codexCli}
                    onChange={e => { void patchChatView({ codex_chat_cli: e.target.checked }); }}
                  />
                  <span>{t('settings.chatview.codexCli.hint')}</span>
                </label>
              </dd>
            </dl>
          </div>
        </section>

        {/* ── Open with (merged: external editors + default app by file type) ── */}
        <section id="sec-openwith" className="s2-section">
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
      </div>
    </div>
  );
}

/** Renders one executor block (Claude or Codex). Model list comes from
 *  `loadProxyModels(executor)`; effort options derive from the selected
 *  model's capability struct — Cc exposes `supportedEfforts`, Codex exposes
 *  `supportedThinking`. Nothing about the list is hardcoded — when the proxy
 *  adds a model or adjusts its supported levels, this UI follows. */
function ExecutorRow({
  name, executor, model, effort, effortLabelKey, note, onSetModel, onSetEffort,
}: {
  name: string;
  executor: 'claude' | 'codex';
  model: string;
  effort: string;
  /** i18n key for the effort/thinking row label (Claude → Effort, Codex → Thinking). */
  effortLabelKey: string;
  /** Optional muted caption under the row (e.g. the `claude -p` note). */
  note?: ReactNode;
  onSetModel: (v: string) => void;
  onSetEffort: (v: string) => void;
}) {
  const t = useT();
  const [models, setModels] = useState<Array<CcModelCapabilities | CodexModelCapabilities>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(false);
    loadProxyModels(executor)
      .then(list => {
        if (!alive) return;
        setModels(list);
        setLoading(false);
        if (list.length === 0) setError(true);
      })
      .catch(() => {
        if (!alive) return;
        setLoading(false);
        setError(true);
      });
    return () => { alive = false; };
  }, [executor]);

  const visible = models.filter(m => !m.hidden);
  const selected = models.find(m => m.model === model.trim());
  const efforts = selected
    ? (executor === 'claude'
        ? (selected as CcModelCapabilities).supportedEfforts
        : (selected as CodexModelCapabilities).supportedThinking)
    : [];

  const status =
    loading ? { cls: 'loading', label: t('settings.executors.status.loading') }
    : error ? { cls: 'err', label: t('settings.executors.status.unavailable') }
    : { cls: 'ok', label: t('settings.executors.status.ready') };

  return (
    <div className="exec-row">
      <div className="exec-head">
        <span className={`exec-dot ${executor}`} />
        <span className="exec-name">{name}</span>
        <span className={`exec-status ${status.cls}`}>{status.label}</span>
      </div>
      <dl className="kv-grid">
        <dt>{t('settings.executors.defaultModel')}</dt>
        <dd>
          <select
            className="select mono"
            style={{ width: '100%' }}
            value={model}
            disabled={loading || visible.length === 0}
            onChange={e => {
              const next = e.target.value;
              onSetModel(next);
              // Reset effort when the new model doesn't support the current value.
              const m = models.find(x => x.model === next);
              const supported = m
                ? (executor === 'claude'
                    ? (m as CcModelCapabilities).supportedEfforts
                    : (m as CodexModelCapabilities).supportedThinking)
                : [];
              if (effort && !supported.includes(effort as never)) {
                onSetEffort('');
              }
            }}
          >
            <option value="">{t('settings.executors.proxyDefault')}</option>
            {visible.filter(m => m.model !== '').map(m => (
              <option key={m.id} value={m.model}>{m.displayName || m.model}</option>
            ))}
          </select>
        </dd>
        {efforts.length > 0 && (
          <>
            <dt>{t(effortLabelKey)}</dt>
            <dd>
              <select
                className="select mono"
                style={{ width: '100%' }}
                value={effort}
                onChange={e => onSetEffort(e.target.value)}
              >
                <option value="">{t('settings.executors.modelDefault')}</option>
                {efforts.map(level => (
                  <option key={level} value={level}>{level}</option>
                ))}
              </select>
            </dd>
          </>
        )}
      </dl>
      {note && <p className="exec-note">{note}</p>}
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
