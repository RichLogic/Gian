import { useState } from 'react';
import { useT } from '../i18n/index.js';

// ─── Pure navigation helpers (unit-tested in browser-body.test.tsx) ────────

export interface BrowserNavState {
  history: string[];
  idx: number;
}

/** Normalize a user-typed address into a full URL. Localhost / loopback /
 *  bare-IP targets default to http (the dev-preview case); everything else
 *  to https. Returns null for empty input. */
export function normalizeBrowserUrl(input: string): string | null {
  const v = input.trim();
  if (!v) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return v;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?([/?#]|$)/i.test(v)) return `http://${v}`;
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]|$)/.test(v)) return `http://${v}`;
  return `https://${v}`;
}

/** Push a navigation: truncates any forward entries (standard browser
 *  semantics) and caps history at 50 entries. */
export function browserNavPush(s: BrowserNavState, url: string): BrowserNavState {
  const next = [...s.history.slice(0, s.idx + 1), url].slice(-50);
  return { history: next, idx: next.length - 1 };
}

/** Move back/forward within history, clamped to the ends. */
export function browserNavGo(s: BrowserNavState, delta: -1 | 1): BrowserNavState {
  const idx = Math.min(Math.max(s.idx + delta, 0), s.history.length - 1);
  return idx === s.idx ? s : { ...s, idx };
}

/** Host portion of a URL, used as the tab title. Falls back to the raw url. */
export function browserHostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

const I = {
  back: 'M15 18l-6-6 6-6',
  forward: 'M9 18l6-6-6-6',
  reload: 'M3 12a9 9 0 0 1 15.5-6.3L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-15.5 6.3L3 16 M3 21v-5h5',
};

function Icon({ d, size = 14 }: { d: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
         strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

/** Browser tab body (v1): address bar + back/forward/reload + <iframe>.
 *  History is a plain per-tab array in component state — an iframe's own
 *  contentWindow history is cross-origin-restricted, and tabs stay mounted
 *  (display:none) so the state survives rail switches. Reload re-sets src
 *  via a key bump. Sites that send X-Frame-Options / frame-ancestors will
 *  refuse to render here; upgrading to an Electron <webview> is the planned
 *  escape hatch (no main-process change needed for the iframe v1). */
export function BrowserBody({ onNavigate }: { onNavigate?: (url: string) => void }) {
  const t = useT();
  const [nav, setNav] = useState<BrowserNavState>({ history: [], idx: -1 });
  const [address, setAddress] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const current = nav.idx >= 0 ? nav.history[nav.idx]! : null;

  function go(raw: string) {
    const url = normalizeBrowserUrl(raw);
    if (!url) return;
    setNav(prev => browserNavPush(prev, url));
    setAddress(url);
    onNavigate?.(url);
  }

  function goHistory(delta: -1 | 1) {
    setNav(prev => {
      const next = browserNavGo(prev, delta);
      const url = next.idx >= 0 ? next.history[next.idx]! : '';
      setAddress(url);
      if (url) onNavigate?.(url);
      return next;
    });
  }

  return (
    <div className="browser-body" data-testid="browser-body">
      <div className="browser-bar">
        <button
          type="button"
          className="browser-btn"
          title={t('topbar.back')}
          aria-label={t('topbar.back')}
          disabled={nav.idx <= 0}
          onClick={() => goHistory(-1)}
        >
          <Icon d={I.back} />
        </button>
        <button
          type="button"
          className="browser-btn"
          title={t('topbar.forward')}
          aria-label={t('topbar.forward')}
          disabled={nav.idx >= nav.history.length - 1}
          onClick={() => goHistory(1)}
        >
          <Icon d={I.forward} />
        </button>
        <button
          type="button"
          className="browser-btn"
          title={t('common.refresh')}
          aria-label={t('common.refresh')}
          disabled={!current}
          onClick={() => setReloadKey(k => k + 1)}
        >
          <Icon d={I.reload} />
        </button>
        <input
          className="browser-addr"
          value={address}
          placeholder={t('browser.address.placeholder')}
          aria-label={t('browser.address.placeholder')}
          onChange={e => setAddress(e.target.value)}
          onKeyDown={e => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === 'Enter') go(address);
          }}
          spellCheck={false}
        />
      </div>
      {current
        ? <iframe key={`${current}:${reloadKey}`} src={current} className="browser-frame" title={current} />
        : <div className="browser-empty">{t('browser.empty')}</div>}
    </div>
  );
}
