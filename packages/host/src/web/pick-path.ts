import { spawn } from 'node:child_process';

export type PickPathOutcome =
  | { kind: 'ok'; path: string }
  | { kind: 'canceled' }
  | { kind: 'error'; error: string };

/**
 * Native macOS open panel via osascript (`choose file` / `choose folder`).
 * Used by the workspace folder picker and the Settings → Executors CLI-path
 * Browse button. Caller must gate on `process.platform === 'darwin'`.
 */
export function pickPath(kind: 'file' | 'folder', prompt: string): Promise<PickPathOutcome> {
  return new Promise(resolveOutcome => {
    const child = spawn(
      'osascript',
      [
        '-e', 'tell application "System Events" to activate',
        '-e', `POSIX path of (choose ${kind} with prompt "${prompt}")`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data.toString(); });
    child.stderr.on('data', data => { stderr += data.toString(); });
    child.on('error', error => resolveOutcome({ kind: 'error', error: String(error) }));
    child.on('close', code => {
      if (code === 0) {
        const path = stdout.trim().replace(/\/+$/, '');
        resolveOutcome(path
          ? { kind: 'ok', path }
          : { kind: 'error', error: 'empty path returned' });
      } else if (stderr.includes('User canceled') || code === 1) {
        resolveOutcome({ kind: 'canceled' });
      } else {
        resolveOutcome({ kind: 'error', error: stderr.trim() || `osascript exited ${code}` });
      }
    });
  });
}
