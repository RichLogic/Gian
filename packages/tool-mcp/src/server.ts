import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import {
  dispatchGianMcpTool,
  dispatchGianMcpCall,
  gianMcpCallerId,
  isGianMcpTool,
  GIAN_MCP_TOOL_DEFINITIONS,
} from './adapter.js';
import { gianMcpToolDefinitions } from './schemas.js';

export function createGianToolMcpServer(options: {
  dataDir: string;
  callerId?: string;
  allowedMethods?: readonly import('@gian/shared').GianToolMethod[];
  call?: import('./adapter.js').GianMcpRpcCall;
}): Server {
  const server = new Server(
    { name: 'gian-tool', version: '0.5.4' },
    { capabilities: { tools: {} } },
  );
  const callerId = options.callerId
    ? Promise.resolve(options.callerId)
    : gianMcpCallerId(options.dataDir);
  const tools = options.allowedMethods
    ? gianMcpToolDefinitions(options.allowedMethods)
    : GIAN_MCP_TOOL_DEFINITIONS;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools,
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (request.params.name === 'gian_call') {
      return dispatchGianMcpCall({
        args: request.params.arguments ?? {},
        requestId: extra.requestId,
        dataDir: options.dataDir,
        callerId: await callerId,
        ...(options.allowedMethods ? { allowedMethods: options.allowedMethods } : {}),
        ...(options.call ? { call: options.call } : {}),
      });
    }
    if (!isGianMcpTool(request.params.name)) {
      throw new McpError(ErrorCode.InvalidParams, `unknown Gian Tool method: ${request.params.name}`);
    }
    return dispatchGianMcpTool({
      method: request.params.name,
      args: request.params.arguments ?? {},
      requestId: extra.requestId,
      dataDir: options.dataDir,
      callerId: await callerId,
      ...(options.allowedMethods ? { allowedMethods: options.allowedMethods } : {}),
      ...(options.call ? { call: options.call } : {}),
    });
  });
  return server;
}

export async function runGianToolMcpServer(dataDir: string): Promise<void> {
  const server = createGianToolMcpServer({ dataDir });
  await server.connect(new StdioServerTransport());
}
