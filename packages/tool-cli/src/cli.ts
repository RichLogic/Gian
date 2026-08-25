#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  GIAN_TOOL_METHODS,
  isGianToolMutation,
  type GianToolMethod,
} from '@gian/shared';
import { callGianTool, gianToolSocketPath, socketJson } from './client.js';

function take(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value) throw new Error(`${flag} requires a value`);
  args.splice(index, 2);
  return value;
}

function dataDir(args: string[]): string {
  return resolve(take(args, '--data-dir') ?? process.env.GIAN_DATA_DIR ?? join(homedir(), '.gian'));
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const root = dataDir(args);
  const command = args.shift();
  if (command === 'ping' || command === 'schema') {
    output(await socketJson({
      socketPath: gianToolSocketPath(root),
      method: 'GET',
      path: command === 'ping' ? '/ping' : '/schema',
    }));
    return 0;
  }
  if (command === 'call') {
    const method = args.shift();
    if (!method || !(GIAN_TOOL_METHODS as readonly string[]).includes(method)) {
      throw new Error('call requires a valid Gian Tool method');
    }
    const json = take(args, '--json') ?? '{}';
    const idempotencyKey = take(args, '--idempotency-key');
    if (args.length > 0) throw new Error(`unknown argument: ${args[0]}`);
    const typedMethod = method as GianToolMethod;
    if (isGianToolMutation(typedMethod) && !idempotencyKey) {
      throw new Error(`${method} requires --idempotency-key`);
    }
    const result = await callGianTool({
      dataDir: root,
      method: typedMethod,
      params: JSON.parse(json) as never,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    output(result);
    return result.ok ? 0 : 2;
  }
  if (command === 'wait') {
    const sessionId = take(args, '--session');
    const deliveryId = take(args, '--delivery');
    const timeout = take(args, '--timeout');
    if (!sessionId) throw new Error('wait requires --session');
    if (args.length > 0) throw new Error(`unknown argument: ${args[0]}`);
    const result = await callGianTool({
      dataDir: root,
      method: 'session.wait',
      params: {
        session_id: sessionId,
        ...(deliveryId ? { delivery_id: deliveryId } : {}),
        ...(timeout ? { timeout_ms: Number(timeout) } : {}),
      },
      requestId: randomUUID(),
    });
    output(result);
    return result.ok ? 0 : 2;
  }
  throw new Error('usage: gianctl <ping|schema|call|wait> [--data-dir <path>]');
}

main().then(code => {
  process.exitCode = code;
}).catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  const invalid = error instanceof SyntaxError
    || /requires|unknown argument|usage:|valid Gian Tool method/.test(message);
  output({
    ok: false,
    request_id: '',
    error: {
      code: invalid ? 'INVALID_ARGUMENT' : 'INTERNAL_ERROR',
      message,
      retryable: false,
    },
  });
  process.exitCode = 1;
});
