import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  DEFAULT_BROWSER_ZOOM_FACTOR,
  MAX_BROWSER_ZOOM_FACTOR,
  MIN_BROWSER_ZOOM_FACTOR,
  stepBrowserZoomFactor,
  type GianBrowserBounds,
  type GianBrowserDownload,
  type GianBrowserDownloadsSnapshot,
  type GianBrowserExtension,
  type GianBrowserExtensionsSnapshot,
  type GianBrowserFindResult,
  type GianBrowserPermissionRequest,
  type GianBrowserPermissionsSnapshot,
  type GianBrowserState,
} from '@gian/shared';
import { desktopBridge } from '../desktop-bridge.js';
import { toast } from '../feedback.js';
import { useT } from '../i18n/index.js';
import { normalizeBrowserAddress } from '../presentation/browser-address.js';
import { DEFAULT_BROWSER_TAB_NAME } from '../presentation/browser-tabs.js';
import {
  browserExternalEntityKey,
} from '../operations/browser.js';
import { useOperationDispatch, useOperationPending } from '../operations/use-operations.js';
import { injectComposerContextItems } from './Composer.js';

const EMPTY_STATE: GianBrowserState = {
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  canOpenExternal: false,
  inspecting: false,
  zoomFactor: DEFAULT_BROWSER_ZOOM_FACTOR,
};

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
         strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

const ICONS = {
  back: 'M15 5l-7 7 7 7',
  forward: 'M9 5l7 7-7 7',
  reload: 'M19 8a7 7 0 1 0 1 6 M19 4v4h-4',
  stop: 'M7 7h10v10H7z',
  external: 'M14 4h6v6 M20 4l-9 9 M19 13v7H4V5h7',
  inspect: 'M3.5 8V3.5H8 M16 3.5h4.5V8 M20.5 16v4.5H16 M8 20.5H3.5V16 M8 8h8v8H8z',
  zoomIn: 'M12 5v14 M5 12h14',
  zoomOut: 'M5 12h14',
  find: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13 M15.5 15.5L21 21',
  previous: 'M6 15l6-6 6 6',
  next: 'M6 9l6 6 6-6',
  close: 'M6 6l12 12 M18 6L6 18',
  devTools: 'M8 8l-4 4 4 4 M16 8l4 4-4 4 M14 5l-4 14',
  download: 'M12 3v12 M7 10l5 5 5-5 M5 21h14',
  folder: 'M3 6.5h7l2 2h9v10H3z',
  extension: 'M9 3h6v5h5v6h-5v7H9v-7H4V8h5z',
  trash: 'M4 7h16 M9 7V4h6v3 M7 7l1 14h8l1-14',
  more: 'M12 5h.01 M12 12h.01 M12 19h.01',
};

const EMPTY_FIND_RESULT: GianBrowserFindResult = {
  requestId: 0,
  activeMatchOrdinal: 0,
  matches: 0,
  finalUpdate: true,
};

function formatDownloadBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${Math.round(value / 1_024)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

/** The native WebContentsView paints above the DOM and cannot inherit the
 * themed `.browser-viewport` background, so the renderer pushes its computed
 * `--surface` color to the main process. Electron's setBackgroundColor does
 * not parse oklch(), so resolve through a canvas pixel to sRGB rgba(). */
function readSurfaceColor(): string | null {
  const raw = getComputedStyle(document.body).getPropertyValue('--surface').trim();
  if (!raw) return null;
  if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
    && !CSS.supports('color', raw)) return null;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.fillStyle = raw;
  context.fillRect(0, 0, 1, 1);
  const pixel = context.getImageData(0, 0, 1, 1).data;
  const r = pixel[0] ?? 0;
  const g = pixel[1] ?? 0;
  const b = pixel[2] ?? 0;
  const a = pixel[3] ?? 255;
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
}

