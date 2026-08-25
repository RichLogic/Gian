#!/usr/bin/env node

import { createInterface } from 'node:readline';

const listenIndex = process.argv.indexOf('--listen');
const listenUrl = listenIndex >= 0 ? process.argv[listenIndex + 1] : undefined;
if (listenUrl !== 'stdio://') {
  throw new Error('fake codex lifecycle server requires --listen stdio://');
}

const threadId = 'fake-thread-1';
const turnId = 'fake-turn-1';
let turnStatus = 'running';

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line) as {
    jsonrpc?: unknown;
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
  };
  if (message.jsonrpc !== undefined) {
    process.stderr.write('fixture received a forbidden jsonrpc wire header\n');
    process.exit(3);
  }
  if (message.id === 700 && !message.method) {
    setTimeout(() => {
      send({
        method: 'item/completed',
        params: {
          threadId,
          turnId,
          completedAtMs: 2_000,
          item: {
            type: 'mcpToolCall',
            id: 'fake-tool-1',
            server: 'fixture',
            tool: 'inspect',
            status: 'completed',
            arguments: { target: 'trace' },
            appContext: null,
            pluginId: null,
            result: { content: [{ type: 'text', text: 'ok' }], structuredContent: null, _meta: null },
            error: null,
            durationMs: 1_000,
          },
        },
      });
      turnStatus = 'completed';
      send({
        method: 'turn/completed',
        params: { threadId, turn: { id: turnId, status: 'completed' } },
      });
    }, 10);
    return;
  }
  if (typeof message.id !== 'number' || !message.method) return;
  switch (message.method) {
    case 'initialize':
      send({ id: message.id, result: { fixture: true } });
      break;
    case 'model/list':
      send({
        id: message.id,
        result: {
          data: [{
            id: 'fake-codex',
            model: 'fake-codex',
            displayName: 'Fake Codex',
            description: 'Local lifecycle fixture',
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
            serviceTiers: [{
              id: 'fast',
              name: 'Fast',
              description: 'Faster responses.',
            }],
          }],
          nextCursor: null,
        },
      });
      break;
    case 'skills/list':
      send({ id: message.id, result: { data: [] } });
      break;
    case 'thread/start':
      send({
        id: message.id,
        result: {
          thread: { id: threadId },
          approvalPolicy: 'on-request',
          approvalsReviewer: 'user',
          sandbox: { type: 'readOnly', networkAccess: false },
        },
      });
      break;
    case 'thread/read':
      send({
        id: message.id,
        result: {
          thread: {
            id: threadId,
            preview: 'fake lifecycle',
            turns: [{
              id: turnId,
              status: turnStatus,
              items: turnStatus === 'completed'
                ? [{ type: 'agentMessage', id: 'fake-message-1', text: 'hello from fake codex' }]
                : [],
            }],
          },
        },
      });
      break;
    case 'turn/start':
      // Deliberately publish visible events before the native response. The
      // real Proxy must still publish the Gian response first.
      send({
        method: 'item/agentMessage/delta',
        params: { threadId, turnId, itemId: 'fake-message-1', delta: 'hello from fake codex' },
      });
      send({
        method: 'item/started',
        params: {
          threadId,
          turnId,
          startedAtMs: 1_000,
          item: {
            type: 'mcpToolCall',
            id: 'fake-tool-1',
            server: 'fixture',
            tool: 'inspect',
            status: 'inProgress',
            arguments: { target: 'trace' },
            appContext: null,
            pluginId: null,
            result: null,
            error: null,
            durationMs: null,
          },
        },
      });
      send({
        id: 700,
        method: 'item/commandExecution/requestApproval',
        params: { threadId, turnId, command: 'echo fake-approval' },
      });
      send({ id: message.id, result: { turn: { id: turnId, status: 'running' } } });
      break;
    case 'thread/unsubscribe':
    case 'thread/name/set':
      send({ id: message.id, result: {} });
      break;
    default:
      send({
        id: message.id,
        error: { code: -32601, message: `fixture does not implement ${message.method}` },
      });
  }
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
