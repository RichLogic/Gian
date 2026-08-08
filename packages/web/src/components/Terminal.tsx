import { useEffect, useRef } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { TerminalWire } from './terminal-wire.js';

export interface TerminalProps {
  wire: TerminalWire;
  /** Stable key so React unmounts xterm when the terminal id changes. */
  instanceKey: string;
}

/**
 * xterm.js panel — channel-agnostic. The owner picks the wire.
 */
export function Terminal({ wire, instanceKey }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;

    // Stay in step with the rest of the app's mono surfaces — same
    // JetBrains Mono stack as `--font-mono`, slightly smaller than
    // xterm's stock 15px so it sits beside transcript / file viewers
    // without feeling bolted on. Line height a touch over 1.0 keeps
    // descenders from kissing the cell above.
    const term = new Xterm({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: readCodeFontSizeFromCss(container) ?? 12.5,
      lineHeight: 1.25,
      letterSpacing: 0,
      theme: readThemeFromCss(container),
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    const links = new WebLinksAddon();
    term.loadAddon(fit);
    term.loadAddon(links);
    term.open(container);
    try { fit.fit(); } catch { /* before layout settles */ }

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
      const px = readCodeFontSizeFromCss(container);
      if (px !== null) {
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

    const encoder = new TextEncoder();
    const sendInput = (data: string) => {
      wire.sendInput(encoder.encode(data));
    };

    const dataDisp = term.onData(data => {
      sendInput(data);
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
    resizeObserver.observe(container);

    // Listener first, then spawn (if applicable), then replay request —
    // ordering matters: replay-request response races with the first
    // few bytes from a freshly-spawned PTY, so we want our subscriber
    // attached before either arrives.
    const off = wire.subscribe({
      onChunk: bytes => term.write(bytes),
      onReplay: (chunks, state) => {
        term.reset();
        for (const c of chunks) term.write(c);
        if (!state.alive) writeExitStatus(term, state.code, state.signal);
      },
      onExit: (exitCode, signal) => {
        writeExitStatus(term, exitCode, signal);
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
    // ignore it in deps. `instanceKey` signals genuine resource changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceKey]);

  return <div className="gian-terminal" ref={containerRef} />;
}

function writeExitStatus(term: Xterm, exitCode: number | null, signal: string | null): void {
  const detail = signal ? `signal ${signal}` : `exit ${exitCode ?? 'unknown'}`;
  term.write(`\r\n[terminal ${detail}]\r\n`);
}

// ---------------------------------------------------------------------------
// Theme bridge
// ---------------------------------------------------------------------------

/** Resolve the code-zone font token to a concrete pixel value for xterm. */
function readCodeFontSizeFromCss(host: HTMLElement): number | null {
  // CSS custom properties retain their calc() expression when read directly.
  // A probe using the token as an actual font-size asks the browser to resolve
  // the host's code-zone --zone-scale into the px value xterm requires.
  const probe = document.createElement('span');
  probe.style.cssText = [
    'position:absolute',
    'visibility:hidden',
    'pointer-events:none',
    'font-size:var(--fz-13)',
  ].join(';');
  host.appendChild(probe);
  const px = parseFloat(getComputedStyle(probe).fontSize);
  host.removeChild(probe);
  return px > 0 && Number.isFinite(px) ? px : null;
}

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
