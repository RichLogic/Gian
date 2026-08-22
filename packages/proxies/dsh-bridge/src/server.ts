/**
 * The bridge/1.0 JSON-RPC server core.
 *
 * It owns request routing, the single JSON-RPC writer, the initialize identity
 * gate, and early-event buffering for turn correlation (6.4). The
 * proxy-facing behavior is host-agnostic so the same server can be exercised
 * against a deterministic fake host (unit/contract tests) and the real Cordis
 * host (DSH integration).
 */

import {
  BRIDGE_PROTOCOL_NAME,
  BRIDGE_PROTOCOL_VERSION,
  type BridgeJsonValue,
} from './schema.js';
import { BridgeProtocolError, BridgeWriter } from './jsonrpc.js';
import { boundedSanitized } from './sanitize.js';
import type {
  BridgeHost,
  BridgeHostEvent,
  BridgeInteractionRespondParams,
  BridgeSessionCreateParams,
  BridgeTurnInputItem,
  BridgeTurnStartParams,
} from './host.js';

export interface BridgeServerOptions {
  host: BridgeHost;
  writer: BridgeWriter;
  /** Maximum sanitized diagnostic bytes for a single notification. */
  maxDetailBytes?: number;
}

export class BridgeServer {
  private initialized = false;
  private shuttingDown = false;

  constructor(private readonly options: BridgeServerOptions) {
    this.options.host.attachSink((event) => this.emitHostEvent(event));
  }

  get writer(): BridgeWriter {
    return this.options.writer;
  }

