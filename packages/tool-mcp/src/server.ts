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
  const instructions: string[] = [];
  if (options.allowedMethods === undefined || options.allowedMethods.includes('schedule.create')) {
    instructions.push(
      'Gian schedules are created through the advertised schedule tools and bound to this conversation. Gian must remain running; scheduled work never auto-approves Provider permission requests.',
      'When the user has supplied what to do and when/how often, use schedule.preview when available, then call schedule.create. Ask only for missing essential information; do not ask again for details already supplied.',
      'Generate a concise name and a durable prompt from the request. Results appear in the bound conversation by default; output destination and formatting are not prerequisites unless the user specifically requests something different.',
      `Use the Host timezone ${Intl.DateTimeFormat().resolvedOptions().timeZone} unless the user specifies another timezone. For a simple repeating cadence, use an interval trigger.`,
      'schedule.create opens the Gian confirmation card and waits for the user there. Do not add a separate chat permission question before proposing it. Report creation only after that tool returns success; a clarification reply or schedule.preview alone does not create a task.',
      'If the necessary schedule tools are unavailable or fail, report that limitation clearly. Do not substitute OS cron, background loops, another scheduling service, or direct database writes.',
    );
  }
  if (options.allowedMethods === undefined || options.allowedMethods.includes('browser.snapshot')) {
    instructions.push(
      'Gian Browser tools control the real page shown in panel2 with the user\'s Browser profile. Use browser.tabs first when a tab may already exist, otherwise browser.open.',
      'Prefer browser.snapshot followed by browser.click, browser.fill, or browser.press. Element refs are snapshot- and page-generation-bound; take a new snapshot after navigation or a stale-ref error.',
      'Use browser.evaluate only when the high-level tools cannot express the operation. browser.screenshot always waits for explicit user approval before page pixels are returned.',
    );
  }
  const server = new Server(
    { name: 'gian-tool', version: '0.5.4' },
    {
      capabilities: { tools: {} },
      ...(instructions.length > 0 ? { instructions: instructions.join('\n') } : {}),
    },
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
