import { useEffect, useRef } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { GianWs } from '../ws.js';

/**
 * Adapter that lets the Terminal component send/receive PTY bytes
 * without caring about which channel they're routed through. Two
 * concrete wires today:
 *
 *   - sessionWire(ws, sessionId)   — `pty:*` family, cc-proxy backed
 *   - workbenchWire(ws, termId)    — `term:*` family, host-backed shell
 *
 * Each `subscribe()` is called once on mount and returns an
 * unsubscribe function; the component does not assume anything about
 * how chunks are framed past "raw bytes."
 */
export interface TerminalWire {
  sendInput(bytes: Uint8Array): void;
  sendResize(cols: number, rows: number): void;
  requestReplay(): void;
  /**
   * Optional spawn step — workbench wire uses this to ask the host to
   * actually start a shell on mount. Session wire spawns elsewhere
   * (via the runtime-mode switch), so this is a no-op there.
   */
  spawn?(cols: number, rows: number): void;
  /** Hand back unsubscribe. Implementations decide which WS messages
   *  to listen for; both onChunk and onReplay receive raw bytes. */
  subscribe(handlers: {
    onChunk: (bytes: Uint8Array) => void;
    onReplay: (chunks: Uint8Array[]) => void;
  }): () => void;
  /** Optional: tear down the server-side resource. Workbench wire
   *  uses this to kill the shell when the tab closes; session wire
   *  doesn't (the user keeps the PTY across the mount). */
  dispose?(): void;
}

export interface TerminalProps {
  wire: TerminalWire;
  /** Stable key so React unmounts the xterm when the bound resource
   *  changes (different sessionId / termId). */
  instanceKey: string;
}

/**
 * xterm.js panel — channel-agnostic. The owner picks the wire.
 */
export function Terminal({ wire, instanceKey }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // Stay in step with the rest of the app's mono surfaces — same
    // JetBrains Mono stack as `--font-mono`, slightly smaller than
    // xterm's stock 15px so it sits beside transcript / file viewers
    // without feeling bolted on. Line height a touch over 1.0 keeps
    // descenders from kissing the cell above.
    const term = new Xterm({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.25,
      letterSpacing: 0,
      theme: readThemeFromCss(containerRef.current),
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    const links = new WebLinksAddon();
    term.loadAddon(fit);
    term.loadAddon(links);
    term.open(containerRef.current);
    try { fit.fit(); } catch { /* before layout settles */ }

    // Apply current code-zone scale once at startup (config-driven).
    const initialRaw = getComputedStyle(document.body).getPropertyValue('--fz-13').trim();
    const initialPx = parseFloat(initialRaw);
    if (initialPx > 0 && Number.isFinite(initialPx)) {
      term.options.fontSize = initialPx;
    }

    // Re-paint when the user flips the app theme (light / warm / dark)
    // or accent. Cheap — xterm exposes `options.theme` as a settable
    // hook; we hand it the freshly-resolved RGB values from the host
    // element each time.
    const repaintTheme = () => {
      if (!containerRef.current) return;
      term.options.theme = readThemeFromCss(containerRef.current);
    };

    // Code-zone font scale is a CSS-only mechanism for the rest of the
    // app (--fz-* tokens multiply by --zone-scale), but xterm uses a
    // JS-driven fontSize. Read the resolved --fz-13 px value and apply
    // it, then refit so the cell grid matches the new metric.
    const applyCodeScale = () => {
      const raw = getComputedStyle(document.body).getPropertyValue('--fz-13').trim();
      const px = parseFloat(raw);
      if (px > 0 && Number.isFinite(px)) {
        term.options.fontSize = px;
        pushResize();
      }
    };

    const themeObserver = new MutationObserver(records => {
      for (const r of records) {
        if (r.attributeName === 'data-scale-code') applyCodeScale();
        else repaintTheme();
      }
    });
    themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-accent', 'data-scale-code'],
    });

    const dataDisp = term.onData(data => {
      wire.sendInput(new TextEncoder().encode(data));
    });

    // De-dup resize events: ResizeObserver fires many times during initial
    // layout settle, and every duplicate {cols,rows} we forward becomes a
    // SIGWINCH that zsh redraws its prompt for — visible as a stack of
    // repeated prompts at the top of the viewport.
    let lastCols = 0;
    let lastRows = 0;
    const pushResize = () => {
      try { fit.fit(); } catch { /* before layout settles */ }
      const { cols, rows } = term;
      if (cols > 0 && rows > 0 && (cols !== lastCols || rows !== lastRows)) {
        lastCols = cols;
        lastRows = rows;
        wire.sendResize(cols, rows);
      }
    };

    const resizeObserver = new ResizeObserver(() => { pushResize(); });
    resizeObserver.observe(containerRef.current);

    // Listener first, then spawn (if applicable), then replay request —
    // ordering matters: replay-request response races with the first
    // few bytes from a freshly-spawned PTY, so we want our subscriber
    // attached before either arrives.
    const off = wire.subscribe({
      onChunk: bytes => term.write(bytes),
      onReplay: chunks => {
        term.reset();
        for (const c of chunks) term.write(c);
      },
    });

    // Push initial size up so the spawn (if any) starts at the right
    // geometry, then either spawn or request replay.
    pushResize();
    if (wire.spawn) {
      wire.spawn(term.cols, term.rows);
    } else {
      wire.requestReplay();
    }

    // Layout often hasn't finalized by the time the initial fit() runs —
    // the parent island can still be growing into its flex slot. Force a
    // re-fit a few frames later; pushResize() is idempotent on unchanged
    // {cols,rows} so this is a no-op when the first fit was already right.
    const lateFitTimers: number[] = [];
    const scheduleRefit = (ms: number) => {
      lateFitTimers.push(window.setTimeout(() => pushResize(), ms));
    };
    requestAnimationFrame(() => requestAnimationFrame(() => pushResize()));
    scheduleRefit(100);
    scheduleRefit(500);

    return () => {
      for (const id of lateFitTimers) clearTimeout(id);
      dataDisp.dispose();
      resizeObserver.disconnect();
      themeObserver.disconnect();
      off();
      term.dispose();
      wire.dispose?.();
    };
    // `wire` is recreated on every parent render, so we deliberately
    // ignore it in deps — the parent passes a stable `instanceKey` to
    // signal genuine resource changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceKey]);

  return <div className="gian-terminal" ref={containerRef} />;
}

