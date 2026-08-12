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
 *     the session JSONL, asynchronously after the first turn. We re-read the
 *     file on each completed turn and take the last non-empty ai-title.
 *   - kimi: the shared kimi proxy's `listNativeSessions` carries a native
 *     `title` per session; match by `native_session_id`.
 *   - codex: no native title capability — straight to the fallback.
 *
 * Claude/Kimi get MAX_NATIVE_ATTEMPTS completed turns to produce a native
 * title; afterwards the fallback (first user message, truncated) is written
 * instead. A user rename always wins: the name is re-checked right before
 * writing, and the write itself goes through SessionManager.renameSession so
 * broadcast + native name-sync behave exactly like a manual rename.
 */

/** Native titles are asynchronous; give the executor this many completed
 *  turns before settling for the truncation fallback. */
const MAX_NATIVE_ATTEMPTS = 3;
const FALLBACK_MAX_LENGTH = 40;
const TITLE_MAX_LENGTH = 200;
/** Same shared-client cache key as NativeSessionService.listKimi. */
const KIMI_CACHE_KEY = '__native_sessions_kimi__';

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
}

export class AutoTitleService {
  /** Completed turns observed per unnamed session; dropped once a title
   *  (native or fallback) is written or the session gains a name. */
  private attempts = new Map<string, number>();
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
    const attempt = (this.attempts.get(sessionId) ?? 0) + 1;
    this.attempts.set(sessionId, attempt);

    const nativeCapable = session.executor === 'claude' || session.executor === 'kimi';
    let title: string | null = null;
    if (nativeCapable && attempt <= MAX_NATIVE_ATTEMPTS) {
      title = await this.nativeTitle(session);
    }
    if (!title && (!nativeCapable || attempt >= MAX_NATIVE_ATTEMPTS)) {
      title = this.fallbackTitle(sessionId);
    }
    // No title yet (native title still pending, or no user message): leave
    // the attempt counted and retry on the next completed turn.
    if (!title) return;

    // The lookup above may have yielded; a user rename during that window
    // always wins, so re-check before writing.
    const current = this.deps.db
      .prepare('SELECT name FROM sessions WHERE id = ?')
      .get(sessionId) as { name: string | null } | undefined;
    if (!current || current.name !== null) {
      this.attempts.delete(sessionId);
      return;
    }
    this.attempts.delete(sessionId);
    this.deps.rename(sessionId, title);
  }

  private async nativeTitle(session: Session): Promise<string | null> {
    if (session.executor === 'claude') return this.claudeTitle(session);
    return this.kimiTitle(session);
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
      // first turn — absence just means "try again next turn".
      return null;
    }
    return parseCcAiTitle(content);
  }

  private async kimiTitle(session: Session): Promise<string | null> {
    if (!session.native_session_id) return null;
    const cwd = this.cwdFor(session);
    if (!cwd) return null;
    try {
      const client = await this.deps.proxy.getOrCreate(KIMI_CACHE_KEY, 'kimi');
      await client.initialize();
      if (!client.listNativeSessions) return null;
      // Same pagination pattern as NativeSessionService.listKimi.
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
          if (title) return title;
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
      // respawns, and leave the title unset for this turn.
      await this.deps.proxy.dispose(KIMI_CACHE_KEY).catch(() => undefined);
      console.warn(
        `[auto-title] kimi native session lookup failed session=${session.id}: ${String(error)}`,
      );
      return null;
    }
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
