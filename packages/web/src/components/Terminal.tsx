import { useEffect, useRef } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { GianWs } from '../ws.js';

export interface TerminalProps {
  sessionId: string;
  ws: GianWs;
}

/**
 * xterm.js panel for the TTY runtime mode.
 *
 * Wiring:
 *   1. On mount: spin up an xterm instance, attach FitAddon + WebLinksAddon,
 *      ask the server for the ring-buffer replay so we can prime the
 *      screen with whatever the PTY has already printed.
 *   2. Subscribe to `pty:output` / `pty:replay` messages for this session.
 *   3. xterm input → `pty:input` (base64-encoded raw bytes).
 *   4. ResizeObserver → `pty:resize` (cols/rows after FitAddon recomputes).
 *
 * The component is mounted lazily by CodingView when
 * `session.runtime_mode === 'tty'`, so the xterm CSS / bundle cost is
 * only paid when the user actually switches modes.
 */
export function Terminal({ sessionId, ws }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Xterm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Xterm({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      // Lean towards the project's dark/warm palette. xterm's default is
      // pure black on white which looks alien against the app shell.
      theme: {
        background: '#0c0c0e',
        foreground: '#e6e6e6',
        cursor: '#f5c95a',
      },
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    const links = new WebLinksAddon();
    term.loadAddon(fit);
    term.loadAddon(links);
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    // Forward keystrokes / paste to the server as base64.
    const dataDisp = term.onData(data => {
      const bytes = new TextEncoder().encode(data);
      ws.send({ type: 'pty:input', session_id: sessionId, data: bytesToBase64(bytes) });
    });

    // Push initial size, then fit-on-resize.
    const pushResize = () => {
      try {
        fit.fit();
      } catch { /* before layout settles */ }
      const cols = term.cols;
      const rows = term.rows;
      if (cols > 0 && rows > 0) {
        ws.send({ type: 'pty:resize', session_id: sessionId, cols, rows });
      }
    };
    pushResize();
    const resizeObserver = new ResizeObserver(() => {
      pushResize();
    });
    resizeObserver.observe(containerRef.current);

    // Subscribe to server output for this session.
    const offMsg = ws.onMessage(msg => {
      if (msg.type === 'pty:output' && msg.session_id === sessionId) {
        const bytes = base64ToBytes(msg.data);
        term.write(bytes);
      } else if (msg.type === 'pty:replay' && msg.session_id === sessionId) {
        // Clear before replay so we don't double-print on refresh.
        term.reset();
        for (const chunk of msg.chunks) {
          term.write(base64ToBytes(chunk));
        }
      }
    });

    // Ask server for the ring-buffer replay so a freshly-mounted Terminal
    // shows the in-progress screen (boot banner, in-flight output) rather
    // than an empty void until the next byte arrives.
    ws.send({ type: 'pty:replay-request', session_id: sessionId });

    return () => {
      dataDisp.dispose();
      resizeObserver.disconnect();
      offMsg();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId, ws]);

  return <div className="gian-terminal" ref={containerRef} />;
}

function bytesToBase64(bytes: Uint8Array): string {
  // Avoid String.fromCharCode chunking issues on very large buffers — for
  // typical keystroke input this is fine, but be defensive in case the
  // user pastes a megabyte. btoa wants a latin1 string; map byte-wise.
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
