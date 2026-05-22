import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import type { NativeSession } from '@gian/shared';

/**
 * Scan claude-code and codex on-disk session storage and return the sessions
 * that ran inside the given workspace path. Used by the Native Sessions tab
 * in the Spaces view.
 *
 * cc storage:    `~/.claude/projects/<path-encoded>/<session-uuid>.jsonl`
 *                (path encoded by replacing every `/` with `-`)
 * codex storage: `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<id>.jsonl`
 *                (no path-based dir; we filter by reading session_meta.cwd)
 *                + `~/.codex/session_index.jsonl` flat index for fast listing
 *
 * Results are sorted by updatedAt desc. Cached for 30s per workspace path
 * to keep tab navigation snappy without hammering the FS on every render.
 */

interface CacheEntry {
  ts: number;
  sessions: NativeSession[];
}
const CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30_000;

export function clearNativeSessionsCache(): void {
  CACHE.clear();
}

export interface ScanNativeSessionsOptions {
  /** Override the user home dir the scanner reads from. Used by tests to
   *  isolate fixtures from the developer's real `~/.claude` /
   *  `~/.codex`. When omitted, falls back to `os.homedir()`. */
  homeDir?: string;
  /** Skip the 30s result cache. Tests that rewrite the fixture between
   *  scans need this; production calls leave it false. */
  noCache?: boolean;
}

export async function scanNativeSessions(
  workspacePath: string,
  options: ScanNativeSessionsOptions = {},
): Promise<NativeSession[]> {
  const home = options.homeDir ?? homedir();
  if (!options.noCache) {
    const cached = CACHE.get(workspacePath);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.sessions;
  }

  const [cc, codex] = await Promise.all([
    scanClaudeCode(workspacePath, home).catch(() => [] as NativeSession[]),
    scanCodex(workspacePath, home).catch(() => [] as NativeSession[]),
  ]);

  const merged = [...cc, ...codex].sort((a, b) =>
    Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );
  if (!options.noCache) {
    CACHE.set(workspacePath, { ts: Date.now(), sessions: merged });
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

/** Encode an absolute path the way Claude Code's project dir does:
 *  every `/` becomes `-`. e.g. `/Users/me/proj` → `-Users-me-proj`. */
function encodeCcProjectDir(absPath: string): string {
  return absPath.replaceAll('/', '-');
}

async function scanClaudeCode(workspacePath: string, homeDir: string): Promise<NativeSession[]> {
  const projectDir = join(homeDir, '.claude', 'projects', encodeCcProjectDir(workspacePath));
  if (!existsSync(projectDir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(projectDir);
  } catch {
    return [];
  }

  const out: NativeSession[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    const filePath = join(projectDir, entry);
    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const id = basename(entry, '.jsonl');
    const meta = readCcMetaFromJsonl(filePath);
    out.push({
      id,
      executor: 'claude',
      filePath,
      cwd: workspacePath,
      updatedAt: stat.mtime.toISOString(),
      fileSize: stat.size,
      turnCount: meta.turnCount,
      firstUserMessage: meta.firstUserMessage,
    });
  }
  return out;
}

/** Read a cc JSONL file's metadata for the listing card.
 *  - First user message: scan top-down for the first real human user message.
 *    cc wraps system / IDE / command output as `type:'user'` too, so we must
 *    filter those out (tool_result content blocks, local-command-* tags).
 *  - Turn count: count only real human user messages. */
function readCcMetaFromJsonl(filePath: string): { firstUserMessage: string; turnCount: number } {
  let firstUserMessage = '';
  let turnCount = 0;
  try {
    const content = readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!parsed) continue;
      if (parsed.type !== 'user') continue;
      const msg = parsed.message as { content?: unknown } | undefined;
      const text = extractCcUserText(msg?.content);
      if (!text || isSystemNoise(text)) continue;
      turnCount++;
      if (!firstUserMessage) firstUserMessage = truncatePreview(stripSystemTags(text));
    }
  } catch {
    // ignore — return defaults
  }
  return { firstUserMessage, turnCount };
}

/** cc user message content is either a string (real input) OR an array of
 *  content blocks (tool_result, etc.). We only care about the string form. */
function extractCcUserText(content: unknown): string {
  if (typeof content === 'string') return content;
  // Array form is mostly tool_result — count it as not-a-real-message.
  return '';
}

/** Recognize cc's system-wrapper markers that aren't real user input.
 *  These come from `claude --resume` re-injecting prior context, IDE
 *  integrations, command stdout capture, etc. */
function isSystemNoise(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith('<system-reminder>') ||
    trimmed.startsWith('Caveat: The messages below') ||
    trimmed.startsWith('<command-name>') ||
    /^<local-command-(caveat|stdout|stderr)>/.test(trimmed)
  );
}