export function BrowserPanel({
  tabId,
  visible,
  contextTargetSessionId = null,
  onTitleChange,
}: {
  tabId: string;
  visible: boolean;
  contextTargetSessionId?: string | null;
  onTitleChange?: (name: string) => void;
}) {
  const t = useT();
  const dispatch = useOperationDispatch();
  const openingExternal = useOperationPending(browserExternalEntityKey(tabId), 'browser.openExternal');
  const viewportRef = useRef<HTMLDivElement>(null);
  const addressInputRef = useRef<HTMLInputElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const lastBounds = useRef<GianBrowserBounds>({ x: 0, y: 0, width: 0, height: 0 });
  const lastSentLayout = useRef<{ bounds: GianBrowserBounds; visible: boolean } | null>(null);
  const [state, setState] = useState<GianBrowserState>(EMPTY_STATE);
  const [address, setAddress] = useState('');
  const [editing, setEditing] = useState(false);
  const [inputError, setInputError] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState('');
  const [findResult, setFindResult] = useState<GianBrowserFindResult>(EMPTY_FIND_RESULT);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [downloads, setDownloads] = useState<GianBrowserDownload[]>([]);
  const downloadsRevisionRef = useRef(-1);
  const [permissionRequests, setPermissionRequests] = useState<GianBrowserPermissionRequest[]>([]);
  const permissionsRevisionRef = useRef(-1);
  const [extensionsOpen, setExtensionsOpen] = useState(false);
  const [extensions, setExtensions] = useState<GianBrowserExtension[]>([]);
  const extensionsRevisionRef = useRef(-1);
  const [menuOpen, setMenuOpen] = useState(false);
  // Freeze-frame shown under the ⋯ menu overlay (2026-09-15 owner): Electron's
  // native webview always paints above renderer HTML, so instead of squeezing
  // the page narrower (which reflowed it across its media-query breakpoints),
  // the menu floats over a captured frame while the native view is hidden.
  const [frozenFrame, setFrozenFrame] = useState<string | null>(null);
  const browser = desktopBridge()?.browser;
  const contextTargetRef = useRef(contextTargetSessionId);
  contextTargetRef.current = contextTargetSessionId;
  const previousContextTargetRef = useRef(contextTargetSessionId);
  const inspectTargetRef = useRef<string | null>(null);
  // Latest zoom factor this panel acts on. Local zoom actions update it
  // synchronously so back-to-back shortcut presses never compute from React
  // state that the setZoom IPC round-trip has not flushed yet.
  const zoomFactorRef = useRef(DEFAULT_BROWSER_ZOOM_FACTOR);
  // The initial EMPTY_STATE is a placeholder, not a live reading: only forward
  // titles once real native state has arrived (getState/subscribe/action).
  const stateReceivedRef = useRef(false);
  const lastReportedNameRef = useRef<string | null>(null);
  const applyState = useCallback((next: GianBrowserState) => {
    stateReceivedRef.current = true;
    zoomFactorRef.current = next.zoomFactor;
    setState(next);
  }, []);
  const openFind = useCallback(() => {
    setMenuOpen(false);
    setDownloadsOpen(false);
    setExtensionsOpen(false);
    setFindOpen(true);
  }, []);

  useEffect(() => {
    if (!browser) return;
    let active = true;
    void browser.getState(tabId).then(next => {
      if (active) applyState(next);
    });
    const unsubscribe = browser.subscribe((changedTabId, next) => {
      if (active && changedTabId === tabId) applyState(next);
    });
    const unsubscribeElement = browser.subscribeElement((changedTabId, capture) => {
      const sessionId = inspectTargetRef.current;
      inspectTargetRef.current = null;
      if (
        !active
        || changedTabId !== tabId
        || !sessionId
        || contextTargetRef.current !== sessionId
      ) return;
      const added = injectComposerContextItems(sessionId, [{
        type: 'browserElement',
        id: crypto.randomUUID(),
        ...capture,
      }]);
      if (!added) toast({ kind: 'warning', message: t('composer.context.limitReached') });
    });
    const unsubscribeFind = browser.subscribeFind((changedTabId, result) => {
      if (active && changedTabId === tabId) setFindResult(result);
    });
    const unsubscribeFindRequested = browser.subscribeFindRequested(changedTabId => {
      if (active && changedTabId === tabId) openFind();
    });
    const unsubscribeAddressRequested = browser.subscribeAddressRequested(changedTabId => {
      if (active && changedTabId === tabId) {
        addressInputRef.current?.focus();
        addressInputRef.current?.select();
      }
    });
    const applyDownloads = (snapshot: GianBrowserDownloadsSnapshot) => {
      if (!active || snapshot.revision <= downloadsRevisionRef.current) return;
      downloadsRevisionRef.current = snapshot.revision;
      setDownloads(snapshot.downloads);
    };
    const unsubscribeDownloads = browser.subscribeDownloads(applyDownloads);
    void browser.listDownloads().then(applyDownloads, () => {});
    const applyPermissions = (snapshot: GianBrowserPermissionsSnapshot) => {
      if (!active || snapshot.revision <= permissionsRevisionRef.current) return;
      permissionsRevisionRef.current = snapshot.revision;
      setPermissionRequests(snapshot.requests);
    };
    const unsubscribePermissions = browser.subscribePermissions(applyPermissions);
    void browser.listPermissionRequests().then(applyPermissions, () => {});
    const applyExtensions = (snapshot: GianBrowserExtensionsSnapshot) => {
      if (!active || snapshot.revision <= extensionsRevisionRef.current) return;
      extensionsRevisionRef.current = snapshot.revision;
      setExtensions(snapshot.extensions);
    };
    const unsubscribeExtensions = browser.subscribeExtensions(applyExtensions);
    void browser.listExtensions().then(applyExtensions, () => {});
    return () => {
      active = false;
      unsubscribe();
      unsubscribeElement();
      unsubscribeFind();
      unsubscribeFindRequested();
      unsubscribeAddressRequested();
      unsubscribeDownloads();
      unsubscribePermissions();
      unsubscribeExtensions();
    };
  }, [browser, tabId, t, applyState, openFind]);

  useEffect(() => {
    if (findOpen) findInputRef.current?.focus();
  }, [findOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const focusFrame = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    });
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !menuButtonRef.current?.contains(target)) {
        setMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMenuOpen(false);
      menuButtonRef.current?.focus();
    };
    document.addEventListener('pointerdown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('pointerdown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!visible) {
      setMenuOpen(false);
      setFrozenFrame(null);
    }
  }, [visible]);

  // Menu closed → let the native view reattach and repaint before dropping
  // the freeze frame, so the page never flashes blank.
  useEffect(() => {
    if (menuOpen || frozenFrame === null) return;
    const timer = window.setTimeout(() => setFrozenFrame(null), 150);
    return () => window.clearTimeout(timer);
  }, [menuOpen, frozenFrame]);

  // Sheet tab name follows the page title; a blank tab falls back to the
  // default name. Guarded by the last reported name so state echoes never
  // re-trigger the parent rename.
  useEffect(() => {
    if (!onTitleChange || !stateReceivedRef.current) return;
    const name = state.title.trim() || DEFAULT_BROWSER_TAB_NAME;
    if (lastReportedNameRef.current === name) return;
    lastReportedNameRef.current = name;
    onTitleChange(name);
  }, [state.title, onTitleChange]);

  // Push the themed surface color to the native view, re-sending on theme
  // switches (body[data-theme] flips outside this component).
  useEffect(() => {
    if (!browser) return;
    const send = () => {
      const color = readSurfaceColor();
      if (color) void browser.setBackground(tabId, color);
    };
    send();
    const observer = new MutationObserver(send);
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, [browser, tabId]);

  const applyZoom = useCallback((factor: number) => {
    if (!browser) return;
    zoomFactorRef.current = factor;
    void browser.setZoom(tabId, factor).then(applyState);
  }, [browser, tabId, applyState]);

  // Renderer-side zoom keys for when the native view is NOT focused (when it
  // is, the main process intercepts them via before-input-event).
  useEffect(() => {
    if (!browser || !visible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'l') {
        event.preventDefault();
        addressInputRef.current?.focus();
        addressInputRef.current?.select();
        return;
      }
      if (key === 'r') {
        event.preventDefault();
        void browser.reload(tabId).then(applyState);
        return;
      }
      if (key === 't') {
        event.preventDefault();
        void browser.createTab({ sourceSessionId: contextTargetSessionId, activate: true });
        return;
      }
      if (key === 'w') {
        event.preventDefault();
        void browser.closeTab(tabId);
        return;
      }
      if (key === '[') {
        event.preventDefault();
        void browser.goBack(tabId).then(applyState);
        return;
      }
      if (key === ']') {
        event.preventDefault();
        void browser.goForward(tabId).then(applyState);
        return;
      }
      if (key === 'f') {
        event.preventDefault();
        openFind();
        return;
      }
      if (event.key === '=' || event.key === '+') {
        event.preventDefault();
        applyZoom(stepBrowserZoomFactor(zoomFactorRef.current, 1));
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        applyZoom(stepBrowserZoomFactor(zoomFactorRef.current, -1));
      } else if (event.key === '0') {
        event.preventDefault();
        applyZoom(DEFAULT_BROWSER_ZOOM_FACTOR);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [browser, visible, applyZoom, openFind, tabId, contextTargetSessionId, applyState]);

  useEffect(() => {
    const changed = previousContextTargetRef.current !== contextTargetSessionId;
    previousContextTargetRef.current = contextTargetSessionId;
    if (!browser || !changed || !state.inspecting) return;
    inspectTargetRef.current = null;
    void browser.setInspectMode(tabId, false).then(applyState);
  }, [browser, contextTargetSessionId, state.inspecting, tabId, applyState]);

  function toggleInspect(): void {
    const enabled = !state.inspecting;
    inspectTargetRef.current = enabled ? contextTargetSessionId : null;
    void browser?.setInspectMode(tabId, enabled).then(applyState);
  }

  useEffect(() => {
    if (!editing) setAddress(state.url);
  }, [editing, state.url]);

  // The ⋯ menu overlays a freeze frame instead of squeezing the page, so the
  // native view hides while the menu is open.
  const nativeVisible = visible && !menuOpen;

  useLayoutEffect(() => {
    if (!browser) return;
    const viewport = viewportRef.current;
    if (!viewport) return;

    let frame = 0;
    const sync = () => {
      const rect = viewport.getBoundingClientRect();
      const bounds = {
        x: Math.max(0, Math.round(rect.left)),
        y: Math.max(0, Math.round(rect.top)),
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
      };
      lastBounds.current = bounds;
      const previous = lastSentLayout.current;
      if (
        !previous
        || previous.visible !== nativeVisible
        || previous.bounds.x !== bounds.x
        || previous.bounds.y !== bounds.y
        || previous.bounds.width !== bounds.width
        || previous.bounds.height !== bounds.height
      ) {
        lastSentLayout.current = { bounds, visible: nativeVisible };
        void browser.setLayout(tabId, bounds, nativeVisible);
      }
      if (nativeVisible) frame = requestAnimationFrame(sync);
    };

    sync();
    return () => {
      cancelAnimationFrame(frame);
      lastSentLayout.current = { bounds: lastBounds.current, visible: false };
      void browser.setLayout(tabId, lastBounds.current, false);
    };
  }, [browser, tabId, nativeVisible]);

  function submitAddress(event: FormEvent): void {
    event.preventDefault();
    if (!browser) return;
    const normalized = normalizeBrowserAddress(address);
    if (!normalized) {
      setInputError(true);
      return;
    }
    setInputError(false);
    setEditing(false);
    void browser.navigate(tabId, normalized).then(applyState);
  }

  function searchPage(text: string, forward: boolean, findNext: boolean): void {
    if (!text.trim()) {
      setFindResult(EMPTY_FIND_RESULT);
      void browser?.stopFindInPage(tabId);
      return;
    }
    void browser?.findInPage(tabId, text, { forward, findNext });
  }

  function submitFind(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    searchPage(findText, true, true);
  }

  function closeFind(): void {
    setFindOpen(false);
    setFindResult(EMPTY_FIND_RESULT);
    void browser?.stopFindInPage(tabId);
  }

  function toggleDownloads(): void {
    setMenuOpen(false);
    setFindOpen(false);
    setExtensionsOpen(false);
    setDownloadsOpen(open => !open);
    if (findOpen) void browser?.stopFindInPage(tabId);
  }

  function toggleExtensions(): void {
    setMenuOpen(false);
    setFindOpen(false);
    setDownloadsOpen(false);
    setExtensionsOpen(open => !open);
    if (findOpen) void browser?.stopFindInPage(tabId);
  }

  function toggleMenu(): void {
    if (menuOpen) {
      setMenuOpen(false);
      return;
    }
    if (findOpen) closeFind();
    setDownloadsOpen(false);
    setExtensionsOpen(false);
    if (!browser) {
      setMenuOpen(true);
      return;
    }
    // Capture first, then overlay: the frame is in place before the native
    // view hides, so the page reads as frozen — never resized.
    void browser.captureFrame(tabId).then(frame => {
      setFrozenFrame(frame);
      setMenuOpen(true);
    });
  }

  function handleFindKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeFind();
    } else if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault();
      searchPage(findText, false, true);
    }
  }

  if (!browser) {
    return <div className="browser-unavailable">{t('browser.desktopOnly')}</div>;
  }

  const activeDownloadCount = downloads.filter(download => download.canCancel).length;
  const permissionRequest = permissionRequests.find(request => request.tabId === tabId) ?? null;

  return (
    <div className="browser-panel" data-testid="browser-panel">
      <div className="browser-toolbar">
        <button type="button" className="browser-tool" disabled={!state.canGoBack}
                aria-label={t('browser.back')} onClick={() => void browser.goBack(tabId).then(applyState)}>
          <Icon d={ICONS.back} />
        </button>
        <button type="button" className="browser-tool" disabled={!state.canGoForward}
                aria-label={t('browser.forward')} onClick={() => void browser.goForward(tabId).then(applyState)}>
          <Icon d={ICONS.forward} />
        </button>
        <button type="button" className="browser-tool"
                aria-label={state.loading ? t('browser.stop') : t('browser.reload')}
                disabled={!state.url}
                onClick={() => void (state.loading ? browser.stop(tabId) : browser.reload(tabId)).then(applyState)}>
          <Icon d={state.loading ? ICONS.stop : ICONS.reload} />
        </button>
        <form className={`browser-address${inputError ? ' invalid' : ''}`} onSubmit={submitAddress}>
          {state.loading && <span className="browser-loading" aria-hidden />}
          <input
            ref={addressInputRef}
            aria-label={t('browser.address')}
            value={address}
            placeholder={t('browser.address.placeholder')}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            onFocus={event => { setEditing(true); event.currentTarget.select(); }}
            onBlur={() => { setEditing(false); setAddress(state.url); setInputError(false); }}
            onChange={event => { setAddress(event.target.value); setInputError(false); }}
          />
        </form>
        <button
          type="button"
          className={`browser-tool${state.inspecting ? ' is-active' : ''}`}
          disabled={!state.url || !contextTargetSessionId}
          aria-label={t('browser.inspectElement')}
          title={state.url && contextTargetSessionId
            ? t('browser.inspectElement')
            : t('browser.inspectElementUnavailable')}
          aria-pressed={state.inspecting}
          onClick={toggleInspect}
        >
          <Icon d={ICONS.inspect} />
        </button>
        <button type="button" className="browser-tool" disabled={!state.canOpenExternal || openingExternal}
                aria-label={t('browser.openExternal')}
                title={t('browser.openExternal')}
                onClick={() => dispatch('browser.openExternal', { tabId })}>
          <Icon d={ICONS.external} />
        </button>
        <button ref={menuButtonRef} type="button"
                className={`browser-tool${menuOpen ? ' is-active' : ''}`}
                aria-label={t('browser.more')}
                title={t('browser.more')}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={toggleMenu}>
          <Icon d={ICONS.more} />
        </button>
      </div>
      {findOpen && (
        <form className="browser-find" aria-label={t('browser.find')} onSubmit={submitFind}>
          <Icon d={ICONS.find} />
          <input
            ref={findInputRef}
            aria-label={t('browser.find.input')}
            value={findText}
            onChange={event => {
              setFindText(event.target.value);
              searchPage(event.target.value, true, false);
            }}
            onKeyDown={handleFindKeyDown}
          />
          <output aria-live="polite">
            {findResult.matches > 0 ? `${findResult.activeMatchOrdinal}/${findResult.matches}` : '0/0'}
          </output>
          <button type="button" className="browser-tool" disabled={!findText.trim()}
                  aria-label={t('browser.find.previous')}
                  onClick={() => searchPage(findText, false, true)}>
            <Icon d={ICONS.previous} />
          </button>
          <button type="button" className="browser-tool" disabled={!findText.trim()}
                  aria-label={t('browser.find.next')}
                  onClick={() => searchPage(findText, true, true)}>
            <Icon d={ICONS.next} />
          </button>
          <button type="button" className="browser-tool" aria-label={t('browser.find.close')}
                  onClick={closeFind}>
            <Icon d={ICONS.close} />
          </button>
        </form>
      )}
      {downloadsOpen && (
        <div className="browser-downloads" aria-label={t('browser.downloads')}>
          {downloads.length === 0 && (
            <div className="browser-download-empty">{t('browser.downloads.empty')}</div>
          )}
          {downloads.map(download => (
            <div className="browser-download-row" key={download.id}>
              <div className="browser-download-copy">
                <strong title={download.filename}>{download.filename}</strong>
                <span>{t(`browser.download.${download.status}`)}</span>
              </div>
              <span className="browser-download-size">
                {formatDownloadBytes(download.receivedBytes)}
                {download.totalBytes > 0 ? ` / ${formatDownloadBytes(download.totalBytes)}` : ''}
              </span>
              {download.canReveal && (
                <button type="button" className="browser-tool"
                        aria-label={t('browser.download.reveal')}
                        onClick={() => void browser.revealDownload(download.id)}>
                  <Icon d={ICONS.folder} />
                </button>
              )}
              {download.canCancel && (
                <button type="button" className="browser-tool"
                        aria-label={t('browser.download.cancel')}
                        onClick={() => void browser.cancelDownload(download.id)}>
                  <Icon d={ICONS.close} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {extensionsOpen && (
        <div className="browser-extensions" aria-label={t('browser.extensions')}>
          <div className="browser-extension-header">
            <span>{t('browser.extensions')}</span>
            <button type="button" className="btn secondary"
                    onClick={() => void browser.installExtension()}>
              {t('browser.extension.install')}
            </button>
          </div>
          {extensions.length === 0 && (
            <div className="browser-extension-empty">{t('browser.extensions.empty')}</div>
          )}
          {extensions.map(extension => (
            <div className="browser-extension-row" key={extension.key}>
              <label className="browser-extension-toggle">
                <input type="checkbox" checked={extension.enabled}
                       aria-label={`${extension.name} ${t('browser.extension.enabled')}`}
                       onChange={event => void browser.setExtensionEnabled(
                         extension.key,
                         event.target.checked,
                       )} />
                <span />
              </label>
              <div className="browser-extension-copy">
                <strong title={extension.name}>{extension.name}</strong>
                <span>{extension.version
                  ? `${extension.version} · ${t(`browser.extension.${extension.status}`)}`
                  : t(`browser.extension.${extension.status}`)}</span>
                {extension.error && <em title={extension.error}>{extension.error}</em>}
                {!extension.error && extension.warnings[0] && (
                  <em title={extension.warnings.join('\n')}>{extension.warnings[0]}</em>
                )}
              </div>
              <button type="button" className="browser-tool"
                      aria-label={t('browser.extension.remove')}
                      onClick={() => void browser.removeExtension(extension.key)}>
                <Icon d={ICONS.trash} />
              </button>
            </div>
          ))}
        </div>
      )}
      {permissionRequest && (
        <div className="browser-permission" role="alertdialog"
             aria-label={t('browser.permission.request')}>
          <div className="browser-permission-copy">
            <strong>{permissionRequest.origin}</strong>
            <span>{permissionRequest.kinds
              .map(kind => t(`browser.permission.${kind}`))
              .join(', ')}</span>
          </div>
          <button type="button" className="btn secondary"
                  onClick={() => void browser.respondPermission(permissionRequest.id, 'deny')}>
            {t('browser.permission.deny')}
          </button>
          <button type="button" className="btn secondary"
                  onClick={() => void browser.respondPermission(permissionRequest.id, 'allow_once')}>
            {t('browser.permission.allowOnce')}
          </button>
          <button type="button" className="btn primary"
                  onClick={() => void browser.respondPermission(permissionRequest.id, 'allow_always')}>
            {t('browser.permission.allowAlways')}
          </button>
        </div>
      )}
      {state.error && (
        <div className="browser-status" role="status">
          <span>{state.error}</span>
          {state.recoverable && (
            <button type="button" className="btn secondary"
                    onClick={() => void browser.recover(tabId).then(applyState)}>
              {t('browser.recover')}
            </button>
          )}
        </div>
      )}
      <div className="browser-stage">
        <div className="browser-viewport" ref={viewportRef} aria-label={t('browser.viewport')} />
        {frozenFrame && (
          <img className="browser-freeze" src={frozenFrame} alt="" aria-hidden="true" draggable={false} />
        )}
        {menuOpen && (
          <div className="browser-menu" ref={menuRef} role="menu" aria-label={t('browser.more')}>
            <button type="button" className="browser-menu-item" role="menuitem"
                    disabled={!state.url} onClick={openFind}>
              <Icon d={ICONS.find} />
              <span>{t('browser.find')}</span>
            </button>
            <div className="browser-menu-separator" />
            <div className="browser-menu-zoom" role="group" aria-label={t('browser.zoom')}>
              <span>{t('browser.zoom')}</span>
              <div className="browser-menu-zoom-controls">
                <button type="button" className="browser-tool"
                        aria-label={t('browser.zoomOut')}
                        disabled={state.zoomFactor <= MIN_BROWSER_ZOOM_FACTOR}
                        onClick={() => applyZoom(stepBrowserZoomFactor(zoomFactorRef.current, -1))}>
                  <Icon d={ICONS.zoomOut} />
                </button>
                <button type="button" className="browser-tool browser-zoom-level"
                        aria-label={t('browser.zoomReset')}
                        title={t('browser.zoomReset')}
                        disabled={state.zoomFactor === DEFAULT_BROWSER_ZOOM_FACTOR}
                        onClick={() => applyZoom(DEFAULT_BROWSER_ZOOM_FACTOR)}>
                  {Math.round(state.zoomFactor * 100)}%
                </button>
                <button type="button" className="browser-tool"
                        aria-label={t('browser.zoomIn')}
                        disabled={state.zoomFactor >= MAX_BROWSER_ZOOM_FACTOR}
                        onClick={() => applyZoom(stepBrowserZoomFactor(zoomFactorRef.current, 1))}>
                  <Icon d={ICONS.zoomIn} />
                </button>
              </div>
            </div>
            <div className="browser-menu-separator" />
            <button type="button" className="browser-menu-item" role="menuitem"
                    onClick={toggleDownloads}>
              <Icon d={ICONS.download} />
              <span>{t('browser.downloads')}</span>
              {activeDownloadCount > 0 && <span className="browser-menu-badge">{activeDownloadCount}</span>}
            </button>
            <button type="button" className="browser-menu-item" role="menuitem"
                    onClick={toggleExtensions}>
              <Icon d={ICONS.extension} />
              <span>{t('browser.extensions')}</span>
            </button>
            <div className="browser-menu-separator" />
            <button type="button" className="browser-menu-item" role="menuitem"
                    disabled={!state.url}
                    onClick={() => { setMenuOpen(false); void browser.openDevTools(tabId); }}>
              <Icon d={ICONS.devTools} />
              <span>{t('browser.devTools')}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
