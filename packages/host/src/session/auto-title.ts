import { readFileSync } from 'node:fs';
import type { Session } from '@gian/shared';
import { locateCcJsonl } from '../native/locate-jsonl.js';
import type { ProxyManager } from '../proxy/manager.js';
import type { Db } from '../storage/db.js';
import type { SessionHistoryStore } from './history-store.js';
import type { SessionRepository } from './repository.js';

/**
 * Issue #57: derive a session name automatically once an unnamed session has
 * produced completed turns.
 *
 *   - claude: Claude Code writes `{"type":"ai-title","aiTitle":...}` lines into
 *     the session JSONL, asynchronously after the first turn.
 *   - codex: its shared discovery proxy exposes the native LM-generated name.
 *   - kimi: the same discovery API exposes Kimi's native first-message
 *     preview (not a separate LM summary).
 *
 * Native titles land asynchronously, so a single completed turn starts a
 * bounded, time-based poll. Only after that window expires do we use the
 * truncated first user message as a fallback. A user rename always wins: the
 * name is checked during polling and immediately before writing, and the write
 * itself goes through SessionManager.renameSession so broadcast + native
 * name-sync behave exactly like a manual rename.
 */

/** Immediate lookup, then a bounded ~16 second window for an asynchronous
 *  executor-native title candidate to land after turn completion. */
const DEFAULT_NATIVE_POLL_DELAYS_MS = [0, 250, 500, 1_000, 2_000, 4_000, 8_000] as const;
const FALLBACK_MAX_LENGTH = 40;
const TITLE_MAX_LENGTH = 200;

/** Same cleaning as `appendCcCustomTitle`: control chars out, trim, cap. */
export function sanitizeTitle(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\x00-\x1F\x7F]/g, ' ').trim().slice(0, TITLE_MAX_LENGTH);
}

/** Whitespace-collapsed, ellipsized fallback title from a user message. */
export function truncateFallbackTitle(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= FALLBACK_MAX_LENGTH) return collapsed;
  return `${collapsed.slice(0, FALLBACK_MAX_LENGTH - 1).trimEnd()}…`;
}

/**
 * Extract the ai-title from Claude Code session JSONL content. Claude Code
 * may regenerate the title, so the LAST non-empty ai-title line wins.
 * Tolerates partially-written trailing lines. Never throws.
 */
export function parseCcAiTitle(jsonl: string): string | null {
  let title: string | null = null;
  for (const line of jsonl.split('\n')) {
    if (!line.includes('"ai-title"')) continue;
    try {
      const parsed = JSON.parse(line) as { type?: unknown; aiTitle?: unknown };
      if (parsed.type !== 'ai-title') continue;
      const clean = typeof parsed.aiTitle === 'string'
        ? sanitizeTitle(parsed.aiTitle)
        : '';
      if (clean) title = clean;
    } catch {
      // Skip malformed lines (e.g. a torn final write).
    }
  }
  return title;
}

interface AutoTitleDeps {
  db: Db;
  sessions: SessionRepository;
  history: SessionHistoryStore;
  proxy: ProxyManager;
  /** SessionManager.renameSession — DB write + broadcast + native name sync. */
  rename: (sessionId: string, name: string) => void;
  /** Test seam for the bounded native-title polling schedule. */
  nativePollDelaysMs?: readonly number[];
  /** Test seam for advancing polling without wall-clock delays. */
  sleep?: (delayMs: number) => Promise<void>;
}

export class AutoTitleService {
  /** One async derivation per session at a time. */
  private inFlight = new Set<string>();

  constructor(private deps: AutoTitleDeps) {}

  /**
   * Fire-and-forget entry point called from turn completion. Errors are
   * logged, never propagated — auto-title must not break turn completion.
   * Returns the internal promise purely so tests can await settlement.
   */
  maybeAutoTitle(sessionId: string): Promise<void> | null {
    if (this.inFlight.has(sessionId)) return null;
    let row: { name: string | null } | undefined;
    try {
      row = this.deps.db
        .prepare('SELECT name FROM sessions WHERE id = ?')
        .get(sessionId) as { name: string | null } | undefined;
    } catch {
      return null;
    }
    if (!row || row.name !== null) return null;

    this.inFlight.add(sessionId);
    const promise = this.run(sessionId)
      .catch(error => {
        console.warn(`[auto-title] failed session=${sessionId}: ${String(error)}`);
      })
      .finally(() => this.inFlight.delete(sessionId));
    return promise;
  }

