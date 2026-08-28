import { isIP } from 'node:net';
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { GianToolResult } from '@gian/shared';
import { handleGianToolMcpHttpRequest } from '@gian/tool-mcp';
import { GianToolAccessController } from './access.js';
import type { GianToolCredentialManager } from './credentials.js';

export const GIAN_TOOL_MCP_PATH = '/internal/mcp';
const MAX_REQUEST_BYTES = 1_048_576;
const MAX_CONCURRENT_REQUESTS = 32;
const MAX_CONCURRENT_WAITS = 8;

export function isLoopbackMcpHost(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === 'localhost') return true;
  const ip = isIP(normalized);
  return ip === 4 ? normalized.startsWith('127.') : ip === 6 && normalized === '::1';
}

function urlHost(host: string, port: number): string {
  return `${host.includes(':') ? `[${host}]` : host}:${port}`;
}

export function gianToolMcpUrl(host: string, port: number): string {
  if (!isLoopbackMcpHost(host)) throw new Error('Gian Tool MCP requires a loopback Host');
  return `http://${urlHost(host, port)}${GIAN_TOOL_MCP_PATH}`;
}

function conflict(requestId: string, message: string): GianToolResult {
  return {
    ok: false,
    request_id: requestId,
    error: { code: 'CONFLICT', message, retryable: true },
  };
}

export function registerGianToolMcpRoute(app: Hono, options: {
  dataDir: string;
  host: string;
  port: number;
  credentials: GianToolCredentialManager;
  access: GianToolAccessController;
  /** Test seam; production uses the closed defaults above. */
  limits?: { requests?: number; waits?: number };
  /** Test seam for proving concurrency bounds without real long-running Sessions. */
  beforeCall?: (method: import('@gian/shared').GianToolMethod) => Promise<void>;
}): boolean {
  if (!isLoopbackMcpHost(options.host)) return false;
  const expectedHost = urlHost(options.host, options.port);
  const maxRequests = options.limits?.requests ?? MAX_CONCURRENT_REQUESTS;
  const maxWaits = options.limits?.waits ?? MAX_CONCURRENT_WAITS;
  let active = 0;
  let activeWaits = 0;

  app.use(GIAN_TOOL_MCP_PATH, bodyLimit({
    maxSize: MAX_REQUEST_BYTES,
    onError: c => c.json({ error: 'mcp_request_too_large' }, 413),
  }));
  app.all(GIAN_TOOL_MCP_PATH, async c => {
    const request = c.req.raw;
    c.header('Cache-Control', 'no-store');
    if (new URL(request.url).host !== expectedHost) {
      return c.json({ error: 'mcp_host_required' }, 421);
    }
    if (request.headers.has('origin')) {
      return c.json({ error: 'mcp_browser_origin_forbidden' }, 403);
    }
    const actor = options.credentials.authenticate(request.headers.get('authorization'));
    if (!actor) {
      return new Response(JSON.stringify({ error: 'invalid_tool_credential' }), {
        status: 401,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'www-authenticate': 'Bearer realm="gian-tool"',
        },
      });
    }
    if (active >= maxRequests) {
      return c.json({ error: 'too_many_mcp_requests' }, 429, {
        'Retry-After': '1',
        'Cache-Control': 'no-store',
      });
    }
    active += 1;
    try {
      const response = await handleGianToolMcpHttpRequest({
        request,
        dataDir: options.dataDir,
        callerId: actor.callerId,
        allowedMethods: actor.grants,
        call: async call => {
          const wait = call.method === 'session.wait';
          if (wait && activeWaits >= maxWaits) {
            return conflict(call.requestId, 'Too many concurrent Tool waits');
          }
          if (wait) activeWaits += 1;
          try {
            await options.beforeCall?.(call.method);
            return await options.access.call(actor, {
              request_id: call.requestId,
              method: call.method,
              params: call.params,
              ...(call.idempotencyKey ? { idempotency_key: call.idempotencyKey } : {}),
            });
          } finally {
            if (wait) activeWaits -= 1;
          }
        },
      });
      const headers = new Headers(response.headers);
      headers.set('cache-control', 'no-store');
      headers.set('x-content-type-options', 'nosniff');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } finally {
      active -= 1;
    }
  });
  return true;
}
