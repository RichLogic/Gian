/**
 * In-process MCP server that backs Claude CLI's `--permission-prompt-tool`.
 *
 * cc-proxy runs this on a random localhost port. Each `claude -p` spawn gets
 * an mcp-config pointing at `http://127.0.0.1:<port>/session/<sessionId>/sse`,
 * plus `--permission-prompt-tool mcp__cc_approval__approval_prompt`. When CLI
 * needs to ask permission for a tool, it calls our `approval_prompt` tool;
 * we suspend the CallTool response, surface the request to the runtime,
 * and only reply once `resolve()` is called from the outside.
 *
 * Tool response format follows the Claude Code SDK contract: a single text
 * content block whose JSON payload is `{behavior: 'allow' | 'deny', ...}`.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from 'node:http';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

export const APPROVAL_SERVER_NAME = 'cc_approval';
export const APPROVAL_TOOL_NAME = 'approval_prompt';
/** Fully qualified tool name to pass to `--permission-prompt-tool`. */
export const APPROVAL_PROMPT_TOOL = `mcp__${APPROVAL_SERVER_NAME}__${APPROVAL_TOOL_NAME}`;

export interface ApprovalServerCallbacks {
  /** A `claude -p` instance asked us for a permission decision. The runtime
   *  should surface this to its event listeners; resolution comes back via
   *  `ApprovalServer.resolve()`. */
  onPermissionRequest(sessionId: string, callId: string, toolName: string, input: Record<string, unknown>): void;
  onConnected(sessionId: string): void;
  onDisconnected(sessionId: string): void;
  onDebug(message: string): void;
}

interface PendingApproval {
  sessionId: string;
  resolver: (response: CallToolResult) => void;
  /** Original tool input from the approval_prompt CallTool. Stored so
   *  `resolve(allow)` can echo it as `updatedInput` — newer Claude Code
   *  SDK versions appear to enforce a strict discriminated union where
   *  `allow` MUST carry `updatedInput`; sending bare `{behavior:'allow'}`
   *  silently wedges the agent on the next turn. */
  input: Record<string, unknown>;
}

interface SessionConnection {
  sessionId: string;
  server: Server;
  transport: SSEServerTransport;
}

export class ApprovalServer {
  private httpServer: HttpServer | null = null;
  private port = 0;
  private readonly connections = new Map<string, SessionConnection>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly callbacks: ApprovalServerCallbacks;
  private nextCallId = 1;

  constructor(callbacks: ApprovalServerCallbacks) {
    this.callbacks = callbacks;
  }

