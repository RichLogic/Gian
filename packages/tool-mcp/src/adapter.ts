import { randomUUID } from 'node:crypto';
import type { RequestId } from '@modelcontextprotocol/sdk/types.js';
import {
  GIAN_TOOL_METHODS,
  isGianToolMutation,
  validateGianToolParams,
  type GianToolMethod,
  type GianToolResult,
} from '@gian/shared';
import { callGianTool, localToolCallerId } from '@gian/tool-cli';
import { GIAN_MCP_TOOL_DEFINITIONS } from './schemas.js';

export { GIAN_MCP_TOOL_DEFINITIONS } from './schemas.js';

export interface GianMcpCallResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: true;
}

export type GianMcpRpcCall = (options: {
  dataDir: string;
  method: GianToolMethod;
  params: Record<string, unknown>;
  idempotencyKey?: string;
  callerId: string;
  requestId: string;
}) => Promise<GianToolResult>;

function mcpResult(result: GianToolResult): GianMcpCallResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result as unknown as Record<string, unknown>,
    ...(!result.ok ? { isError: true as const } : {}),
  };
}

function invalidResult(requestId: string, message: string): GianMcpCallResult {
  return mcpResult({
    ok: false,
    request_id: requestId,
    error: { code: 'INVALID_ARGUMENT', message, retryable: false },
  });
}

export async function gianMcpCallerId(dataDir: string): Promise<string> {
  return localToolCallerId(dataDir, 'mcp');
}

export async function dispatchGianMcpTool(options: {
  method: GianToolMethod;
  args: unknown;
  requestId: RequestId;
  hostRequestId?: () => string;
  dataDir: string;
  callerId: string;
  call?: GianMcpRpcCall;
}): Promise<GianMcpCallResult> {
  const requestId = options.hostRequestId?.() ?? randomUUID();
  if (!options.args || typeof options.args !== 'object' || Array.isArray(options.args)) {
    return invalidResult(requestId, 'tool arguments must be an object');
  }
  const input = { ...(options.args as Record<string, unknown>) };
  const idempotencyKey = input['idempotency_key'];
  delete input['idempotency_key'];
  if (isGianToolMutation(options.method)
    && (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0)) {
    return invalidResult(requestId, `${options.method} requires idempotency_key`);
  }

  let params: Record<string, unknown>;
  try {
    params = validateGianToolParams(options.method, input) as Record<string, unknown>;
  } catch (error) {
    return invalidResult(requestId, error instanceof Error ? error.message : String(error));
  }

  const call = options.call ?? callGianTool as GianMcpRpcCall;
  const result = await call({
    dataDir: options.dataDir,
    method: options.method,
    params,
    callerId: options.callerId,
    requestId,
    ...(typeof idempotencyKey === 'string' ? { idempotencyKey } : {}),
  });
  return mcpResult(result);
}

export async function dispatchGianMcpCall(options: {
  args: unknown;
  requestId: RequestId;
  hostRequestId?: () => string;
  dataDir: string;
  callerId: string;
  call?: GianMcpRpcCall;
}): Promise<GianMcpCallResult> {
  const requestId = options.hostRequestId?.() ?? randomUUID();
  if (!options.args || typeof options.args !== 'object' || Array.isArray(options.args)) {
    return invalidResult(requestId, 'gian_call arguments must be an object');
  }
  const input = options.args as Record<string, unknown>;
  const unknown = Object.keys(input).filter(key => !['method', 'params', 'idempotency_key'].includes(key));
  if (unknown.length > 0) return invalidResult(requestId, `gian_call has unknown field: ${unknown[0]}`);
  if (typeof input['method'] !== 'string' || !isGianMcpTool(input['method'])) {
    return invalidResult(requestId, 'gian_call.method is invalid');
  }
  if (!input['params'] || typeof input['params'] !== 'object' || Array.isArray(input['params'])) {
    return invalidResult(requestId, 'gian_call.params must be an object');
  }
  return dispatchGianMcpTool({
    method: input['method'],
    args: {
      ...(input['params'] as Record<string, unknown>),
      ...(input['idempotency_key'] !== undefined
        ? { idempotency_key: input['idempotency_key'] }
        : {}),
    },
    requestId: options.requestId,
    hostRequestId: () => requestId,
    dataDir: options.dataDir,
    callerId: options.callerId,
    ...(options.call ? { call: options.call } : {}),
  });
}

export function isGianMcpTool(name: string): name is GianToolMethod {
  return (GIAN_TOOL_METHODS as readonly string[]).includes(name);
}

export function gianMcpToolDefinition(name: GianToolMethod) {
  return GIAN_MCP_TOOL_DEFINITIONS.find(tool => tool.name === name);
}
