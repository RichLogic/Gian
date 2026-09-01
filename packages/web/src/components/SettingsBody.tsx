import { useEffect, useRef, useState } from 'react';
import type {
  AgentProxyDefaults,
  AgentProxyUpdateCheck,
  ChatFontFamily,
  ConfigValue,
  ExternalEditor,
  GianScreenshotPreferences,
  GianScreenshotState,
  KeymapCommand,
  OpenFileCategory,
  ProductExecutor,
  ProxyCatalogEntry,
  SystemConfig,
  TerminalOptions,
  TerminalPreferences,
  UserAgentStatus,
  Workspace,
} from '@gian/shared';
import {
  DEFAULT_TERMINAL_PREFERENCES,
  KEYMAP_COMMANDS,
  MAX_CHAT_FONT_SIZE,
  MIN_CHAT_FONT_SIZE,
  THEME_DEFAULT_ACCENT,
} from '@gian/shared';
import {
  loadAgentDraftDefaults,
  loadAgents,
  loadProxies,
  loadProxyCapabilities,
  loadResolvedProxyCatalog,
} from '../api.js';
import {
  MAX_ZOOM_PERCENT,
  MIN_ZOOM_PERCENT,
  ZOOM_STEP_PERCENT,
  setMinimapEnabled,
  setZoomPercent,
  useMinimapEnabled,
  useZoomPercent,
} from '../display-prefs.js';
import {
  acceleratorDisplayParts,
  acceleratorFromEvent,
  comboDisplayParts,
  comboFromEvent,
  isKeymapCustomized,
  keymapConflict,
  useKeymap,
} from '../shortcut-prefs.js';
import { desktopBridge } from '../desktop-bridge.js';
import { confirm, toast } from '../feedback.js';
import {
  agentEntityKey,
  agentIdEntityKey,
  type CreateAgentOperationResult,
} from '../operations/agents.js';
import { AUTH_ENTITY_KEY } from '../operations/auth.js';
import { SETTINGS_ONBOARDING_ENTITY_KEY } from '../operations/settings.js';
import { BROWSER_PROFILE_ENTITY_KEY } from '../operations/browser.js';
import {
  useOperationDispatch,
  useOperationPending,
  useOperationStore,
  usePendingOperations,
  waitForRunSettle,
} from '../operations/use-operations.js';
import type { OperationRun } from '../operations/types.js';
import { AppIcon } from './AppIcon.js';
import { AgentLogo } from './AgentLogo.js';
import {
  catalogFromCapabilities,
  executorSettingsFromCapabilities,
} from './composer/capabilities.js';
import { DEFAULT_OPEN_TARGET } from './sheet-model.js';
import { useT } from '../i18n/index.js';
import type { AppIdentity } from '../controllers/use-app-auth.js';
import {
  SettingsAdoptPage,
  SettingsArchivePage,
  SettingsWorkspacesPage,
} from './SettingsManagementPages.js';
import {
  LayoutSettingsPage,
  ToolSettingsPage,
} from './SettingsPreferencePages.js';
import { SettingsStepper } from './SettingsStepper.js';

const OPEN_CATEGORIES: Array<{ key: OpenFileCategory; labelKey: string }> = [
  { key: 'code', labelKey: 'settings.openapps.code' },
  { key: 'web', labelKey: 'settings.openapps.web' },
  { key: 'images', labelKey: 'settings.openapps.images' },
  { key: 'pdf', labelKey: 'settings.openapps.pdf' },
  { key: 'other', labelKey: 'settings.openapps.other' },
];

export type NavKey =
  | 'appearance'
  | 'layout'
  | 'keymap'
  | 'executors'
  | 'chat'
  | 'files'
  | 'diffs'
  | 'history'
  | 'sidechat'
  | 'browser'
  | 'terminal'
  | 'openwith'
  | 'archive'
  | 'adopt'
  | 'workspaces'
  | 'updates'
  | 'account';

/** Dropdown option lists. Zoom uses the same step lattice the slider
 *  exposed (and Cmd+/- still snaps to); chat font sizes are concrete px. */
const ZOOM_OPTIONS: readonly number[] = (() => {
  const options: number[] = [];
  for (let p = MIN_ZOOM_PERCENT; p <= MAX_ZOOM_PERCENT; p += ZOOM_STEP_PERCENT) options.push(p);
  return options;
})();

const CHAT_FONT_SIZE_OPTIONS: readonly number[] = (() => {
  const options: number[] = [];
  for (let px = MIN_CHAT_FONT_SIZE; px <= MAX_CHAT_FONT_SIZE; px += 1) options.push(px);
  return options;
})();

const CHAT_FONT_FAMILY_LABEL_KEYS: Record<ChatFontFamily, string> = {
  system: 'settings.chat.font.system',
  manrope: 'settings.chat.font.manrope',
  serif: 'settings.chat.font.serif',
  mono: 'settings.chat.font.mono',
};

/** Left-nav groups (locator). `labelKey` is an i18n key; `items` map a
 *  section anchor id (`sec-<key>`) to its nav label key. */
const NAV_GROUPS: Array<{
  labelKey: string;
  items: Array<[NavKey, string]>;
}> = [
  {
    labelKey: 'settings.nav.group.general',
    items: [
      ['appearance', 'settings.section.appearance'],
      ['layout', 'settings.section.layout'],
      ['keymap', 'settings.section.keymap'],
    ],
  },
  {
    labelKey: 'settings.nav.group.ai',
    items: [
      ['executors', 'settings.section.executor'],
      ['chat', 'settings.section.chat'],
    ],
  },
  {
    labelKey: 'settings.nav.group.tools',
    items: [
      ['files', 'settings.section.files'],
      ['diffs', 'settings.section.diffs'],
      ['history', 'settings.section.history'],
      ['sidechat', 'settings.section.sidechat'],
      ['browser', 'settings.section.browser'],
      ['terminal', 'settings.section.terminal'],
      ['openwith', 'settings.section.openwith'],
    ],
  },
  { labelKey: 'settings.nav.group.application', items: [['updates', 'settings.section.updates']] },
  {
    labelKey: 'settings.nav.group.account',
    items: [['account', 'settings.section.account']],
  },
  {
    labelKey: 'settings.nav.group.management',
    items: [
      ['workspaces', 'settings.section.workspaces'],
      ['archive', 'settings.section.archive'],
      ['adopt', 'settings.section.adopt'],
    ],
  },
];

const STANDALONE_SECTIONS = new Set<NavKey>(['workspaces', 'archive', 'adopt']);

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
  /** Rendered config — canonical + settings.save overlays merged by App. */
  config: SystemConfig | null;
  /** Installed apps (macOS) for the "Add application" picker. */
  apps?: string[];
  terminalOptions?: TerminalOptions | null;
  /** Which section to render — controlled by App and selected from the
   *  internal Panel-2 navigation. */
  activeSection?: NavKey;
  onSectionChange?: (section: NavKey) => void;
  workspaces?: Workspace[];
  onSessionOpened?: (session: import('@gian/shared').Session) => void;
  identity?: AppIdentity | null;
  onSignOut?: () => void;
}

/** Settings v4 — a Panel-2-owned surface. Ordinary preferences form one
 *  continuous document with an internal scroll locator; Workspaces, Archive
 *  and Adopt remain standalone management pages. Narrow Panel 2 widths fold
 *  the locator into the local header instead of borrowing Panel 3.
 *
 *  Phase 3b (UI Operation Layer): every mutation here dispatches a registered
 *  operation — `settings.save` (optimistic overlays on the rendered config),
 *  `settings.resetOnboarding`, `auth.logout`, and the `agent.*` pending
 *  operations. Busy states derive from the runs, not local flags. */
export function SettingsBody({
  config,
  apps,
  terminalOptions = null,
  activeSection = 'appearance',
  identity = null,
  onSignOut,
  onSectionChange,
  workspaces = [],
  onSessionOpened,
}: Props) {
  const t = useT();
  if (!config) return <div style={{ padding: 20, color: 'var(--text-3)' }}>{t('common.loading')}</div>;
  return (
    <SettingsBodyInner
      config={config}
      apps={apps ?? []}
      terminalOptions={terminalOptions}
      activeSection={activeSection}
      identity={identity}
      onSignOut={onSignOut}
      onSectionChange={onSectionChange}
      workspaces={workspaces}
      onSessionOpened={onSessionOpened}
    />
  );
}

