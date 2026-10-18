import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ClaudeNativeModel {
  value: string;
  displayName: string;
  description: string;
  supportsEffort: boolean;
  supportedEffortLevels: string[];
}

const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_ID = 'gian-model-catalog';

function safeText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 4096
    // eslint-disable-next-line no-control-regex
    && !/[\x00-\x1F\x7F]/.test(value);
}

/** Claude's initialize response uses value/displayName, not API model ids. */
export function parseClaudeNativeModels(value: unknown): ClaudeNativeModel[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1000) return [];
  const seen = new Set<string>();
  const models: ClaudeNativeModel[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || !safeText(raw.value) || !safeText(raw.displayName)) return [];
    if (seen.has(raw.value)) continue;
    seen.add(raw.value);
    const levels = Array.isArray(raw.supportedEffortLevels)
      ? [...new Set(raw.supportedEffortLevels.filter(safeText))] as string[]
      : [];
    models.push({
      value: raw.value,
      displayName: raw.displayName,
      description: safeText(raw.description) ? raw.description : '',
      supportsEffort: raw.supportsEffort === true,
      supportedEffortLevels: levels,
    });
  }
  return models;
}

/** Metadata-only control handshake. No prompt or user frame is ever sent.
 * Hooks, tools, MCP and transcript persistence are disabled, and the cwd is
 * isolated from project settings. Resolve only after the child has closed. */
export async function probeClaudeNativeModels(
  executable: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ClaudeNativeModel[]> {
  if (options.signal?.aborted) return [];
  let cwd: string;
  try { cwd = mkdtempSync(join(tmpdir(), 'gian-claude-model-catalog-')); }
  catch { return []; }
  try {
    return await new Promise<ClaudeNativeModel[]>((resolve) => {
      const grouped = process.platform !== 'win32';
      const proc = spawn(executable, [
        '--print', '--input-format', 'stream-json', '--output-format', 'stream-json',
        '--verbose', '--no-session-persistence',
        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        '--settings', '{"disableAllHooks":true}', '--tools', '',
      ], { cwd, detached: grouped, stdio: ['pipe', 'pipe', 'pipe'] });
      let models: ClaudeNativeModel[] = [];
      let finishing = false;
      let buffer = '';
      let bytes = 0;
      let terminateTimer: ReturnType<typeof setTimeout> | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (grouped && proc.pid) process.kill(-proc.pid, signal);
          else proc.kill(signal);
        } catch { /* Already gone. */ }
      };
      const finish = (result: ClaudeNativeModel[] = [], abort = false) => {
        if (finishing) return;
        finishing = true;
        models = result;
        clearTimeout(timeout);
        proc.stdin.end();
        if (abort) kill('SIGTERM');
        else terminateTimer = setTimeout(() => kill('SIGTERM'), 250);
        killTimer = setTimeout(() => kill('SIGKILL'), 1000);
      };
      const timeout = setTimeout(() => finish([], true), options.timeoutMs ?? 5000);
      const abort = () => finish([], true);
      options.signal?.addEventListener('abort', abort, { once: true });
      proc.stdin.on('error', () => finish([], true));
      proc.stderr.resume();
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk: string) => {
        if (finishing) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_RESPONSE_BYTES) { finish([], true); return; }
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const event = JSON.parse(line);
            const response = event?.response;
            if (event?.type === 'control_response' && response?.request_id === REQUEST_ID) {
              finish(response.subtype === 'success'
                ? parseClaudeNativeModels(response.response?.models) : []);
              return;
            }
          } catch { /* Ignore non-protocol output. */ }
        }
      });
      proc.on('error', () => finish([], true));
      proc.on('close', () => {
        clearTimeout(timeout);
        clearTimeout(terminateTimer);
        clearTimeout(killTimer);
        options.signal?.removeEventListener('abort', abort);
        resolve(models);
      });
      // This is the same initialize control frame used by the Agent SDK,
      // without the separate user-message stream that starts a paid turn.
      proc.stdin.write(`${JSON.stringify({
        type: 'control_request', request_id: REQUEST_ID,
        request: { subtype: 'initialize', hooks: {} },
      })}\n`);
      if (options.signal?.aborted) abort();
    });
  } catch {
    return [];
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
