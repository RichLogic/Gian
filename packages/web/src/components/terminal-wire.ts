import type { GianWs } from '../ws.js';

export interface TerminalWire {
  sendInput(bytes: Uint8Array): void;
  sendResize(cols: number, rows: number): void;
  requestReplay(): void;
  spawn?(cols: number, rows: number): void;
  subscribe(handlers: {
    onChunk: (bytes: Uint8Array) => void;
    onReplay: (chunks: Uint8Array[]) => void;
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

export function makeWorkbenchWire(
  ws: GianWs,
  termId: string,
  options: { cwd?: string; shell?: string } = {},
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
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.shell ? { shell: options.shell } : {}),
      });
    },
    subscribe(handlers) {
      return ws.onMessage(message => {
        if (message.type === 'term:output' && message.term_id === termId) {
          handlers.onChunk(base64ToBytes(message.data));
        } else if (message.type === 'term:replay' && message.term_id === termId) {
          handlers.onReplay(message.chunks.map(base64ToBytes));
        } else if (message.type === 'term:exited' && message.term_id === termId) {
          handlers.onExit?.(message.code, message.signal);
        }
      });
    },
  };
}