function SettingsBodyInner({
  config, apps, terminalOptions, activeSection, identity, onSignOut,
  onSectionChange, workspaces, onSessionOpened,
}: {
  config: SystemConfig;
  apps: string[];
  terminalOptions: TerminalOptions | null;
  activeSection: NavKey;
  identity: AppIdentity | null;
  onSignOut?: () => void;
  onSectionChange?: (section: NavKey) => void;
  workspaces: Workspace[];
  onSessionOpened?: (session: import('@gian/shared').Session) => void;
}) {
  const t = useT();
  const dispatch = useOperationDispatch();
  const browserAvailable = !!desktopBridge()?.browser;
  const screenshotAvailable = !!desktopBridge()?.screenshot;
  const [screenshotState, setScreenshotState] = useState<GianScreenshotState | null>(null);
  const [screenshotPreferences, setScreenshotPreferences] =
    useState<GianScreenshotPreferences | null>(null);
  const clearingBrowserData = useOperationPending(BROWSER_PROFILE_ENTITY_KEY, 'browser.clearData');
  const minimapOn = useMinimapEnabled();
  const zoomPercent = useZoomPercent();
  const [editors, setEditors] = useState<ExternalEditor[]>(config.external_editors);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [agentSectionVisited, setAgentSectionVisited] = useState(activeSection === 'executors');
  const mainRef = useRef<HTMLDivElement>(null);
  const activeSectionRef = useRef(activeSection);
  const standaloneSection = STANDALONE_SECTIONS.has(activeSection) ? activeSection : null;
  activeSectionRef.current = activeSection;

  function navigateToSection(section: NavKey) {
    if (section === 'executors') setAgentSectionVisited(true);
    onSectionChange?.(section);
    setMobileNavOpen(false);
    if (STANDALONE_SECTIONS.has(section)) return;
    requestAnimationFrame(() => {
      document.getElementById(`settings-section-${section}`)?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    });
  }

  useEffect(() => {
    const scroller = mainRef.current;
    if (!scroller || !onSectionChange) return;
    let frame = 0;
    const sync = () => {
      frame = 0;
      const top = scroller.getBoundingClientRect().top;
      const sections = [...scroller.querySelectorAll<HTMLElement>('[data-settings-section]')]
        .sort((left, right) => left.offsetTop - right.offsetTop);
      let current = sections[0]?.dataset.settingsSection as NavKey | undefined;
      for (const section of sections) {
        if (section.getBoundingClientRect().top - top > 72) break;
        current = section.dataset.settingsSection as NavKey;
      }
      if (current && current !== activeSectionRef.current) onSectionChange(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(sync);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [onSectionChange]);

  // Sync local editor state when config is replaced from outside (e.g. initial
  // load, or a settings.save rollback restoring the canonical list).
  useEffect(() => {
    setEditors(config.external_editors);
  }, [config.external_editors]);

  useEffect(() => {
    if (activeSection === 'executors') setAgentSectionVisited(true);
  }, [activeSection]);

  useEffect(() => {
    const screenshot = desktopBridge()?.screenshot;
    if (!screenshot || activeSection !== 'keymap') return;
    let alive = true;
    void screenshot.getState().then(state => {
      if (alive) setScreenshotState(state);
    });
    void screenshot.getPreferences().then(preferences => {
      if (alive) setScreenshotPreferences(preferences);
    });
    return () => { alive = false; };
  }, [activeSection]);

  // Debounced auto-save: dispatch the final write 500ms after the user stops
  // typing. Skip when local matches prop (initial mount, post-sync — the
  // optimistic overlay makes them equal right after the dispatch). The
  // debounce stays in the view; the operation sees only the final write.
  useEffect(() => {
    if (editorsEqual(editors, config.external_editors)) return;
    const handle = setTimeout(() => {
      dispatch('settings.save', { patch: { external_editors: editors } });
    }, 500);
    return () => clearTimeout(handle);
  }, [editors, config.external_editors, dispatch]);

  function patch(partial: Partial<SystemConfig>) {
    dispatch('settings.save', { patch: partial });
  }

  function patchEditors(next: ExternalEditor[]) {
    setEditors(next);
  }

  // "Default apps" (below) picks from the curated "Open with" list — the apps
  // the user added above — plus Gian Browser and the fixed system targets.
  // It deliberately does NOT offer the full scanned app catalog.
  const editorAppNames = [...new Set(editors.map(e => e.name.trim()).filter(Boolean))];

  return (
    <div className="settings2" data-testid="settings-body">
      <div className="settings2-frame">
      <header className="settings2-mobile-head">
        <button type="button" className="iconbtn settings2-nav-toggle"
                aria-label={t('settings.navigation.open')}
                aria-expanded={mobileNavOpen}
                onClick={() => setMobileNavOpen(open => !open)}>
          <span aria-hidden>☰</span>
        </button>
        <strong>{t(navLabelKey(activeSection))}</strong>
      </header>
      <aside className="settings2-internal-nav" aria-label={t('settings.title')}>
        <div className="settings2-nav-title">{t('settings.title')}</div>
        <SettingsNavList active={activeSection} onSelect={navigateToSection} />
      </aside>
      {mobileNavOpen && (
        <div className="settings2-mobile-nav" role="dialog" aria-label={t('settings.title')}>
          <SettingsNavList active={activeSection} onSelect={navigateToSection} />
        </div>
      )}
      <div className="settings2-main" ref={mainRef}>
        {standaloneSection === null ? <>
        {/* ── Appearance ── */}
        <section id="settings-section-appearance" data-settings-section="appearance"
                 className="s2-section" style={{ order: 1 }}>
          <h3 className="s2-sectiontitle">{t('settings.section.appearance')}</h3>
          <div className="s2-card">
            <dl className="kv-grid">
              <dt>{t('settings.appearance.theme')}</dt>
              <dd>
                <select
                  className="select"
                  aria-label={t('settings.appearance.theme')}
                  value={config.theme}
                  onChange={e => {
                    const theme = e.target.value as SystemConfig['theme'];
                    patch({ theme, accent: THEME_DEFAULT_ACCENT[theme] });
                  }}
                >
                  <option value="light">{t('settings.theme.light')}</option>
                  <option value="warm">{t('settings.theme.warm')}</option>
                  <option value="dark">{t('settings.theme.dark')}</option>
                </select>
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
              <dt>{t('settings.appearance.language')}</dt>
              <dd>
                <select
                  className="select"
                  aria-label={t('settings.appearance.language')}
                  value={config.locale}
                  onChange={e => patch({ locale: e.target.value as SystemConfig['locale'] })}
                >
                  <option value="zh-CN">{t('settings.language.zh')}</option>
                  <option value="en">{t('settings.language.en')}</option>
                </select>
              </dd>
              <dt>{t('settings.appearance.zoom')}</dt>
              <dd>
                <select
                  className="select"
                  aria-label={t('settings.appearance.zoom')}
                  value={zoomPercent}
                  onChange={e => setZoomPercent(Number(e.target.value))}
                >
                  {ZOOM_OPTIONS.map(percent => (
                    <option key={percent} value={percent}>{percent}%</option>
                  ))}
                </select>
              </dd>
            </dl>
          </div>
        </section>

        <div id="settings-section-layout" data-settings-section="layout" className="s2-section" style={{ order: 2 }}>
          <LayoutSettingsPage config={config} onPatch={patch} />
        </div>

        {/* ── Chat ── */}
        <section id="settings-section-chat" data-settings-section="chat"
                 className="s2-section" style={{ order: 5 }}>
          <h3 className="s2-sectiontitle">{t('settings.section.chat')}</h3>
          <div className="s2-card">
            <dl className="kv-grid">
              <dt>{t('settings.chat.fontSize')}</dt>
              <dd>
                <select
                  className="select"
                  aria-label={t('settings.chat.fontSize')}
                  value={config.chat_font_size}
                  onChange={e => patch({ chat_font_size: Number(e.target.value) })}
                >
                  {CHAT_FONT_SIZE_OPTIONS.map(size => (
                    <option key={size} value={size}>{size}px</option>
                  ))}
                </select>
              </dd>
              <dt>{t('settings.chat.fontFamily')}</dt>
              <dd>
                <select
                  className="select"
                  aria-label={t('settings.chat.fontFamily')}
                  value={config.chat_font_family}
                  onChange={e => patch({ chat_font_family: e.target.value as ChatFontFamily })}
                >
                  {(Object.keys(CHAT_FONT_FAMILY_LABEL_KEYS) as ChatFontFamily[]).map(family => (
                    <option key={family} value={family}>
                      {t(CHAT_FONT_FAMILY_LABEL_KEYS[family])}
                    </option>
                  ))}
                </select>
              </dd>
              <dt className="settings-toggle-spacer" aria-hidden="true" />
              <dd className="settings-toggle-row">
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

        {/* ── Terminal ── */}
        <section id="settings-section-terminal" data-settings-section="terminal"
                 className="s2-section" style={{ order: 11 }}>
          <div className="s2-section-heading">
            <h3 className="s2-sectiontitle">{t('settings.section.terminal')}</h3>
            <button
              type="button"
              className="btn sm secondary"
              disabled={terminalPreferencesEqual(config.terminal, DEFAULT_TERMINAL_PREFERENCES)}
              onClick={() => patch({ terminal: { ...DEFAULT_TERMINAL_PREFERENCES } })}
            >
              {t('settings.terminal.reset')}
            </button>
          </div>
          <div className="s2-card">
            <TerminalSettingsBlock
              preferences={config.terminal}
              options={terminalOptions}
              onChange={terminal => patch({ terminal })}
            />
          </div>
          <div className="s2-subsection-block">
            <h4>{t('settings.terminal.behavior')}</h4>
            <ToolSettingsPage tool="terminal" config={config} onPatch={patch} showTitle={false} />
          </div>
        </section>

        {/* ── Updates ── */}
        <section id="settings-section-updates" data-settings-section="updates"
                 className="s2-section" style={{ order: 16 }}>
          <h3 className="s2-sectiontitle">{t('settings.section.updates')}</h3>
          <div className="s2-card">
            <UpdatesBlock />
          </div>
        </section>

        {/* ── Keymap ── */}
        <section id="settings-section-keymap" data-settings-section="keymap"
                 className="s2-section" style={{ order: 3 }}>
          <h3 className="s2-sectiontitle">{t('settings.section.keymap')}</h3>
          <div className="s2-card">
            <dl className="kv-grid shortcuts">
              {screenshotAvailable && (
                <>
                  <dt>
                    {t('settings.shortcuts.screenshot')}
                    {screenshotState && !screenshotState.shortcutRegistered && (
                      <span className="muted"> · {t('screenshot.shortcutUnavailable')}</span>
                    )}
                  </dt>
                  <dd>
                    <ScreenshotShortcutEditor
                      state={screenshotState}
                      preferences={screenshotPreferences}
                      onState={setScreenshotState}
                      onPreferences={setScreenshotPreferences}
                    />
                  </dd>
                  <dt className="settings-toggle-spacer" aria-hidden="true" />
                  <dd className="settings-toggle-row">
                    <label className="switch">
                      <input
                        type="checkbox"
                        aria-label={t('settings.screenshot.hideWindow')}
                        checked={screenshotPreferences?.hideMainWindowDuringCapture ?? false}
                        onChange={event => {
                          const next: GianScreenshotPreferences = {
                            shortcut: screenshotPreferences?.shortcut ?? null,
                            hideMainWindowDuringCapture: event.target.checked,
                          };
                          setScreenshotPreferences(next);
                          void desktopBridge()?.screenshot?.setPreferences(next);
                        }}
                      />
                      <span>{t('settings.screenshot.hideWindow')}</span>
                    </label>
                  </dd>
                  {/* The hint is a long sentence; in the auto-sized keycap
                      column it would inflate the track and squeeze every
                      label. Span both columns so it wraps freely. */}
                  <dd className="shortcut-hint">{t('settings.screenshot.hideWindowHint')}</dd>
                </>
              )}
              {KEYMAP_COMMANDS.map(command => (
                <KeymapRow
                  key={command}
                  command={command}
                  preferences={config.keymap}
                  onPatch={patch}
                />
              ))}
            </dl>
          </div>
        </section>

        {/* ── AI Agents ── */}
        <section id="settings-section-executors" data-settings-section="executors"
                 className="s2-section" style={{ order: 4 }}>
          {agentSectionVisited ? <AgentInstallBlock /> : (
            <>
              <h3 className="s2-sectiontitle">{t('settings.section.executor')}</h3>
              <div className="s2-card settings-section-deferred" aria-hidden />
            </>
          )}
        </section>

        <div id="settings-section-files" data-settings-section="files" className="s2-section" style={{ order: 6 }}>
          <ToolSettingsPage tool="files" config={config} onPatch={patch} />
        </div>
        <div id="settings-section-diffs" data-settings-section="diffs" className="s2-section" style={{ order: 7 }}>
          <ToolSettingsPage tool="diffs" config={config} onPatch={patch} />
        </div>
        <div id="settings-section-history" data-settings-section="history" className="s2-section" style={{ order: 8 }}>
          <ToolSettingsPage tool="history" config={config} onPatch={patch} />
        </div>
        <div id="settings-section-sidechat" data-settings-section="sidechat" className="s2-section" style={{ order: 9 }}>
          <ToolSettingsPage tool="side_chat" config={config} onPatch={patch} />
        </div>
        <div id="settings-section-browser" data-settings-section="browser" className="s2-section" style={{ order: 10 }}>
          <ToolSettingsPage
            tool="browser"
            config={config}
            onPatch={patch}
            clearingBrowserData={clearingBrowserData}
            onClearBrowserData={browserAvailable ? () => {
              void confirm({
                title: t('settings.browserData.clear'),
                message: t('settings.browserData.confirm'),
                confirmLabel: t('settings.browserData.clear'),
                danger: true,
              }).then(ok => { if (ok) dispatch('browser.clearData', {}); });
            } : undefined}
          />
        </div>

        {/* ── Open with (merged: external editors + default app by file type) ── */}
        <section id="settings-section-openwith" data-settings-section="openwith"
                 className="s2-section" style={{ order: 12 }}>
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
                      {cur === '@browser' || cur === '@newtab'
                        ? <span className="app-icon app-icon-newtab" aria-hidden>↗</span>
                        : <AppIcon name={cur === '@finder' ? 'Finder' : cur} />}
                      <select
                        aria-label={t(labelKey)}
                        value={cur}
                        onChange={e => patch({ open_apps: { ...(config.open_apps ?? {}), [key]: e.target.value } })}
                      >
                        <option value="@browser">{t('settings.openapps.browser')}</option>
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

        <section id="settings-section-account" data-settings-section="account"
                 className="s2-section" style={{ order: 17 }}>
          <h3 className="s2-sectiontitle">{t('settings.section.account')}</h3>
          <div className="s2-card">
            <AccountBlock identity={identity} onSignOut={onSignOut} />
          </div>
        </section>
        </> : standaloneSection === 'workspaces' ? (
          <SettingsWorkspacesPage workspaces={workspaces} />
        ) : standaloneSection === 'archive' ? (
          <SettingsArchivePage workspaces={workspaces} />
        ) : (
          <SettingsAdoptPage workspaces={workspaces} onSessionOpened={onSessionOpened} />
        )}
      </div>
      </div>
    </div>
  );
}

function terminalPreferencesEqual(
  a: TerminalPreferences,
  b: Readonly<TerminalPreferences>,
): boolean {
  return a.font_family === b.font_family
    && a.font_size === b.font_size
    && a.line_height === b.line_height
    && a.cursor_style === b.cursor_style
    && a.cursor_blink === b.cursor_blink
    && a.scrollback_lines === b.scrollback_lines
    && a.shell === b.shell
    && a.start_directory === b.start_directory;
}

function TerminalSettingsBlock({
  preferences,
  options,
  onChange,
}: {
  preferences: TerminalPreferences;
  options: TerminalOptions | null;
  onChange: (next: TerminalPreferences) => void;
}) {
  const t = useT();
  const update = (patch: Partial<TerminalPreferences>) => {
    onChange({ ...preferences, ...patch });
  };
  const shellAvailable = preferences.shell === ''
    || options?.shells.some(shell => shell.path === preferences.shell);

  return (
    <dl className="kv-grid terminal-settings">
      <dt>{t('settings.terminal.fontFamily')}</dt>
      <dd>
        <select
          className="select mono"
          value={preferences.font_family}
          onChange={event => update({
            font_family: event.target.value as TerminalPreferences['font_family'],
          })}
        >
          <option value="jetbrains-mono">JetBrains Mono</option>
          <option value="system-mono">{t('settings.terminal.font.system')}</option>
          <option value="sf-mono">SF Mono</option>
          <option value="menlo">Menlo</option>
        </select>
      </dd>

      <dt>{t('settings.terminal.fontSize')}</dt>
      <dd>
        <SettingsStepper
          label={t('settings.terminal.fontSize')}
          value={preferences.font_size}
          min={10}
          max={22}
          decreaseLabel={t('settings.terminal.fontSize.decrease')}
          increaseLabel={t('settings.terminal.fontSize.increase')}
          formatValue={value => `${value}px`}
          onChange={font_size => update({ font_size })}
        />
      </dd>

      <dt>{t('settings.terminal.lineHeight')}</dt>
      <dd>
        <SettingsStepper
          label={t('settings.terminal.lineHeight')}
          value={preferences.line_height}
          min={1}
          max={1.6}
          step={0.05}
          decreaseLabel={t('settings.stepper.decrease').replace('{label}', t('settings.terminal.lineHeight'))}
          increaseLabel={t('settings.stepper.increase').replace('{label}', t('settings.terminal.lineHeight'))}
          formatValue={value => value.toFixed(2).replace(/0$/, '')}
          onChange={line_height => update({ line_height })}
        />
      </dd>

      <dt>{t('settings.terminal.cursorStyle')}</dt>
      <dd>
        <div className="segm">
          {([
            ['block', 'settings.terminal.cursor.block'],
            ['bar', 'settings.terminal.cursor.bar'],
            ['underline', 'settings.terminal.cursor.underline'],
          ] as const).map(([style, labelKey]) => (
            <button
              key={style}
              type="button"
              className={`segm-item ${preferences.cursor_style === style ? 'active' : ''}`}
              onClick={() => update({ cursor_style: style })}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>
      </dd>

      <dt className="settings-toggle-spacer" aria-hidden="true" />
      <dd className="settings-toggle-row">
        <label className="switch">
          <input
            type="checkbox"
            checked={preferences.cursor_blink}
            onChange={event => update({ cursor_blink: event.target.checked })}
          />
          <span>{t('settings.terminal.cursorBlink.label')}</span>
        </label>
      </dd>

      <dt>{t('settings.terminal.scrollback')}</dt>
      <dd>
        <select
          className="select mono"
          value={preferences.scrollback_lines}
          onChange={event => update({
            scrollback_lines: Number(event.target.value) as TerminalPreferences['scrollback_lines'],
          })}
        >
          <option value={1_000}>1,000</option>
          <option value={5_000}>5,000</option>
          <option value={10_000}>10,000</option>
          <option value={50_000}>50,000</option>
        </select>
      </dd>

      <dt>{t('settings.terminal.shell')}</dt>
      <dd>
        <select
          className="select mono terminal-shell-select"
          aria-label={t('settings.terminal.shell')}
          value={preferences.shell}
          disabled={!options}
          onChange={event => update({ shell: event.target.value })}
        >
          <option value="">
            {options
              ? `${t('settings.terminal.shell.system')} · ${options.system_shell}`
              : t('common.loading')}
          </option>
          {!shellAvailable && preferences.shell && (
            <option value={preferences.shell}>{preferences.shell}</option>
          )}
          {options?.shells.map(shell => (
            <option key={shell.path} value={shell.path}>{shell.label} · {shell.path}</option>
          ))}
        </select>
      </dd>

      <dt>{t('settings.terminal.startDirectory')}</dt>
      <dd>
        <div className="segm">
          {([
            ['context', 'settings.terminal.startDirectory.context'],
            ['home', 'settings.terminal.startDirectory.home'],
          ] as const).map(([directory, labelKey]) => (
            <button
              key={directory}
              type="button"
              className={`segm-item ${preferences.start_directory === directory ? 'active' : ''}`}
              onClick={() => update({ start_directory: directory })}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>
      </dd>
    </dl>
  );
}

function AccountBlock({
  identity,
  onSignOut,
}: {
  identity: AppIdentity | null;
  onSignOut?: () => void;
}) {
  const t = useT();
  const dispatch = useOperationDispatch();
  // Busy states are the runs (Phase 3b) — no local flags.
  const signingOut = useOperationPending(AUTH_ENTITY_KEY, 'auth.logout');
  const resettingSetup = useOperationPending(SETTINGS_ONBOARDING_ENTITY_KEY, 'settings.resetOnboarding');
  const githubUser = identity?.provider === 'github' ? identity.user : null;
  const displayName = githubUser
    ? githubUser.name || githubUser.login
    : identity?.provider === 'host'
      ? identity.username
      : t('settings.account.signedIn');

  function restartSetup() {
    // The definition's reconcile preserves the reload-on-success behavior.
    dispatch('settings.resetOnboarding', {});
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
          disabled={signingOut || resettingSetup}
          onClick={restartSetup}
        >
          {resettingSetup ? t('settings.account.reconfiguring') : t('settings.account.reconfigure')}
        </button>
      )}
      <button
        className="btn danger-ghost"
        type="button"
        disabled={signingOut || resettingSetup || !onSignOut}
        onClick={() => onSignOut?.()}
      >
        {signingOut ? t('settings.account.signingOut') : t('settings.account.signOut')}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI Agents (issue #97) — user-managed Agents on the Proxy-kind catalog.
// Visual/interaction contract: .cursor/ai-agents-ui-prototype.html. Draft
// cards are local state until Save & Restart writes agents.json; kind-level
// install/update APIs stay draft-safe (no Agent id required).
// ---------------------------------------------------------------------------

interface AgentDraftState {
  name: string;
  proxy: ProductExecutor;
  cliPath: string;
}

function draftNameError(
  draft: AgentDraftState,
  agents: UserAgentStatus[],
): 'empty' | 'taken' | null {
  const name = draft.name.trim();
  if (!name) return 'empty';
  return agents.some(agent => agent.name.trim().toLowerCase() === name.toLowerCase())
    ? 'taken'
    : null;
}

function AgentInstallBlock() {
  const t = useT();
  const dispatch = useOperationDispatch();
  const store = useOperationStore();
  const [agents, setAgents] = useState<UserAgentStatus[]>([]);
  const [proxies, setProxies] = useState<ProxyCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<AgentDraftState | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalogKind, setCatalogKind] = useState<ProductExecutor | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);
  /** Per-kind result of the last manual Proxy update check (issue #86). */
  const [proxyChecks, setProxyChecks] = useState<
    Partial<Record<string, AgentProxyUpdateCheck>>
  >({});

  const desktop = desktopBridge();
  const desktopApp = desktop?.appVariant === 'production'
    || desktop?.appVariant === 'development';

  async function refresh() {
    try {
      setAgents(await loadAgents({ refresh: true }));
      setError('');
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    loadProxies()
      .then(setProxies)
      .catch(() => setProxies([]));
  }, []);

  /** Dispatch one agent operation and wait for its settle: the pending run
   *  drives busy states; this promise preserves the success-boolean
   *  contract (refresh + inline error). */
  async function run(
    name:
      | 'agent.installCli'
      | 'agent.installProxy'
      | 'agent.create'
      | 'agent.delete'
      | 'agent.patch'
      | 'agent.setPath'
      | 'agent.switchProxy',
    input: Parameters<typeof dispatch>[1],
  ): Promise<boolean> {
    setError('');
    const dispatched = dispatch(name, input);
    const settled: OperationRun = await waitForRunSettle(store, dispatched.id);
    if (settled.phase === 'confirmed') {
      await refresh();
      return true;
    }
    setError(settled.error ?? 'Agent operation failed');
    return false;
  }

  /** Load-set changes restart Gian on desktop; the confirm stays in the
   *  view while the operation sequences write → restart → rollback. In a
   *  plain browser there is no bridge to restart with, so the write simply
   *  lands and takes effect at the next launch. */
  async function confirmRestart(): Promise<boolean> {
    if (!desktopApp) return true;
    const accepted = await confirm({
      title: t('settings.agents.restartTitle'),
      message: t('settings.agents.restartMessage'),
      confirmLabel: t('settings.agents.restartConfirm'),
      cancelLabel: t('settings.agents.restartCancel'),
    });
    if (!accepted) return false;
    if (!desktop?.restartApp) {
      setError(t('settings.agents.restartFailed'));
      return false;
    }
    return true;
  }

  function openCatalog() {
    setCatalogKind(proxies[0]?.id ?? 'claude');
    setCatalogOpen(true);
  }

  async function startDraft(kind: ProductExecutor) {
    setCatalogOpen(false);
    try {
      const defaults = await loadAgentDraftDefaults(kind);
      setDraft({
        name: defaults.name,
        proxy: kind,
        cliPath: defaults.cliPath ?? '',
      });
    } catch {
      setDraft({ name: '', proxy: kind, cliPath: '' });
    }
  }

  async function changeDraftProxy(kind: ProductExecutor) {
    if (!draft || kind === draft.proxy) return;
    // The name stays (it is free text); an untouched path re-defaults
    // for the new kind (prototype behavior).
    const keepPath = draft.cliPath.trim() !== '';
    try {
      const defaults = await loadAgentDraftDefaults(kind);
      setDraft({
        name: draft.name,
        proxy: kind,
        cliPath: keepPath ? draft.cliPath : defaults.cliPath ?? '',
      });
    } catch {
      setDraft({ ...draft, proxy: kind });
    }
  }

  async function saveDraft() {
    if (!draft || draftNameError(draft, agents)) return;
    if (!(await confirmRestart())) return;
    setError('');
    const dispatched = dispatch('agent.create', {
      name: draft.name.trim(),
      proxy: draft.proxy,
      cliPath: draft.cliPath.trim() || null,
      restart: desktopApp,
    });
    const settled: OperationRun = await waitForRunSettle(store, dispatched.id);
    if (settled.phase !== 'confirmed') {
      setError(settled.error ?? 'Agent operation failed');
      return;
    }
    const result = settled.result as CreateAgentOperationResult;
    setRestartRequired(result.restartRequired);
    setDraft(null);
    await refresh();
  }

  async function retryRestart() {
    setError('');
    const settled = await waitForRunSettle(
      store,
      dispatch('agent.restartApp', {}).id,
    );
    if (settled.phase === 'confirmed') return;
    setRestartRequired(true);
    setError(t('settings.agents.restartRetryFailed'));
  }

  async function savePath(agent: UserAgentStatus, path: string | null): Promise<boolean> {
    if (!(await confirmRestart())) return false;
    return run('agent.setPath', {
      agentId: agent.id,
      path,
      restart: desktopApp,
      previousPath: agent.cliPath,
      restartFailedMessage: t('settings.agents.restartFailed'),
    });
  }

  async function switchProxy(agent: UserAgentStatus, proxy: ProductExecutor): Promise<void> {
    if (proxy === agent.proxy) return;
    if (!(await confirmRestart())) return;
    // Retarget the path in the same write: the old kind's binary is never
    // the right runtime. Copy the new kind's existing path when one exists.
    let cliPath: string | null = null;
    try {
      const defaults = await loadAgentDraftDefaults(proxy);
      cliPath = defaults.cliPath;
    } catch {
      cliPath = null;
    }
    await run('agent.switchProxy', {
      agentId: agent.id,
      proxy,
      cliPath,
      previousProxy: agent.proxy,
      previousCliPath: agent.cliPath,
      restart: desktopApp,
      restartFailedMessage: t('settings.agents.restartFailed'),
    });
  }

  async function removeAgent(agent: UserAgentStatus): Promise<void> {
    const accepted = await confirm({
      title: t('settings.agents.deleteTitle'),
      message: t('settings.agents.deleteMessage').replace('{name}', agent.name),
      confirmLabel: t('settings.agents.deleteConfirm'),
      cancelLabel: t('common.cancel'),
    });
    if (!accepted) return;
    if (!(await confirmRestart())) return;
    await run('agent.delete', {
      agentId: agent.id,
      snapshot: {
        name: agent.name,
        proxy: agent.proxy,
        cliPath: agent.cliPath,
        defaults: agent.defaults,
      },
      restart: desktopApp,
      restartFailedMessage: t('settings.agents.restartFailed'),
    });
  }

  /** Install (or update) the kind's Proxy, then drop the stale check. */
  async function installProxy(agent: UserAgentStatus) {
    if (await run('agent.installProxy', { executor: agent.proxy })) {
      setProxyChecks(previous => {
        const next = { ...previous };
        delete next[agent.proxy];
        return next;
      });
    }
  }

  async function checkProxyUpdate(agent: UserAgentStatus) {
    setError('');
    const dispatched = dispatch('agent.checkProxyUpdate', { executor: agent.proxy });
    const settled: OperationRun = await waitForRunSettle(store, dispatched.id);
    if (settled.phase === 'confirmed') {
      setProxyChecks(previous => ({
        ...previous,
        [agent.proxy]: settled.result as AgentProxyUpdateCheck,
      }));
    } else {
      setError(settled.error ?? 'Agent operation failed');
    }
  }

  if (loading && agents.length === 0) {
    return (
      <>
        <div className="s2-section-heading">
          <h3 className="s2-sectiontitle">{t('settings.section.executor')}</h3>
        </div>
        <div className="s2-card">
          <div className="empty"><p>{t('settings.agents.loading')}</p></div>
        </div>
      </>
    );
  }

  const draftError = draft ? draftNameError(draft, agents) : null;

  return (
    <>
      <div className="s2-section-heading">
        <h3 className="s2-sectiontitle">{t('settings.section.executor')}</h3>
        <button type="button" className="btn sm primary" onClick={openCatalog}>
          {t('settings.agents.add')}
        </button>
      </div>
      <p className="s2-help">{t('settings.agents.help')}</p>

      {draft && (
        <div className="s2-card draft" data-testid="agent-draft-card">
          <div className="exec-row">
            <div className="exec-head">
              <AgentLogo proxy={draft.proxy} size={24} />
              <input
                className={`exec-name-input ${draftError === 'taken' ? 'bad' : ''}`}
                value={draft.name}
                spellCheck={false}
                aria-label={t('settings.agents.name')}
                onChange={event => setDraft({ ...draft, name: event.target.value })}
              />
              <span className="exec-status draft">{t('settings.agents.draft')}</span>
            </div>
            <dl className="kv-grid">
              <dt>{t('settings.agents.proxy')}</dt>
              <dd>
                <select
                  className="select"
                  value={draft.proxy}
                  aria-label={t('settings.agents.proxy')}
                  onChange={event => void changeDraftProxy(event.target.value as ProductExecutor)}
                >
                  {proxies.map(entry => (
                    <option key={entry.id} value={entry.id}>{entry.name}</option>
                  ))}
                </select>
              </dd>
              <dt>{t('settings.agents.cliPath')}</dt>
              <dd>
                <div className="cli-path-row">
                  <input
                    className="input mono"
                    value={draft.cliPath}
                    placeholder="/absolute/path/to/cli"
                    aria-label={t('settings.agents.cliPath')}
                    onChange={event => setDraft({ ...draft, cliPath: event.target.value })}
                  />
                  <button
                    type="button"
                    className="btn xs secondary"
                    onClick={() => {
                      void (async () => {
                        const settled = await waitForRunSettle(
                          store,
                          dispatch('agent.pickCliPath', { executor: draft.proxy }).id,
                        );
                        if (settled.phase === 'confirmed' && typeof settled.result === 'string') {
                          setDraft(previous => previous ? { ...previous, cliPath: settled.result as string } : previous);
                        }
                      })();
                    }}
                  >
                    {t('settings.agents.browse')}
                  </button>
                </div>
                {!draft.cliPath.trim() && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    <button
                      type="button"
                      className="btn xs secondary"
                      onClick={() => { void run('agent.installCli', { executor: draft.proxy }); }}
                    >
                      {t('settings.agents.installOfficial')}
                    </button>
                    <button
                      type="button"
                      className="btn xs secondary"
                      onClick={() => { void run('agent.installProxy', { executor: draft.proxy }); }}
                    >
                      {t('settings.agents.setupProxy')}
                    </button>
                  </div>
                )}
              </dd>
            </dl>
            {draftError === 'taken' && (
              <span className="field-error">{t('settings.agents.nameTaken')}</span>
            )}
            <div className="card-actions">
              <button type="button" className="btn ghost" onClick={() => setDraft(null)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={draftError !== null}
                onClick={() => { void saveDraft(); }}
              >
                {t('settings.agents.saveRestart')}
              </button>
            </div>
          </div>
        </div>
      )}

      {agents.length > 0 && (
        <div className="s2-card">
          {agents.map(agent => (
            <AgentInstallRow
              key={agent.id}
              agent={agent}
              proxies={proxies}
              proxyCheck={proxyChecks[agent.proxy]}
              onRename={name => run('agent.patch', { agentId: agent.id, patch: { name } })}
              onSwitchProxy={kind => switchProxy(agent, kind)}
              onSetPath={path => savePath(agent, path)}
              onSetDefaults={defaults => run('agent.patch', { agentId: agent.id, patch: { defaults } })}
              onInstallCli={() => { void run('agent.installCli', { executor: agent.proxy }); }}
              onInstallProxy={() => { void installProxy(agent); }}
              onCheckProxyUpdate={() => { void checkProxyUpdate(agent); }}
              onPickPath={async () => {
                const settled = await waitForRunSettle(
                  store,
                  dispatch('agent.pickCliPath', { executor: agent.proxy }).id,
                );
                return settled.phase === 'confirmed' ? (settled.result as string | null) : null;
              }}
              onDelete={() => { void removeAgent(agent); }}
            />
          ))}
        </div>
      )}

      {agents.length === 0 && !draft && (
        <div className="s2-card">
          <div className="empty">
            <p>{t('settings.agents.empty')}</p>
            <button type="button" className="btn primary" onClick={openCatalog}>
              {t('settings.agents.add')}
            </button>
          </div>
        </div>
      )}

      {error && <p className="s2-help" role="alert">{error}</p>}

      {restartRequired && (
        <div className="s2-card" role="status" data-testid="agent-restart-required">
          <div className="exec-row">
            <p className="s2-help">{t('settings.agents.restartRequired')}</p>
            <div className="card-actions">
              <button
                type="button"
                className="btn primary"
                onClick={() => { void retryRestart(); }}
              >
                {t('settings.agents.restartRetry')}
              </button>
            </div>
          </div>
        </div>
      )}

      {catalogOpen && (
        <div className="confirm-overlay" role="dialog" aria-modal="true">
          <div className="confirm-modal wide">
            <div className="confirm-title">{t('settings.agents.catalogTitle')}</div>
            <div className="confirm-msg">{t('settings.agents.catalogHelp')}</div>
            <div className="catalog">
              {proxies.map(entry => (
                <button
                  key={entry.id}
                  type="button"
                  className={`catalog-item ${catalogKind === entry.id ? 'active' : ''}`}
                  onClick={() => setCatalogKind(entry.id)}
                >
                  <AgentLogo proxy={entry.id} logo={entry.logo} size={28} />
                  <span>
                    <div className="catalog-name">{entry.name}</div>
                    <div className="catalog-sub">{entry.tagline}</div>
                  </span>
                </button>
              ))}
            </div>
            <div className="confirm-actions">
              <button type="button" className="btn ghost" onClick={() => setCatalogOpen(false)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={!catalogKind}
                onClick={() => { if (catalogKind) void startDraft(catalogKind); }}
              >
                {t('settings.agents.continue')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function AgentInstallRow({
  agent,
  proxies,
  proxyCheck,
  onRename,
  onSwitchProxy,
  onSetPath,
  onSetDefaults,
  onInstallCli,
  onInstallProxy,
  onCheckProxyUpdate,
  onPickPath,
  onDelete,
}: {
  agent: UserAgentStatus;
  proxies: ProxyCatalogEntry[];
  proxyCheck: AgentProxyUpdateCheck | undefined;
  onRename: (name: string) => Promise<boolean>;
  onSwitchProxy: (proxy: ProductExecutor) => Promise<void>;
  onSetPath: (path: string | null) => Promise<boolean>;
  onSetDefaults: (defaults: Partial<AgentProxyDefaults>) => Promise<boolean>;
  onInstallCli: () => void;
  onInstallProxy: () => void;
  onCheckProxyUpdate: () => void;
  onPickPath: () => Promise<string | null>;
  onDelete: () => void;
}) {
  const t = useT();
  // Busy = any in-flight operation for THIS Agent or its kind (the runs
  // carry the state the pre-migration `busy` flag duplicated).
  const agentRuns = usePendingOperations(agentIdEntityKey(agent.id));
  const kindRuns = usePendingOperations(agentEntityKey(agent.proxy));
  const busy = agentRuns.length > 0 || kindRuns.length > 0;
  const [name, setName] = useState(agent.name);
  // Echo the resolved path: an Agent without an explicit cliPath still
  // runs on a resolved binary — show it (saving it back is a no-op).
  const resolvedPath = agent.cliPath ?? agent.cli.path ?? '';
  const [path, setPath] = useState(resolvedPath);
  const pathInputRef = useRef<HTMLInputElement>(null);
  const [capabilities, setCapabilities] = useState<unknown>(null);
  const [resolvedCapabilities, setResolvedCapabilities] = useState<unknown>(null);
  const [resolvedModel, setResolvedModel] = useState('');
  const [resolvingDefaults, setResolvingDefaults] = useState(false);
  const resolveSequence = useRef(0);
  const [capabilityError, setCapabilityError] = useState(false);
  useEffect(() => setName(agent.name), [agent.name]);
  useEffect(() => setPath(resolvedPath), [resolvedPath]);
  // Show the tail of long paths when the field isn't being edited — the
  // executable name matters more than the prefix (2026-08-04).
  const showPathTail = () => {
    const input = pathInputRef.current;
    if (input) input.scrollLeft = input.scrollWidth;
  };
  useEffect(showPathTail, [path, resolvedPath]);
  useEffect(() => {
    let alive = true;
    resolveSequence.current += 1;
    setCapabilities(null);
    setResolvedCapabilities(null);
    setResolvedModel('');
    setResolvingDefaults(false);
    setCapabilityError(false);
    if (agent.plugin.state !== 'ready') return () => { alive = false; };
    // Agent-scoped catalog: the same kind can differ per CLI path.
    loadProxyCapabilities(agent.proxy, agent.id)
      .then(value => {
        if (alive) setCapabilities(value);
      })
      .catch(() => {
        if (alive) setCapabilityError(true);
      });
    return () => { alive = false; };
  }, [agent.id, agent.proxy, agent.cliPath, agent.plugin.state, agent.plugin.version]);

  // Title = the Agent's name (inline edit, write-through on commit).
  async function commitName() {
    const next = name.trim();
    if (!next || next === agent.name) {
      setName(agent.name);
      return;
    }
    if (!(await onRename(next))) setName(agent.name);
  }

  // Native file picker → fill + save the CLI path in one click (2026-08-04).
  async function onBrowse() {
    const picked = await onPickPath();
    if (picked) {
      setPath(picked);
      if (!(await onSetPath(picked))) setPath(resolvedPath);
    }
  }

  async function commitPath(next: string | null) {
    if ((next ?? '') === resolvedPath) {
      setPath(resolvedPath);
      return;
    }
    if (!(await onSetPath(next))) {
      setPath(resolvedPath);
      requestAnimationFrame(showPathTail);
    }
  }

  const defaults = agent.defaults;
  const settingsCapabilities = resolvedCapabilities ?? capabilities;
  const { models, thinkingLevels: catalogThinking, modes } = executorSettingsFromCapabilities(
    agent.proxy,
    settingsCapabilities,
  );
  const baseCatalog = catalogFromCapabilities(capabilities);
  const selectedModel = models.find(model => model.model === defaults.model)
    ?? models.find(model => model.isDefault)
    ?? models[0];
  const modelThinking = selectedModel
    ? ('supportedEfforts' in selectedModel
        ? selectedModel.supportedEfforts
        : selectedModel.supportedThinking)
    : [];
  const thinkingLevels = catalogThinking.length > 0
    ? catalogThinking
    : modelThinking.filter((level): level is string => typeof level === 'string' && level.length > 0);
  const selectedMode = modes.some(mode => mode.id === defaults.mode)
    ? defaults.mode
    : modes.find(mode => mode.isDefault)?.id ?? modes[0]?.id ?? '';

  function configWithModel(
    model: string,
  ): { sessionConfig: Record<string, ConfigValue>; turnConfig: Record<string, ConfigValue> } {
    const sessionConfig: Record<string, ConfigValue> = {};
    const turnConfig: Record<string, ConfigValue> = {};
    const option = baseCatalog.configOptions.find(candidate => candidate.role === 'model');
    if (option && model) {
      (option.binding === 'session' ? sessionConfig : turnConfig)[option.id] = model;
    }
    return { sessionConfig, turnConfig };
  }

  async function changeDefaultModel(model: string): Promise<void> {
    const modelOption = baseCatalog.configOptions.find(option => option.role === 'model');
    const canResolve = !!model
      && !!modelOption
      && !!baseCatalog.catalogRevision
      && baseCatalog.resolveAdvertised;
    if (!canResolve) {
      setResolvedCapabilities(null);
      setResolvedModel('');
      const nextModel = models.find(candidate => candidate.model === model)
        ?? models.find(candidate => candidate.isDefault)
        ?? models[0];
      const supported = nextModel
        ? ('supportedEfforts' in nextModel
            ? nextModel.supportedEfforts
            : nextModel.supportedThinking).filter((level): level is string => (
              typeof level === 'string' && level.length > 0
            ))
        : [];
      await onSetDefaults({
        model,
        ...(defaults.thinking && !supported.includes(defaults.thinking)
          ? { thinking: '' }
          : {}),
      });
      return;
    }

    const sequence = ++resolveSequence.current;
    setResolvingDefaults(true);
    try {
      const config = configWithModel(model);
      const resolved = await loadResolvedProxyCatalog(agent.proxy, {
        catalogRevision: baseCatalog.catalogRevision!,
        ...config,
      }, agent.id);
      if (resolveSequence.current !== sequence) return;
      setResolvedCapabilities(resolved);
      setResolvedModel(model);
      const resolvedThinking = executorSettingsFromCapabilities(agent.proxy, resolved).thinkingLevels;
      await onSetDefaults({
        model,
        ...(defaults.thinking && !resolvedThinking.includes(defaults.thinking)
          ? { thinking: '' }
          : {}),
      });
    } catch {
      if (resolveSequence.current !== sequence) return;
      // Do not retain a model-specific effort when the Proxy could not
      // resolve the new model. Saving the model with Proxy-default effort is
      // the only fail-closed combination.
      setResolvedCapabilities(null);
      setResolvedModel('');
      await onSetDefaults({ model, ...(defaults.thinking ? { thinking: '' } : {}) });
    } finally {
      if (resolveSequence.current === sequence) setResolvingDefaults(false);
    }
  }

  useEffect(() => {
    if (
      !capabilities
      || !defaults.model
      || !!resolvedCapabilities
      || resolvedModel === defaults.model
      || !baseCatalog.resolveAdvertised
      || !baseCatalog.catalogRevision
      || !baseCatalog.configOptions.some(option => (
        option.role === 'model' && option.choices?.some(choice => String(choice.value) === defaults.model)
      ))
    ) {
      return;
    }
    void changeDefaultModel(defaults.model);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capabilities, defaults.model]);

  const cliUnverified = agent.runtimeProfile?.verification === 'unverified';

  return (
    <div className="exec-row">
      <div className="exec-head">
        <AgentLogo proxy={agent.proxy} size={24} />
        <input
          className="exec-name-input"
          value={name}
          spellCheck={false}
          aria-label={t('settings.agents.name')}
          disabled={busy}
          onChange={event => setName(event.target.value)}
          onBlur={() => { void commitName(); }}
          onKeyDown={event => {
            if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
            if (event.key === 'Escape') setName(agent.name);
          }}
        />
        <span className={`exec-status ${agent.ready ? 'ok' : 'warn'}`}>
          {agent.ready ? t('settings.agents.ready') : t('settings.agents.setupRequired')}
        </span>
        <button
          type="button"
          className="btn xs ghost delete-slot"
          disabled={busy}
          onClick={onDelete}
        >
          {t('settings.agents.delete')}
        </button>
      </div>
      <dl className="kv-grid">
        <dt>{t('settings.agents.proxy')}</dt>
        <dd>
          <select
            className="select"
            value={agent.proxy}
            disabled={busy || proxies.length === 0}
            aria-label={t('settings.agents.proxy')}
            onChange={event => void onSwitchProxy(event.target.value as ProductExecutor)}
          >
            {proxies.map(entry => (
              <option key={entry.id} value={entry.id}>{entry.name}</option>
            ))}
          </select>
        </dd>
        <dt>{t('settings.agents.cliPath')}</dt>
        <dd>
          <div className="cli-path-row">
            <input
              ref={pathInputRef}
              className="input mono"
              value={path}
              placeholder="/absolute/path/to/cli"
              aria-label={t('settings.agents.cliPath')}
              disabled={busy}
              onChange={event => setPath(event.target.value)}
              onBlur={() => { void commitPath(path.trim() || null); }}
              onKeyDown={event => {
                if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
              }}
            />
            <button
              type="button"
              className="btn xs secondary"
              disabled={busy}
              onClick={() => { void onBrowse(); }}
            >
              {t('settings.agents.browse')}
            </button>
          </div>
        </dd>
        <dt>{t('settings.agents.version')}</dt>
        <dd>
          {agent.cli.state === 'ready'
            ? (
              <div className="exec-version">
                <span>{agent.cli.version}</span>
                {cliUnverified && (
                  <div className="hint danger-hint" role="alert">
                    {t('settings.agents.cliVersionUnverified').replace(
                      '{versions}',
                      agent.runtimeProfile?.verifiedCliVersions.join(', ') || 'none',
                    )}
                  </div>
                )}
              </div>
            )
            : (
              <>
                {t('settings.agents.setupRequired')}
                {' '}
                <button
                  type="button"
                  className="btn xs secondary"
                  disabled={busy}
                  onClick={onInstallCli}
                >
                  {t('settings.agents.installOfficial')}
                </button>
              </>
            )}
        </dd>
        <dt>{t('settings.agents.plugin')}</dt>
        <dd>
          {agent.plugin.state === 'ready'
            ? (
              <>
                {agent.plugin.version}
                {agent.plugin.source === 'github-release'
                  ? ' · GitHub'
                  : agent.plugin.source === 'development' ? ' · Dev' : ''}
                {' '}
                <button
                  type="button"
                  className="btn xs secondary"
                  disabled={busy}
                  onClick={onCheckProxyUpdate}
                >
                  {t('settings.agents.checkProxyUpdate')}
                </button>
                {proxyCheck?.updateAvailable && (
                  <>
                    {' '}
                    <button
                      type="button"
                      className="btn xs secondary"
                      disabled={busy}
                      onClick={onInstallProxy}
                    >
                      {t('settings.agents.updateProxy')}
                    </button>
                    <span className="hint">
                      {t('settings.agents.proxyUpdateAvailable').replace('{version}', proxyCheck.latestVersion ?? '')}
                    </span>
                  </>
                )}
                {proxyCheck && !proxyCheck.updateAvailable && proxyCheck.managed && (
                  <span className="hint" data-testid={`${agent.id}-proxy-up-to-date`}>
                    {t('settings.agents.proxyUpToDate')}
                  </span>
                )}
                {proxyCheck && !proxyCheck.managed && (
                  <span className="hint" data-testid={`${agent.id}-proxy-dev-channel`}>
                    {t('settings.agents.proxyDevChannel')}
                  </span>
                )}
              </>
            )
            : (
              <>
                {t('settings.agents.setupRequired')}
                {' '}
                <button
                  type="button"
                  className="btn xs secondary"
                  disabled={busy}
                  onClick={onInstallProxy}
                >
                  {t('settings.agents.setupProxy')}
                </button>
              </>
            )}
        </dd>
        {agent.ready
          && (models.length > 0 || thinkingLevels.length > 0 || modes.length > 0 || capabilityError) && (
          <>
            <dt>{t('settings.executors.defaults')}</dt>
            <dd>
              <div className="exec-defaults">
                {models.length > 0 && (
                  <label className="exec-default">
                    <span className="lbl">{t('settings.executors.defaultModel')}</span>
                    <select
                      className="select mono"
                      value={defaults.model}
                      disabled={busy || resolvingDefaults || !capabilities}
                      onChange={event => {
                        const model = event.target.value;
                        void changeDefaultModel(model);
                      }}
                    >
                      <option value="">{t('settings.executors.proxyDefault')}</option>
                      {models.filter(model => model.model !== '').map(model => (
                        <option key={model.id} value={model.model}>
                          {model.displayName || model.model}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {thinkingLevels.length > 0 && (
                  <label className="exec-default">
                    <span className="lbl">{agent.proxy === 'claude'
                      ? t('settings.executors.effort')
                      : t('settings.executors.thinking')}</span>
                    <select
                      className="select mono"
                      value={defaults.thinking}
                      disabled={busy || resolvingDefaults || !capabilities}
                      onChange={event => void onSetDefaults({ thinking: event.target.value })}
                    >
                      <option value="">{t('settings.executors.modelDefault')}</option>
                      {thinkingLevels.map(level => (
                        <option key={level} value={level}>{level}</option>
                      ))}
                    </select>
                  </label>
                )}
                {(modes.length > 0 || capabilityError) && (
                  <label className="exec-default">
                    <span className="lbl">{t('settings.executors.mode')}</span>
                    {modes.length > 0 ? (
                      <select
                        className="select mono"
                        value={selectedMode}
                        disabled={busy || resolvingDefaults || !capabilities}
                        onChange={event => void onSetDefaults({ mode: event.target.value })}
                      >
                        {modes.map(mode => (
                          <option key={mode.id} value={mode.id}>{mode.label}</option>
                        ))}
                      </select>
                    ) : (
                      <span className="s2-help">{t('settings.executors.status.unavailable')}</span>
                    )}
                  </label>
                )}
              </div>
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

function UpdatesBlock() {
  const t = useT();
  const desktop = desktopBridge();
  const updater = desktop?.updater;
  const [state, setState] = useState<import('../desktop-bridge.js').GianDesktopUpdateState>({
    status: 'disabled',
    trigger: null,
    update: null,
    progress: null,
    error: null,
  });

  useEffect(() => {
    if (!updater) return;
    const unsubscribe = updater.onStateChanged(setState);
    void updater.getState().then(setState);
    return unsubscribe;
  }, [updater]);

  async function checkNow() {
    if (!updater) return;
    const result = await updater.check();
    setState(result.state);
  }

  async function restartAndInstall() {
    if (!updater) return;
    const accepted = await confirm({
      title: t('settings.updates.installTitle'),
      message: t('settings.updates.installMessage'),
      confirmLabel: t('settings.updates.installConfirm'),
      cancelLabel: t('common.cancel'),
    });
    if (!accepted) return;
    if (!(await updater.install())) {
      toast({ kind: 'error', message: t('settings.updates.installFailed') });
    }
  }

  const statusKey = `settings.updates.status.${state.status}`;
  const busy = state.status === 'checking' || state.status === 'downloading';
  const version = state.update?.version;

  return (
    <dl className="kv-grid">
      {desktop?.appVersion && (
        <>
          <dt>{t('settings.updates.currentVersion')}</dt>
          <dd>v{desktop.appVersion}</dd>
        </>
      )}
      <dt>{t('settings.updates.automatic')}</dt>
      <dd>
        <span>{t(statusKey)}</span>
        {version && state.status !== 'up-to-date' && (
          <span className="s2-help"> · v{version}</span>
        )}
        {state.status === 'downloading' && state.progress && (
          <div className="s2-help">{Math.round(state.progress.percent)}%</div>
        )}
        {state.status === 'error' && state.error && (
          <div className="s2-help">{state.error}</div>
        )}
      </dd>
      <dt>{t('settings.updates.actions')}</dt>
      <dd>
        {state.status === 'downloaded' ? (
          <button type="button" className="btn-primary" onClick={() => { void restartAndInstall(); }}>
            {t('settings.updates.restartInstall')}
          </button>
        ) : (
          <button
            type="button"
            className="btn-secondary"
            disabled={!updater || state.status === 'disabled' || busy}
            onClick={() => { void checkNow(); }}
          >
            {busy ? t('settings.updates.checking') : t('settings.updates.checkNow')}
          </button>
        )}
        <p className="s2-help">{t('settings.updates.help')}</p>
      </dd>
    </dl>
  );
}

function KeycapCombo({ combo }: { combo: string }) {
  return (
    <span className="keycap-combo">
      {comboDisplayParts(combo).map((part, index) => <kbd key={index}>{part}</kbd>)}
    </span>
  );
}

function KeycapAccelerator({ accelerator }: { accelerator: string }) {
  return (
    <span className="keycap-combo">
      {acceleratorDisplayParts(accelerator).map((part, index) => <kbd key={index}>{part}</kbd>)}
    </span>
  );
}

function keymapLabel(command: KeymapCommand, t: (key: string) => string): string {
  return t(`settings.keymap.command.${command}`);
}

/** One command-based keymap row. Provider-specific and approval-card actions
 *  are intentionally absent from KEYMAP_COMMANDS. */
function KeymapRow({
  command,
  preferences,
  onPatch,
}: {
  command: KeymapCommand;
  preferences: SystemConfig['keymap'];
  onPatch: (partial: Partial<SystemConfig>) => void;
}) {
  const t = useT();
  const resolved = useKeymap();
  const combo = resolved[command];
  const [capturing, setCapturing] = useState(false);
  const [conflict, setConflict] = useState<KeymapCommand | null>(null);

  function save(binding: string | null) {
    onPatch({
      keymap: {
        preset: 'default',
        bindings: { ...(preferences?.bindings ?? {}), [command]: binding },
      },
    });
  }

  useEffect(() => {
    if (!capturing) return;
    function onKeyDown(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setCapturing(false);
        return;
      }
      const next = comboFromEvent(event);
      if (!next) return; // pure modifier press — keep listening
      const clash = keymapConflict(next, command);
      if (clash) {
        setConflict(clash);
        setCapturing(false);
        return;
      }
      setConflict(null);
      setCapturing(false);
      save(next);
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [capturing, command, preferences, onPatch]);

  return (
    <>
      <dt>{keymapLabel(command, t)}</dt>
      <dd>
        <button
          type="button"
          className={`shortcut-capture ${capturing ? 'capturing' : ''}`}
          aria-label={keymapLabel(command, t)}
          onClick={() => { setCapturing(true); setConflict(null); }}
        >
          {capturing
            ? <span className="shortcut-listening">{t('settings.shortcuts.listening')}</span>
            : combo ? <KeycapCombo combo={combo} /> : <span className="muted">{t('settings.keymap.unassigned')}</span>}
        </button>
        {combo && (
          <button type="button" className="shortcut-reset" aria-label={t('settings.keymap.unassign')}
                  title={t('settings.keymap.unassign')} onClick={() => save(null)}>×</button>
        )}
        {isKeymapCustomized(command, preferences) && (
          <button
            type="button"
            className="shortcut-reset"
            aria-label={t('settings.shortcuts.reset')}
            title={t('settings.shortcuts.reset')}
            onClick={() => {
              setConflict(null);
              const next = { ...(preferences?.bindings ?? {}) };
              delete next[command];
              onPatch({ keymap: { preset: 'default', bindings: next } });
            }}
          >
            ↺
          </button>
        )}
      </dd>
      {/* Conflict text is a sentence, not a keycap: in the auto-sized value
          column it would inflate the track and squeeze the label. Give it a
          full-width row instead. */}
      {conflict && (
        <dd className="shortcut-conflict" role="alert">
          {t('settings.shortcuts.conflict').replace('{action}', keymapLabel(conflict, t))}
        </dd>
      )}
    </>
  );
}

/** The global screenshot shortcut lives in the desktop process (Electron
 *  globalShortcut), not the Host config — it round-trips through the
 *  screenshot preferences bridge instead of settings.save. */
function ScreenshotShortcutEditor({
  state,
  preferences,
  onState,
  onPreferences,
}: {
  state: GianScreenshotState | null;
  preferences: GianScreenshotPreferences | null;
  onState: (state: GianScreenshotState) => void;
  onPreferences: (preferences: GianScreenshotPreferences) => void;
}) {
  const t = useT();
  const [capturing, setCapturing] = useState(false);
  const activeAccelerator = preferences?.shortcut ?? state?.shortcut ?? '';
  const customized = preferences?.shortcut != null;

  async function applyShortcut(accelerator: string | null) {
    const screenshot = desktopBridge()?.screenshot;
    if (!screenshot || !preferences) return;
    const next: GianScreenshotPreferences = { ...preferences, shortcut: accelerator };
    onPreferences(next);
    const saved = await screenshot.setPreferences(next);
    onPreferences(saved);
    onState(await screenshot.getState());
  }

  useEffect(() => {
    if (!capturing) return;
    function onKeyDown(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setCapturing(false);
        return;
      }
      const accelerator = acceleratorFromEvent(event);
      if (!accelerator) return;
      // A global shortcut must carry a modifier — a bare letter would steal
      // that key from every application.
      if (!accelerator.includes('+')) return;
      setCapturing(false);
      void applyShortcut(accelerator);
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  });

  return (
    <>
      <button
        type="button"
        className={`shortcut-capture ${capturing ? 'capturing' : ''}`}
        aria-label={t('settings.shortcuts.screenshot')}
        onClick={() => setCapturing(true)}
      >
        {capturing
          ? <span className="shortcut-listening">{t('settings.shortcuts.listening')}</span>
          : <KeycapAccelerator accelerator={activeAccelerator} />}
      </button>
      {customized && (
        <button
          type="button"
          className="shortcut-reset"
          aria-label={t('settings.shortcuts.reset')}
          title={t('settings.shortcuts.reset')}
          onClick={() => { void applyShortcut(null); }}
        >
          ↺
        </button>
      )}
    </>
  );
}


function navLabelKey(active: NavKey): string {
  for (const group of NAV_GROUPS) {
    const item = group.items.find(([key]) => key === active);
    if (item) return item[1];
  }
  return 'settings.title';
}

function SettingsNavList({ active, onSelect }: { active: NavKey; onSelect: (key: NavKey) => void }) {
  const t = useT();
  return (
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
  );
}

/** Compatibility export for isolated tests. Product Settings navigation now
 *  lives inside Panel 2 and App no longer mounts this as an Inspector. */
export function SettingsNavInspector(props: { active: NavKey; onSelect: (key: NavKey) => void }) {
  return <SettingsNavList {...props} />;
}