// ---------------------------------------------------------------------------
// Theme bridge
// ---------------------------------------------------------------------------

/**
 * Resolve an xterm theme from the active CSS theme tokens.
 *
 * xterm needs concrete RGB / hex; our token palette is `oklch(...)`.
 * We can't just hand xterm the var name, but `getComputedStyle()` on
 * a real element resolves to an rgb string we can pass through.
 *
 * Re-runs on every theme/accent flip via the MutationObserver above.
 */
function readThemeFromCss(host: HTMLElement): ITheme {
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;';
  host.appendChild(probe);
  const get = (cssVar: string) => {
    probe.style.color = `var(${cssVar})`;
    return getComputedStyle(probe).color;
  };

  const fg = get('--text');
  const bg = get('--surface');
  const cursor = get('--accent');
  const muted = get('--text-3');
  // Selection alpha — xterm wants an rgb(a) string here. Pull --accent
  // and lower opacity so highlighted regions don't drown the cell.
  const accentRgb = cursor.startsWith('rgb(') ? cursor.replace('rgb(', 'rgba(').replace(')', ', 0.30)') : cursor;

  host.removeChild(probe);

  // For ANSI colors we lean on xterm's defaults; they're already well
  // tuned and overriding them theme-by-theme is a rabbit hole. The
  // foreground/background/cursor swap is what actually makes the panel
  // feel like part of the app.
  return {
    background: bg,
    foreground: fg,
    cursor,
    cursorAccent: bg,
    selectionBackground: accentRgb,
    // Dim variants used by xterm's "faint" attribute. Falling back to
    // --text-3 keeps low-priority output legible against the surface.
    brightBlack: muted,
  };
}

// ---------------------------------------------------------------------------
// Wire factories
// ---------------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, sub as unknown as number[]);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** Wire for the per-session TTY mode (cc-proxy backed). */
export function makeSessionWire(ws: GianWs, sessionId: string): TerminalWire {
  return {
    sendInput(bytes) {
      ws.send({ type: 'pty:input', session_id: sessionId, data: bytesToBase64(bytes) });
    },
    sendResize(cols, rows) {
      ws.send({ type: 'pty:resize', session_id: sessionId, cols, rows });
    },
    requestReplay() {
      ws.send({ type: 'pty:replay-request', session_id: sessionId });
    },
    subscribe(handlers) {
      return ws.onMessage(msg => {
        if (msg.type === 'pty:output' && msg.session_id === sessionId) {
          handlers.onChunk(base64ToBytes(msg.data));
        } else if (msg.type === 'pty:replay' && msg.session_id === sessionId) {
          handlers.onReplay(msg.chunks.map(base64ToBytes));
        }
      });
    },
  };
}

/** Wire for a workbench shell terminal (host-backed). */
export function makeWorkbenchWire(
  ws: GianWs,
  termId: string,
  opts: { cwd?: string; shell?: string } = {},
): TerminalWire {
  return {
    sendInput(bytes) {
      ws.send({ type: 'term:input', term_id: termId, data: bytesToBase64(bytes) });
    },
    sendResize(cols, rows) {
      ws.send({ type: 'term:resize', term_id: termId, cols, rows });
    },
    requestReplay() {
      ws.send({ type: 'term:replay-request', term_id: termId });
    },
    spawn(cols, rows) {
      ws.send({
        type: 'term:spawn',
        term_id: termId,
        cols,
        rows,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.shell ? { shell: opts.shell } : {}),
      });
    },
    dispose() {
      ws.send({ type: 'term:close', term_id: termId });
    },
    subscribe(handlers) {
      return ws.onMessage(msg => {
        if (msg.type === 'term:output' && msg.term_id === termId) {
          handlers.onChunk(base64ToBytes(msg.data));
        } else if (msg.type === 'term:replay' && msg.term_id === termId) {
          handlers.onReplay(msg.chunks.map(base64ToBytes));
        }
      });
    },
  };
}
