import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { runBoundedCommand } from '@gian/proxy-protocol/node';

const COMMAND = 'grok';
const SETUP_URL = 'https://x.ai/cli/install.sh';

function firstVersion(text: string): string | null {
  return text.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] ?? null;
}

function homeDir(): string {
  return process.env.HOME && isAbsolute(process.env.HOME) ? process.env.HOME : homedir();
}

async function existsExecutable(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function discoverGrokRuntimes(): Promise<{
  candidates: Array<{ path: string; source: 'official-user' | 'official-system' | 'path'; label?: string }>;
  setupActions: Array<
    | { id: string; kind: 'open_url'; label: string; url: string }
    | { id: string; kind: 'select_file'; label: string }
  >;
}> {
  const home = homeDir();
  const seen = new Set<string>();
  const candidates: Array<{ path: string; source: 'official-user' | 'official-system' | 'path'; label?: string }> = [];
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory.trim()) continue;
    const path = resolve(directory, COMMAND);
    if (!isAbsolute(path) || seen.has(path) || !(await existsExecutable(path))) continue;
    seen.add(path);
    candidates.push({ path, source: 'path', label: 'Grok CLI' });
  }
  for (const official of [
    { path: join(home, '.grok', 'bin', COMMAND), source: 'official-user' as const },
    { path: join(home, '.local', 'bin', COMMAND), source: 'official-user' as const },
    { path: `/opt/homebrew/bin/${COMMAND}`, source: 'official-system' as const },
    { path: `/usr/local/bin/${COMMAND}`, source: 'official-system' as const },
  ]) {
    if (seen.has(official.path) || !(await existsExecutable(official.path))) continue;
    seen.add(official.path);
    candidates.push({ ...official, label: 'Grok CLI' });
  }
  return {
    candidates,
    setupActions: [
      { id: 'docs', kind: 'open_url', label: 'Install Grok CLI', url: SETUP_URL },
      { id: 'pick-binary', kind: 'select_file', label: 'Choose Grok binary' },
    ],
  };
}

async function runVersion(path: string): Promise<string> {
  const result = await runBoundedCommand(path, ['--version'], {
    timeoutMs: 8_000,
    env: { ...process.env, GROK_DISABLE_AUTOUPDATER: '1', GROK_SANDBOX: 'workspace' },
  });
  const version = firstVersion(`${result.stdout}\n${result.stderr}`);
  if (!version) throw new Error('`grok --version` did not report a semantic version');
  return version;
}

export async function probeGrokRuntime(path: string): Promise<{
  runtimeId: string;
  displayName: string;
  path: string;
  version: string;
  configHome: string | null;
  contentRoots: Array<{ path: string; mode: 'file' | 'directory' }>;
}> {
  if (!isAbsolute(path)) throw new Error('Grok runtime path must be absolute.');
  await access(path, constants.X_OK);
  const version = await runVersion(path);
  return {
    runtimeId: 'grok',
    displayName: 'Grok CLI',
    path,
    version,
    configHome: join(homeDir(), '.grok'),
    contentRoots: [{ path, mode: 'file' }],
  };
}