  /** Start the HTTP server on a random localhost port. */
  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          this.callbacks.onDebug(`[approval-mcp] request error: ${err}`);
          if (!res.writableEnded) {
            res.writeHead(500).end('Internal Server Error');
          }
        });
      });

      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Failed to allocate port'));
          return;
        }
        this.httpServer = server;
        this.port = address.port;
        resolve(address.port);
      });
    });
  }

  getPort(): number {
    return this.port;
  }

  /** URL for `claude --mcp-config` to connect to. Per-session URL path lets
   *  us route incoming CallTools to the right session. */
  urlForSession(sessionId: string): string {
    return `http://127.0.0.1:${this.port}/session/${sessionId}/sse`;
  }

  /** Resolve a previously-suspended approval_prompt CallTool.
   *
   * `extra.updatedInput` (Claude SDK contract) lets us hand the agent
   * back a modified input for the upcoming tool call. Used by Gian's
   * AskUserQuestion bridge: when the user picks an option in the web UI,
   * we resolve `behavior: 'allow'` and pass `updatedInput: { answers }`
   * so claude effectively re-invokes AskUserQuestion with the answers
   * pre-supplied.
   */
  resolve(
    callId: string,
    behavior: 'allow' | 'deny',
    message?: string,
    extra?: { updatedInput?: Record<string, unknown> },
  ): boolean {
    const pending = this.pendingApprovals.get(callId);
    if (!pending) return false;
    this.pendingApprovals.delete(callId);

    const payload: Record<string, unknown> = { behavior };
    if (behavior === 'deny' && message) payload.message = message;
    if (behavior === 'allow') {
      // Always include `updatedInput` on allow. Newer Claude Code SDK
      // versions enforce a strict discriminated union where `allow` carries
      // `updatedInput`; omitting it caused the agent to silently wedge after
      // the user clicked through (no SDK error, just no further activity).
      // Default to the original input — semantically a no-op pass-through.
      // AskUserQuestion routes through `extra.updatedInput = { answers }`,
      // which overrides this default to feed the structured response back.
      payload.updatedInput = extra?.updatedInput ?? pending.input;
    }

    pending.resolver({
      content: [{ type: 'text', text: JSON.stringify(payload) }],
    });
    return true;
  }

  /** Drop any session connection + any pending approvals tied to it. The
   *  pending approvals get rejected so the CLI side doesn't hang forever.
   *  Transport close is deferred to the next tick so the deny response can
   *  flush through SSE before the connection terminates. */
  dropConnection(sessionId: string): void {
    let hadPending = false;
    for (const [callId, pending] of this.pendingApprovals) {
      if (pending.sessionId === sessionId) {
        this.pendingApprovals.delete(callId);
        pending.resolver({
          content: [{ type: 'text', text: JSON.stringify({ behavior: 'deny', message: 'session closed' }) }],
        });
        hadPending = true;
      }
    }

    const conn = this.connections.get(sessionId);
    if (!conn) return;

    this.connections.delete(sessionId);
    const closeTransport = () => { void conn.transport.close(); };
    if (hadPending) {
      // Give the resolved response a chance to flush through the SSE pipe.
      setTimeout(closeTransport, 50);
    } else {
      closeTransport();
    }
  }

  hasConnection(sessionId: string): boolean {
    return this.connections.has(sessionId);
  }

  async stop(): Promise<void> {
    for (const callId of this.pendingApprovals.keys()) {
      this.resolve(callId, 'deny', 'proxy shutting down');
    }

    for (const conn of this.connections.values()) {
      void conn.transport.close();
    }
    this.connections.clear();

    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    const sseMatch = url.pathname.match(/^\/session\/([^/]+)\/sse$/);
    if (sseMatch && req.method === 'GET') {
      await this.handleSSE(sseMatch[1]!, res);
      return;
    }

    const msgMatch = url.pathname.match(/^\/session\/([^/]+)\/message$/);
    if (msgMatch && req.method === 'POST') {
      await this.handlePost(msgMatch[1]!, req, res);
      return;
    }

    if (url.pathname === '/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      return;
    }

    res.writeHead(404).end('Not Found');
  }

  private async handleSSE(sessionId: string, res: ServerResponse) {
    // If a previous connection is still around (e.g. claude reconnecting),
    // drop it and let the new one take over.
    this.dropConnection(sessionId);

    const transport = new SSEServerTransport(`/session/${sessionId}/message`, res);
    const mcpServer = this.createMcpServer(sessionId);

    const conn: SessionConnection = { sessionId, server: mcpServer, transport };
    this.connections.set(sessionId, conn);

    // Keepalive. An AskUserQuestion / permission prompt can stay pending for
    // minutes while the user is away from the card; the SSE response then sits
    // idle. Without periodic traffic the connection can be dropped (OS/runtime
    // idle reaping), after which the suspended CallTool never receives its
    // answer and the turn wedges ("pending 久了 session 卡住"). A comment ping
    // keeps it warm and makes a dead client fail fast. Comment lines (`:`) are
    // valid SSE and ignored by the MCP client, so they don't disturb frames.
    const ping = setInterval(() => {
      try {
        if (!res.writableEnded) res.write(': keepalive\n\n');
      } catch {
        /* connection gone — transport.onclose handles cleanup */
      }
    }, 15_000);
    if (typeof ping.unref === 'function') ping.unref();
    const clearPing = () => clearInterval(ping);

    transport.onclose = () => {
      clearPing();
      if (this.connections.get(sessionId) === conn) {
        this.connections.delete(sessionId);
        this.callbacks.onDisconnected(sessionId);
      }
    };
    res.on('close', clearPing);

    await mcpServer.connect(transport);
    this.callbacks.onConnected(sessionId);
    this.callbacks.onDebug(`[approval-mcp] SSE connected for session ${sessionId}`);
  }

  private async handlePost(sessionId: string, req: IncomingMessage, res: ServerResponse) {
    const conn = this.connections.get(sessionId);
    if (!conn) {
      res.writeHead(404).end('No active SSE connection for this session');
      return;
    }
    await conn.transport.handlePostMessage(req, res);
  }

  private createMcpServer(sessionId: string): Server {
    const server = new Server(
      { name: APPROVAL_SERVER_NAME, version: '0.1.0' },
      {
        capabilities: { tools: {} },
        instructions: `Approval bridge for cc-proxy. The "${APPROVAL_TOOL_NAME}" tool suspends until a user decision arrives.`,
      },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: APPROVAL_TOOL_NAME,
          description: 'Request user approval for a tool invocation. Returns a JSON-encoded {behavior: allow|deny} payload.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              tool_name: { type: 'string', description: 'Name of the tool the agent wants to invoke.' },
              input: { type: 'object', description: 'Arguments the agent intends to pass to the tool.' },
            },
            required: ['tool_name', 'input'],
          },
        },
      ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      if (req.params.name !== APPROVAL_TOOL_NAME) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ behavior: 'deny', message: `unknown tool: ${req.params.name}` }) }],
        };
      }

      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      const toolName = typeof args.tool_name === 'string' ? args.tool_name : 'unknown';
      const input = typeof args.input === 'object' && args.input !== null
        ? args.input as Record<string, unknown>
        : {};

      const callId = `call_${this.nextCallId++}`;

      return new Promise<CallToolResult>((resolveCall) => {
        this.pendingApprovals.set(callId, { sessionId, resolver: resolveCall, input });
        this.callbacks.onPermissionRequest(sessionId, callId, toolName, input);
      });
    });

    return server;
  }
}
