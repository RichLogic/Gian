import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import {
  validateGianToolResult,
  type GianToolMethod,
  type GianToolMethodParams,
  type GianToolResult,
} from '@gian/shared';

export function gianToolSocketPath(dataDir: string): string {
  return join(dataDir, 'run', 'gian-tool-v1.sock');
}

export async function localToolCallerId(dataDir: string, client: string): Promise<string> {
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(client)) {
    throw new Error(`invalid Gian Tool client name: ${client}`);
  }
  const directory = join(dataDir, 'tool');
  const path = join(directory, `${client}-caller-id`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const generated = randomUUID();
  try {
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(`${generated}\n`, 'utf8'); } finally { await file.close(); }
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`refusing unsafe ${client} caller id path: ${path}`);
    }
    await chmod(path, 0o600);
    const existing = (await readFile(path, 'utf8')).trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(existing)) {
      throw new Error(`invalid ${client} caller id: ${path}`);
    }
    return existing;
  }
}

export async function gianctlCallerId(dataDir: string): Promise<string> {
  return localToolCallerId(dataDir, 'gianctl');
}

export async function socketJson(options: {
  socketPath: string;
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
}): Promise<unknown> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      socketPath: options.socketPath,
      method: options.method,
      path: options.path,
      headers: payload ? {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      } : undefined,
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.once('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

export async function callGianTool<M extends GianToolMethod>(options: {
  dataDir: string;
  method: M;
  params: GianToolMethodParams[M];
  idempotencyKey?: string;
  callerId?: string;
  requestId?: string;
}): Promise<GianToolResult> {
  const callerId = options.callerId ?? await gianctlCallerId(options.dataDir);
  const result = await socketJson({
    socketPath: gianToolSocketPath(options.dataDir),
    method: 'POST',
    path: '/rpc',
    body: {
      request_id: options.requestId ?? randomUUID(),
      caller_id: callerId,
      method: options.method,
      params: options.params,
      ...(options.idempotencyKey ? { idempotency_key: options.idempotencyKey } : {}),
    },
  });
  return validateGianToolResult(result) as GianToolResult;
}
