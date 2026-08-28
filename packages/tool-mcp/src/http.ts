import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { GianToolMethod } from '@gian/shared';
import type { GianMcpRpcCall } from './adapter.js';
import { createGianToolMcpServer } from './server.js';

/** Serve one stateless Streamable HTTP MCP request. Authentication and actor
 * projection happen in the Host before this boundary; this layer only binds
 * the already-authorized caller and method catalog to the canonical adapter. */
export async function handleGianToolMcpHttpRequest(options: {
  request: Request;
  dataDir: string;
  callerId: string;
  allowedMethods: readonly GianToolMethod[];
  call: GianMcpRpcCall;
}): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = createGianToolMcpServer({
    dataDir: options.dataDir,
    callerId: options.callerId,
    allowedMethods: options.allowedMethods,
    call: options.call,
  });
  await server.connect(transport);
  return transport.handleRequest(options.request);
}