  /** Route one parsed request. */
  async handle(request: {
    id: string;
    method: string;
    params: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    if (this.shuttingDown) {
      throw new BridgeProtocolError(-32000, 'Bridge is shutting down.', 'RUNTIME_UNAVAILABLE');
    }
    if (request.method === 'initialize') {
      if (this.initialized) {
        throw new BridgeProtocolError(-32000, 'initialize can only be sent once.', 'ALREADY_INITIALIZED');
      }
      const result = await this.options.host.initialize({
        protocol: { versions: stringArray(request.params, 'versions') },
      });
      this.initialized = true;
      return result;
    }
    if (this.initialized === false) {
      throw new BridgeProtocolError(-32000, 'initialize must be the first request.', 'NOT_INITIALIZED');
    }
    return this.route(request);
  }

  private async route(request: {
    id: string;
    method: string;
    params: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const host = this.options.host;
    switch (request.method) {
      case 'catalog.list':
        return host.catalogList();
      case 'catalog.resolve':
        return host.catalogResolve(request.params);
      case 'session.create':
        return host.sessionCreate(this.sessionCreateParams(request.params));
      case 'session.resume':
        return host.sessionResume({
          sessionId: stringField(request.params, 'sessionId'),
          nativeSessionId: stringField(request.params, 'nativeSessionId'),
        });
      case 'session.get':
        return host.sessionGet({ sessionId: stringField(request.params, 'sessionId') });
      case 'session.close':
        return host.sessionClose({ sessionId: stringField(request.params, 'sessionId') });
      case 'session.native.list':
        return host.sessionNativeList(request.params);
      case 'session.rename':
        return host.sessionRename({
          sessionId: stringField(request.params, 'sessionId'),
          name: stringField(request.params, 'name'),
        });
      case 'session.events.read': {
        const limit = request.params.limit;
        return host.sessionEventsRead({
          sessionId: stringField(request.params, 'sessionId'),
          ...(request.params.cursor === undefined
            ? {}
            : { cursor: request.params.cursor as string | null }),
          ...(typeof limit === 'number' ? { limit } : {}),
        });
      }
      case 'turn.start':
        return host.turnStart(this.turnStartParams(request.params));
      case 'turn.steer': {
        const turnId = optionalString(request.params, 'turnId');
        return host.turnSteer({
          sessionId: stringField(request.params, 'sessionId'),
          ...(turnId === null ? {} : { turnId }),
          input: Array.isArray(request.params.input) ? request.params.input : [],
        });
      }
      case 'turn.interrupt': {
        const turnId = optionalString(request.params, 'turnId');
        return host.turnInterrupt({
          sessionId: stringField(request.params, 'sessionId'),
          ...(turnId === null ? {} : { turnId }),
        });
      }
      case 'interaction.respond':
        return host.interactionRespond(this.interactionRespondParams(request.params));
      case 'shutdown':
        this.shuttingDown = true;
        return host.shutdown();
      default:
        throw new BridgeProtocolError(-32601, `Unknown method ${request.method}.`);
    }
  }

  private sessionCreateParams(params: Record<string, unknown>): BridgeSessionCreateParams {
    const config = (params.config ?? {}) as Record<string, BridgeJsonValue>;
    const workspace = (params.workspace ?? {}) as Record<string, unknown>;
    const native = (params.nativeSession ?? null) as Record<string, unknown> | null;
    const nativeSessionId = native !== null && typeof native.id === 'string'
      ? native.id
      : undefined;
    const history = native !== null ? native.history : undefined;
    return {
      sessionId: stringField(params, 'sessionId'),
      cwd: stringField(workspace, 'cwd'),
      roots: Array.isArray(workspace.roots)
        ? (workspace.roots as unknown[]).map(String)
        : [],
      config,
      ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
      ...(history === 'replay' ? { restartNewStream: true } : {}),
    };
  }

  private turnStartParams(params: Record<string, unknown>): BridgeTurnStartParams {
    const rawInput = Array.isArray(params.input) ? params.input : [];
    return {
      sessionId: stringField(params, 'sessionId'),
      turnId: stringField(params, 'turnId'),
      input: rawInput.map(coerceTurnInput),
      config: (params.config ?? {}) as Record<string, BridgeJsonValue>,
    };
  }

  private interactionRespondParams(
    params: Record<string, unknown>,
  ): BridgeInteractionRespondParams {
    const actionId = optionalString(params, 'actionId');
    return {
      sessionId: stringField(params, 'sessionId'),
      interactionId: stringField(params, 'interactionId'),
      ...(actionId === null ? {} : { actionId }),
      values: (params.values ?? {}) as Record<string, unknown>,
    };
  }

  /** Push a host event out on the bridge wire; sanitize diagnostic payloads. */
  private emitHostEvent(event: BridgeHostEvent): void {
    const params = this.cleanNotificationParams(event.method, event.params);
    this.options.writer.notification(event.method as never, params);
  }

  private cleanNotificationParams(
    method: string,
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = { ...params };
    // Generic activity / error payloads are sanitized and bounded bridge-side
    // (7.3); dedicated typed events keep their structured shapes.
    if (method === 'runtime.error' || method === 'agent.error') {
      const rawDetails = out.details;
      out.details = boundedSanitized(
        rawDetails ?? out.message ?? null,
        this.options.maxDetailBytes ?? 1024 * 1024,
      );
    }
    return out;
  }
}

function coerceTurnInput(raw: unknown): BridgeTurnInputItem {
  const record = (raw ?? {}) as Record<string, unknown>;
  const type = record.type === 'text' || record.type === 'localFile'
    || record.type === 'localImage' || record.type === 'skill'
    ? record.type
    : 'text';
  return {
    type,
    ...(typeof record.text === 'string' ? { text: record.text } : {}),
    ...(typeof record.path === 'string' ? { path: record.path } : {}),
    ...(typeof record.name === 'string' ? { name: record.name } : {}),
    ...(typeof record.mime === 'string' ? { mime: record.mime } : {}),
    ...(typeof record.size === 'number' ? { size: record.size } : {}),
  };
}

function stringArray(params: Record<string, unknown>, key: string): string[] {
  const value = (params.protocol ?? params) as Record<string, unknown>;
  const raw = value[key];
  if (Array.isArray(raw) === false) {
    throw new BridgeProtocolError(-32602, `params.${key} must be an array.`);
  }
  return raw.map((entry) => String(entry));
}

function stringField(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new BridgeProtocolError(-32602, `params.${key} must be a non-empty string.`);
  }
  return value;
}

function optionalString(params: Record<string, unknown>, key: string): string | null {
  const value = params[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length === 0) {
    throw new BridgeProtocolError(-32602, `params.${key} must be a string.`);
  }
  return value;
}
