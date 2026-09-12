import { useEffect, useRef, useState } from 'react';
import type {
  ChatFontFamily,
  ExternalEditor,
  GianScreenshotPreferences,
  GianScreenshotState,
  KeymapCommand,
  OpenFileCategory,
  SystemConfig,
  TerminalOptions,
  TerminalPreferences,
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
import { AUTH_ENTITY_KEY } from '../operations/auth.js';
import { SETTINGS_ONBOARDING_ENTITY_KEY } from '../operations/settings.js';
import { BROWSER_PROFILE_ENTITY_KEY } from '../operations/browser.js';
import {
  useOperationDispatch,
  useOperationPending,
} from '../operations/use-operations.js';
import { AppIcon } from './AppIcon.js';
import { DEFAULT_OPEN_TARGET } from './sheet-model.js';
import { useT } from '../i18n/index.js';
import type { AppIdentity } from '../controllers/use-app-auth.js';
import {
  SettingsAdoptPage,
  SettingsArchivePage,
} from './SettingsManagementPages.js';
import { SettingsRemotePage } from './SettingsRemotePage.js';
import type { RemoteSettingsController } from '../remote-settings/types.js';
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
  | 'updates'
  | 'account'
  | 'remote';

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
    labelKey: 'settings.nav.group.remote',
    items: [['remote', 'settings.section.remote']],
  },
  {
    labelKey: 'settings.nav.group.management',
    items: [
      ['archive', 'settings.section.archive'],
      ['adopt', 'settings.section.adopt'],
    ],
  },
];

// Workspace management moved to the Project rail's group menu (2026-09-06);
// Settings keeps only Archive and Adopt as standalone management pages.
const STANDALONE_SECTIONS = new Set<NavKey>(['archive', 'adopt']);

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
  /** WP4: Agent management lives on the top-level Agents page; the Settings
   *  AI Agents section links out through this. */
  onOpenAgentsPage?: () => void;
  /** Remote Settings backend contract (WP5). Null = Host remote subsystem not
   *  available in this build; the section renders its unavailable state. */
  remoteController?: RemoteSettingsController | null;
}

/** Settings v4 — a Panel-2-owned surface. Ordinary preferences form one
 *  continuous document with an internal scroll locator; Archive and Adopt
 *  remain standalone management pages (Workspaces moved to the Project
 *  rail's group menu, 2026-09-06). Narrow Panel 2 widths fold
 *  the locator into the local header instead of borrowing Panel 3.
 *
 *  Phase 3b (UI Operation Layer): every mutation here dispatches a registered
 *  operation — `settings.save` (optimistic overlays on the rendered config),
 *  `settings.resetOnboarding`, and `auth.logout`. Busy states derive from the
 *  runs, not local flags. Agent management moved to the top-level Agents page
 *  (WP4, issue #146); the AI Agents section is a link-out card. */
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
  onOpenAgentsPage,
  remoteController = null,
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
      onOpenAgentsPage={onOpenAgentsPage}
      remoteController={remoteController}
    />
  );
}

function SettingsBodyInner({
  config, apps, terminalOptions, activeSection, identity, onSignOut,
  onSectionChange, workspaces, onSessionOpened,
  onOpenAgentsPage, remoteController,
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
  onOpenAgentsPage?: () => void;
  remoteController: RemoteSettingsController | null;
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
  const mainRef = useRef<HTMLDivElement>(null);
  const activeSectionRef = useRef(activeSection);
  const standaloneSection = STANDALONE_SECTIONS.has(activeSection) ? activeSection : null;
  activeSectionRef.current = activeSection;

  function navigateToSection(section: NavKey) {
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

        {/* ── AI Agents (WP4): management lives on the top-level Agents
             page; Settings keeps only a link-out. ── */}
        <section id="settings-section-executors" data-settings-section="executors"
                 className="s2-section" style={{ order: 4 }}>
          <h3 className="s2-sectiontitle">{t('settings.section.executor')}</h3>
          <div className="s2-card">
            <p className="s2-help">{t('settings.agents.moved')}</p>
            <button
              type="button"
              className="btn sm secondary"
              data-testid="settings-open-agents-page"
              disabled={!onOpenAgentsPage}
              onClick={() => onOpenAgentsPage?.()}
            >
              {t('settings.agents.openPage')}
            </button>
          </div>
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

        {/* ── Remote (WP5): enrollment, pairing, devices, audit ── */}
        <section id="settings-section-remote" data-settings-section="remote"
                 className="s2-section" style={{ order: 18 }}>
          <h3 className="s2-sectiontitle">{t('settings.section.remote')}</h3>
          <SettingsRemotePage controller={remoteController} />
        </section>
        </> : standaloneSection === 'archive' ? (
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