  private async run(sessionId: string): Promise<void> {
    const session = this.deps.sessions.get(sessionId);
    let title: string | null = null;

    const delays = this.deps.nativePollDelaysMs ?? DEFAULT_NATIVE_POLL_DELAYS_MS;
    const sleep = this.deps.sleep ?? (delayMs => new Promise<void>(resolve => {
      setTimeout(resolve, delayMs);
    }));
    for (const delayMs of delays) {
      if (delayMs > 0) await sleep(delayMs);
      if (!this.isUnnamed(sessionId)) return;
      title = await this.nativeTitle(session);
      if (title) break;
    }

    // The bounded native-title window expired. Settle on the first user
    // message so a one-turn session does not remain unnamed forever.
    if (!title) title = this.fallbackTitle(sessionId);
    if (!title) return;

    // The lookup above may have yielded; a user rename during that window
    // always wins, so re-check before writing.
    if (!this.isUnnamed(sessionId)) return;
    this.deps.rename(sessionId, title);
  }

  private async nativeTitle(session: Session): Promise<string | null> {
    if (session.executor === 'claude') return this.claudeTitle(session);
    return this.proxyTitle(session);
  }

  private claudeTitle(session: Session): string | null {
    if (!session.native_session_id) return null;
    const cwd = this.cwdFor(session);
    if (!cwd) return null;
    const filePath = locateCcJsonl(session.native_session_id, cwd);
    if (!filePath) return null;
    let content: string;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch {
      // The CLI creates the file lazily and the ai-title lands after the
      // first turn — absence just means "keep polling".
      return null;
    }
    return parseCcAiTitle(content);
  }

  private async proxyTitle(session: Session): Promise<string | null> {
    if (!session.native_session_id) return null;
    const cwd = this.cwdFor(session);
    if (!cwd) return null;
    const cacheKey = `__native_sessions_${session.executor}__`;
    try {
      const client = await this.deps.proxy.getOrCreate(cacheKey, session.executor);
      await client.initialize();
      if (!client.listNativeSessions) return null;
      // Same pagination pattern as NativeSessionService.listFromProxy.
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
        const result = await client.listNativeSessions({
          cwd,
          ...(cursor ? { cursor } : {}),
        });
        if (!result || typeof result !== 'object') break;
        const page = result as { sessions?: unknown; nextCursor?: unknown };
        if (!Array.isArray(page.sessions)) break;
        for (const entry of page.sessions) {
          if (!entry || typeof entry !== 'object') continue;
          const item = entry as { sessionId?: unknown; title?: unknown };
          if (item.sessionId !== session.native_session_id) continue;
          const title = typeof item.title === 'string' ? sanitizeTitle(item.title) : '';
          if (!title) continue;
          // Codex thread/list exposes prompt-derived placeholders while its
          // LM-generated `name` is still pending: either the 120-char preview
          // or Codex's short ellipsized fallback. Treat both as "not ready"
          // so neither can win the race against the real title. Kimi
          // intentionally keeps its native first-message preview.
          if (session.executor === 'codex' && this.isCodexPromptDerivedTitle(session.id, title)) {
            continue;
          }
          return title;
        }
        const nextCursor = typeof page.nextCursor === 'string' && page.nextCursor
          ? page.nextCursor
          : undefined;
        if (!nextCursor || seenCursors.has(nextCursor)) break;
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
      return null;
    } catch (error) {
      // The shared lookup client may be wedged; drop it so the next attempt
      // respawns, and leave the title unset for this poll.
      await this.deps.proxy.dispose(cacheKey).catch(() => undefined);
      console.warn(
        `[auto-title] ${session.executor} native session lookup failed session=${session.id}: ${String(error)}`,
      );
      return null;
    }
  }

  private isUnnamed(sessionId: string): boolean {
    try {
      const row = this.deps.db
        .prepare('SELECT name FROM sessions WHERE id = ?')
        .get(sessionId) as { name: string | null } | undefined;
      return Boolean(row && row.name === null);
    } catch {
      // Host shutdown can close the DB while a bounded poll is sleeping.
      // Treat that exactly like a removed/named session and stop quietly.
      return false;
    }
  }

  private isCodexPromptDerivedTitle(sessionId: string, candidate: string): boolean {
    const firstUserMessage = this.deps.history.firstUserMessageText(sessionId);
    if (!firstUserMessage) return false;
    const collapsed = firstUserMessage.replace(/\s+/g, ' ').trim();
    const preview = collapsed.length <= 120
      ? collapsed
      : `${collapsed.slice(0, 117)}...`;
    return candidate === sanitizeTitle(preview)
      || candidate === sanitizeTitle(truncateFallbackTitle(firstUserMessage));
  }

  private fallbackTitle(sessionId: string): string | null {
    const text = this.deps.history.firstUserMessageText(sessionId);
    if (!text) return null;
    const title = sanitizeTitle(truncateFallbackTitle(text));
    return title || null;
  }

  private cwdFor(session: Session): string | null {
    if (session.worktree_path) return session.worktree_path;
    const workspace = this.deps.db
      .prepare('SELECT path FROM workspaces WHERE id = ?')
      .get(session.workspace_id) as { path: string } | undefined;
    return workspace?.path ?? null;
  }
}
