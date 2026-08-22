/**
 * gian.dsh.bridge/1.0 JSON-RPC 2.0 transport over UTF-8 NDJSON stdio.
 *
 * Transport rules (plan §5.1):
 * - every message carries `jsonrpc:"2.0"`;
 * - request IDs are non-empty strings;
 * - batch arrays are forbidden;
 * - a single line must not exceed 16 MiB;
 * - stdout carries only bridge JSON-RPC; stderr carries sanitized diagnostics;
 * - the writer serializes output (one message per line, never interleaved).
 */

import { Buffer } from 'node:buffer';
import { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';

import {
  BRIDGE_NOTIFICATIONS,
  BRIDGE_PROTOCOL_NAME,
  BRIDGE_PROTOCOL_VERSION,
  MAX_BRIDGE_LINE_BYTES,
  asRecord,
  validateBridgeNotification,
  validateBridgeRequest,
  type BridgeNotification,
  type BridgeNotificationMethod,
  type BridgeRequest,
} from './schema.js';

export class BridgeProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly domainCode?: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'BridgeProtocolError';
  }
}

export function parseBridgeLine(line: string): unknown {
  if (line.trim() === '') return null;
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > MAX_BRIDGE_LINE_BYTES) {
    throw new BridgeProtocolError(
      -32600,
      `NDJSON line is ${bytes} bytes; maximum is ${MAX_BRIDGE_LINE_BYTES}.`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new BridgeProtocolError(
      -32700,
      `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (Array.isArray(value)) {
    throw new BridgeProtocolError(-32600, 'JSON-RPC batch arrays are not allowed.');
  }
  if (value === null || typeof value !== 'object') {
    throw new BridgeProtocolError(-32600, 'NDJSON top-level value must be an object.');
  }
  return value;
}

/** A synchronous serialized NDJSON writer. Every payload goes out on one line. */
export class BridgeWriter {
  private pending: string[] = [];

  constructor(private readonly output: Writable = process.stdout) {}

  write(value: unknown): void {
    this.pending.push(JSON.stringify(value));
    this.flush();
  }

  flush(): void {
    while (this.pending.length > 0) {
      const line = this.pending.shift();
      if (line !== undefined) this.output.write(`${line}\n`);
    }
  }

  notification(method: BridgeNotificationMethod, params: Record<string, unknown>): void {
    this.write({
      jsonrpc: '2.0',
      method,
      params,
    });
  }

  result(id: string, result: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  error(id: string | null, error: {
    code: number;
    message: string;
    data?: { domainCode: string; retryable: boolean; details?: Record<string, unknown> };
  }): void {
    this.write({ jsonrpc: '2.0', id, error });
  }
}

export interface BridgeSession {
  close(): void;
}

/**
 * Read NDJSON request lines from stdin and route each one to a handler.
 * The handler returns a result synchronously or asynchronously; a thrown
 * `BridgeProtocolError` becomes a JSON-RPC error response.
 */
export async function runBridgeInput(
  input: Readable,
  handle: (request: BridgeRequest) => Promise<Record<string, unknown>>,
  writer: BridgeWriter,
  onError?: (error: unknown) => void,
): Promise<void> {
  const reader = createInterface({ input, crlfDelay: Infinity });
  for await (const line of reader) {
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = parseBridgeLine(line);
    } catch (error) {
      writer.error(null, transportError(error));
      if (onError) onError(error);
      continue;
    }
    if (value === null) continue;

    const record = asRecord(value);
    const id = typeof record?.id === 'string' && record.id.length > 0
      ? record.id
      : null;

    if (typeof record?.id !== 'string' || record.id.length === 0) {
      const checked = validateBridgeNotification(value);
      if (checked.ok === false) {
        writer.error(null, transportError(new BridgeProtocolError(-32600, checked.error)));
        continue;
      }
      // Inbound notifications from the proxy are not part of bridge/1.0: the
      // private contract only defines Proxy -> Bridge requests and
      // Bridge -> Proxy notifications. Reject rather than silently ignore.
      writer.error(null, transportError(new BridgeProtocolError(-32601, `Bridge does not accept notification ${String(record?.method)}`)));
      continue;
    }

    const checked = validateBridgeRequest(value);
    if (checked.ok === false) {
      writer.error(id, transportError(new BridgeProtocolError(-32600, checked.error)));
      continue;
    }

    try {
      const result = await handle(checked.request);
      writer.result(checked.request.id, result);
    } catch (error) {
      if (error instanceof BridgeProtocolError) {
        writer.error(checked.request.id, {
          code: error.code,
          message: error.message,
          ...(error.domainCode
            ? { data: { domainCode: error.domainCode, retryable: error.retryable } }
            : {}),
        });
      } else {
        writer.error(checked.request.id, {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      if (onError) onError(error);
    }
  }
}

function transportError(error: unknown): {
  code: number;
  message: string;
  data?: { domainCode: string; retryable: boolean; details?: Record<string, unknown> };
} {
  if (error instanceof BridgeProtocolError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.domainCode
        ? { data: { domainCode: error.domainCode, retryable: error.retryable } }
        : {}),
    };
  }
  return {
    code: -32603,
    message: error instanceof Error ? error.message : String(error),
  };
}

/** Build the frozen initialize result header emitted by a bridge runtime. */
export function buildInitializeResult(version: string, dshVersion: string, sessionFormatVersion: number) {
  return {
    protocol: {
      name: BRIDGE_PROTOCOL_NAME,
      version: BRIDGE_PROTOCOL_VERSION,
    },
    plugin: {
      id: 'ai.deepseek.harness',
      bundle: '@gian/dsh-bridge',
      version,
    },
    runtime: {
      id: 'deepseek-harness',
      package: '@deepseek-ai/dsh',
      version: dshVersion,
      sessionFormatVersion,
    },
    capabilities: {
      'session.resume': 1,
      'session.events.read': 1,
      'turn.interrupt': 1,
      'catalog.changed': 1,
      interaction: 1,
      'event.step': 1,
      'event.request': 1,
      'event.usage': 1,
    },
  };
}

export const BRIDGE_NOTIFICATION_SET: ReadonlySet<string> = new Set(BRIDGE_NOTIFICATIONS);
