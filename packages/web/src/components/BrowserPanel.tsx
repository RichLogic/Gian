import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import type { GianBrowserBounds, GianBrowserState } from '@gian/shared';
import { desktopBridge } from '../desktop-bridge.js';
import { useT } from '../i18n/index.js';
import { normalizeBrowserAddress } from '../presentation/browser-address.js';
import {
  browserExternalEntityKey,
} from '../operations/browser.js';
import { useOperationDispatch, useOperationPending } from '../operations/use-operations.js';

const EMPTY_STATE: GianBrowserState = {
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  canOpenExternal: false,
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
};

export function BrowserPanel({ tabId, visible }: { tabId: string; visible: boolean }) {
  const t = useT();
  const dispatch = useOperationDispatch();
  const openingExternal = useOperationPending(browserExternalEntityKey(tabId), 'browser.openExternal');
  const viewportRef = useRef<HTMLDivElement>(null);
  const lastBounds = useRef<GianBrowserBounds>({ x: 0, y: 0, width: 0, height: 0 });
  const lastSentLayout = useRef<{ bounds: GianBrowserBounds; visible: boolean } | null>(null);
  const [state, setState] = useState<GianBrowserState>(EMPTY_STATE);
  const [address, setAddress] = useState('');
  const [editing, setEditing] = useState(false);
  const [inputError, setInputError] = useState(false);
  const browser = desktopBridge()?.browser;

  useEffect(() => {
    if (!browser) return;
    let active = true;
    void browser.getState(tabId).then(next => {
      if (active) setState(next);
    });
    const unsubscribe = browser.subscribe((changedTabId, next) => {
      if (active && changedTabId === tabId) setState(next);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [browser, tabId]);

  useEffect(() => {
    if (!editing) setAddress(state.url);
  }, [editing, state.url]);

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
        || previous.visible !== visible
        || previous.bounds.x !== bounds.x
        || previous.bounds.y !== bounds.y
        || previous.bounds.width !== bounds.width
        || previous.bounds.height !== bounds.height
      ) {
        lastSentLayout.current = { bounds, visible };
        void browser.setLayout(tabId, bounds, visible);
      }
      if (visible) frame = requestAnimationFrame(sync);
    };

    sync();
    return () => {
      cancelAnimationFrame(frame);
      lastSentLayout.current = { bounds: lastBounds.current, visible: false };
      void browser.setLayout(tabId, lastBounds.current, false);
    };
  }, [browser, tabId, visible]);

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
    void browser.navigate(tabId, normalized).then(setState);
  }

  if (!browser) {
    return <div className="browser-unavailable">{t('browser.desktopOnly')}</div>;
  }

  return (
    <div className="browser-panel" data-testid="browser-panel">
      <div className="browser-toolbar">
        <button type="button" className="browser-tool" disabled={!state.canGoBack}
                aria-label={t('browser.back')} onClick={() => void browser.goBack(tabId).then(setState)}>
          <Icon d={ICONS.back} />
        </button>
        <button type="button" className="browser-tool" disabled={!state.canGoForward}
                aria-label={t('browser.forward')} onClick={() => void browser.goForward(tabId).then(setState)}>
          <Icon d={ICONS.forward} />
        </button>
        <button type="button" className="browser-tool"
                aria-label={state.loading ? t('browser.stop') : t('browser.reload')}
                disabled={!state.url}
                onClick={() => void (state.loading ? browser.stop(tabId) : browser.reload(tabId)).then(setState)}>
          <Icon d={state.loading ? ICONS.stop : ICONS.reload} />
        </button>
        <form className={`browser-address${inputError ? ' invalid' : ''}`} onSubmit={submitAddress}>
          {state.loading && <span className="browser-loading" aria-hidden />}
          <input
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
        <button type="button" className="browser-tool" disabled={!state.canOpenExternal || openingExternal}
                aria-label={t('browser.openExternal')}
                onClick={() => dispatch('browser.openExternal', { tabId })}>
          <Icon d={ICONS.external} />
        </button>
      </div>
      {state.error && <div className="browser-status" role="status">{state.error}</div>}
      <div className="browser-viewport" ref={viewportRef} aria-label={t('browser.viewport')} />
    </div>
  );
}
