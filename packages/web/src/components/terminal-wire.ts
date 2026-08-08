import type { GianWs } from '../ws.js';
import type { OperationDispatcher } from '../operations/dispatcher.js';

export interface TerminalWire {
  sendInput(bytes: Uint8Array): void;
  sendResize(cols: number, rows: number): void;
  requestReplay(): void;
  spawn?(cols: number, rows: number): void;
  subscribe(handlers: {
    onChunk: (bytes: Uint8Array) => void;
    onReplay: (
      chunks: Uint8Array[],
      state: { alive: boolean; code: number | null; signal: string | null },
    ) => void;
    onExit?: (exitCode: number | null, signal: string | null) => void;
  }): () => void;
  dispose?(): void;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The Workbench terminal wire — the raw-stream exception of the UI Operation
 * Layer (proposal §4.1, inventory §3): `term:input`, `term:resize`, and
 * `term:replay-request` are per-keystroke/byte traffic and keep their direct
 * `ws.send` here. The one-shot lifecycle commands do NOT go through this
 * module: `spawn` dispatches the `term.spawn` operation via the `dispatch`
 * the caller injects (App's Sheet renderTab), and `term.close` is dispatched
 * by the Sheet tab-close path in use-workbench — see operations/terminal.ts
 * for the boundary rationale.
 */
export function makeWorkbenchWire(
  ws: GianWs,
  termId: string,
  options: { cwd?: string; shell?: string } = {},
  dispatch?: OperationDispatcher['dispatch'],
): TerminalWire {
  let deferredSpawn: { cols: number; rows: number } | null = null;

  const dispatchSpawn = (cols: number, rows: number): void => {
    if (!dispatch) return;
    dispatch('term.spawn', {
      termId,
      cols,
      rows,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.shell ? { shell: options.shell } : {}),
    });
  };

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
    // Only present when the caller injected the dispatcher — Terminal.tsx
    // falls back to requestReplay for a replay-only wire, as before.
    ...(dispatch ? {
      spawn(cols: number, rows: number) {
        // Spawn is not replay-safe: retrying an uncertain request would kill
        // and replace an existing PTY. If this tab mounts before the socket's
        // first authoritative snapshot, delay the *known-unsent* request and
        // issue it once the generation becomes ready.
        if (ws.getState() !== 'open') {
          deferredSpawn = { cols, rows };
          return;
        }
        dispatchSpawn(cols, rows);
      },
    } : {}),
    subscribe(handlers) {
      const offMessage = ws.onMessage(message => {
        if (message.type === 'term:output' && message.term_id === termId) {
          handlers.onChunk(base64ToBytes(message.data));
        } else if (message.type === 'term:replay' && message.term_id === termId) {
          handlers.onReplay(message.chunks.map(base64ToBytes), {
            alive: message.alive,
            code: message.code,
            signal: message.signal,
          });
        } else if (message.type === 'term:exited' && message.term_id === termId) {
          handlers.onExit?.(message.code, message.signal);
        }
      });
      // Terminal mounts issue one explicit initial replay (or spawn) after
      // subscribing. On every *subsequent* ready generation, request the
      // server buffer again so output produced during the disconnect window
      // is recovered. onState fires immediately, which lets us distinguish
      // the initial readiness from a later reconnect without duplicating the
      // component's first request.
      let hasReachedReady = false;
      const offState = ws.onState(state => {
        if (state !== 'open') return;
        if (deferredSpawn) {
          const pending = deferredSpawn;
          deferredSpawn = null;
          dispatchSpawn(pending.cols, pending.rows);
          hasReachedReady = true;
          return;
        }
        if (!hasReachedReady) {
          hasReachedReady = true;
          return;
        }
        ws.send({ type: 'term:replay-request', term_id: termId });
      });
      return () => {
        offMessage();
        offState();
      };
    },
  };
}
