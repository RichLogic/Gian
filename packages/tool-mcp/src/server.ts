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

export function createGianToolMcpServer(options: { dataDir: string }): Server {
  const server = new Server(
    { name: 'gian-tool', version: '0.5.2' },
    { capabilities: { tools: {} } },
  );
  const callerId = gianMcpCallerId(options.dataDir);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: GIAN_MCP_TOOL_DEFINITIONS,
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (request.params.name === 'gian_call') {
      return dispatchGianMcpCall({
        args: request.params.arguments ?? {},
        requestId: extra.requestId,
        dataDir: options.dataDir,
        callerId: await callerId,
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
    });
  });
  return server;
}

export async function runGianToolMcpServer(dataDir: string): Promise<void> {
  const server = createGianToolMcpServer({ dataDir });
  await server.connect(new StdioServerTransport());
}