/** Strip leading `<command-message>...</command-message>` and similar tags
 *  for preview display. */
function stripSystemTags(text: string): string {
  return text
    .replace(/<command-(name|message|args)>[\s\S]*?<\/command-\1>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .trim();
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

async function scanCodex(workspacePath: string, homeDir: string): Promise<NativeSession[]> {
  const sessionsRoot = join(homeDir, '.codex', 'sessions');
  if (!existsSync(sessionsRoot)) return [];

  // Codex's sessions are nested by date: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
  // We have to walk the tree; there's no path-based shortcut like cc.
  // To bound work, we collect all rollout files first, then read each one's
  // session_meta line to filter by cwd. Most cwd reads are 1 line of file IO.
  const files = collectCodexRolloutFiles(sessionsRoot, 3 /* max depth */);
  const out: NativeSession[] = [];
  for (const file of files) {
    const meta = readCodexMetaFromJsonl(file);
    if (!meta) continue;
    if (meta.cwd !== workspacePath) continue;
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue;
    }
    out.push({
      id: meta.id,
      executor: 'codex',
      filePath: file,
      cwd: meta.cwd,
      updatedAt: stat.mtime.toISOString(),
      fileSize: stat.size,
      turnCount: meta.turnCount,
      firstUserMessage: meta.firstUserMessage,
      ...(meta.gitBranch ? { gitBranch: meta.gitBranch } : {}),
    });
  }
  return out;
}

function collectCodexRolloutFiles(root: string, maxDepth: number): string[] {
  const out: string[] = [];
  function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full, depth + 1);
      } else if (stat.isFile() && entry.endsWith('.jsonl') && entry.startsWith('rollout-')) {
        out.push(full);
      }
    }
  }
  walk(root, 0);
  return out;
}

interface CodexMeta {
  id: string;
  cwd: string;
  gitBranch?: string;
  firstUserMessage: string;
  turnCount: number;
}

function readCodexMetaFromJsonl(filePath: string): CodexMeta | null {
  try {
    const content = readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    // First line is session_meta with id + cwd + git info.
    const firstLine = lines[0];
    if (!firstLine) return null;
    const meta = JSON.parse(firstLine) as Record<string, unknown>;
    if (meta.type !== 'session_meta') return null;
    const payload = meta.payload as Record<string, unknown> | undefined;
    if (!payload) return null;
    const id = typeof payload.id === 'string' ? payload.id : '';
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
    if (!id || !cwd) return null;
    const git = payload.git as Record<string, unknown> | undefined;
    const gitBranch = git && typeof git.branch === 'string' ? git.branch : undefined;

    // Walk subsequent lines for first user message + turn count.
    let firstUserMessage = '';
    let turnCount = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (parsed.type !== 'event_msg') continue;
      const p = parsed.payload as Record<string, unknown> | undefined;
      if (!p) continue;
      if (p.type === 'user_message') {
        turnCount++;
        if (!firstUserMessage && typeof p.message === 'string') {
          firstUserMessage = truncatePreview(p.message);
        }
      }
    }

    return {
      id,
      cwd,
      ...(gitBranch ? { gitBranch } : {}),
      firstUserMessage,
      turnCount,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncatePreview(text: string, maxLen = 120): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen - 1) + '…';
}
