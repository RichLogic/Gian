import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { createNodeWebSocket } from '@hono/node-ws';
import { setCookie, deleteCookie } from 'hono/cookie';
import { fileURLToPath } from 'node:url';
import type { Db } from '../storage/db.js';
import type { BotExtra, BotMode, IMPlatform, SystemConfig } from '@gian/shared';
import { WsBroadcaster } from './ws-broadcast.js';
import { ProxyManager } from '../proxy/manager.js';
import { SessionManager } from '../session/manager.js';
import { ApprovalManager } from '../approval/index.js';
import { QueueManager } from '../queue/index.js';
import { NativeJsonlWatcher } from '../native/watcher.js';
import { locateNativeJsonl } from '../native/locate-jsonl.js';
import { makeWsHandlers } from './ws-handler.js';
import { loadConfig, saveConfig, loadPasswordHash, savePasswordHash } from '../storage/config.js';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { createSessionToken, getUsernameForToken, deleteToken } from '../auth/tokens.js';
import { requireAuth, AUTH_REQUIRED } from '../auth/middleware.js';
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { resolveWithinWorkspace } from '../workspace/safe-path.js';
import {
  listLocalBranches,
  buildRemoteBranchList,
  REMOTE_BRANCHES_FOR_EACH_REF_FMT,
} from '../workspace/git-branches.js';
import {
  buildRawPreviewHeaders,
  rawPreviewOversize,
} from '../workspace/preview-headers.js';
import { execFileSync, spawn } from 'node:child_process';
import { buildEditorArgs, defaultOpenerArgs, runOpen, type OpenCommand } from './open-with.js';
import { randomBytes } from 'node:crypto';
// IM layer transplanted from remote-vibe-coding (rvc). Per-platform
// managers own their bot lifecycle + event routing; build-options.ts
// adapts Gian's domain services into the rvc-shaped MessagingPlatform
// dependencies. Manager-driven bot toggle/REST lands in a follow-up — the
// existing legacy `/api/bots` endpoints (against the old `bots` table)
// stay informational-only for now.
import { DiscordCodingManager } from '../im/discord/manager.js';
import { SlackCodingManager } from '../im/slack/manager.js';
import {
  GianBridgedDiscordRepository,
  GianBridgedSlackRepository,
} from '../im/gian-bridged-repos.js';
import {
  buildIMOptions,
  gianApprovalToRvcPending,
  gianSessionToRvcRecord,
} from '../im/build-options.js';
import type { MessagingPlatform } from '../im/messaging/types.js';
import { migrateLegacyBots } from '../im/migrate-legacy-bots.js';
import {
  listAllBots as imListBots,
  getBotById as imGetBot,
  createNewBot as imCreateBot,
  updateBotFields as imUpdateBot,
  deleteBotRow as imDeleteBot,
  setBotEnabled as imSetBotEnabled,
} from '../im/bots-api.js';
// `bots.ts` legacy helpers are referenced only by `migrateLegacyBots` (one
// shot at startup) — REST endpoints now go through `im/bots-api` against the
// rvc-shaped per-platform tables.
import { initWorkspace, expandHome } from '../workspace/index.js';
import { TtyManager } from '../tty/manager.js';
import { CodexTtyManager } from '../tty/codex-manager.js';
import { WorkbenchTerminalManager } from '../term/manager.js';
import { CcProxyClient } from '../proxy/cc-proxy-client.js';
import { writeFile } from 'node:fs/promises';
import { ensureEventsRebuilt } from '../events/lazy-rebuild.js';
import { markAccessed } from '../events/lifecycle.js';
import {
  ALLOWED_MIME,
  MAX_ATTACHMENT_BYTES,
  writeAttachment,
} from '../storage/attachments.js';

export interface AppContext {
  db: Db;
  config: SystemConfig;
  dataDir: string;
  ccProxyEntry: string;
  codexProxyEntry?: string;
  codexBin?: string;
}

export interface AppHandle {
  app: Hono;
  injectWebSocket: ReturnType<typeof createNodeWebSocket>['injectWebSocket'];
  shutdown: () => Promise<void>;
}

export function createApp(ctx: AppContext): AppHandle {
  const app = new Hono();
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

  const broadcaster = new WsBroadcaster();
  const proxy = new ProxyManager({
    dataDir: ctx.dataDir,
    ccProxyEntry: ctx.ccProxyEntry,
    codexProxyEntry: ctx.codexProxyEntry,
    codexBin: ctx.codexBin,
  });
  const approvals = new ApprovalManager(broadcaster);
  const queue = new QueueManager(ctx.db);
  const watcher = new NativeJsonlWatcher(ctx.db, broadcaster);
  const sessions = new SessionManager(ctx.db, proxy, broadcaster, approvals, queue, ctx.dataDir, watcher);

  // TTY runtime coordinator. The hook base URL must match what the
  // in-PTY `claude` can actually reach — for now this is hard-locked to
  // 127.0.0.1:<port>. The per-session `settings.json` allowlists exactly
  // this prefix via `allowedHttpHookUrls`.
  const hookPort = ctx.config.port || 8990;
  const hookBaseUrl = `http://127.0.0.1:${hookPort}`;
  const tty = new TtyManager(ctx.db, proxy, broadcaster, hookBaseUrl);
  sessions.setTtyManager(tty);

  // Codex CLI runtime coordinator. No hooks (codex has no `--settings`
  // hook surface), so no token registry / settings.json / HTTP route —
  // just PTY lifecycle + pty:output broadcast keyed on gianSessionId.
  const codexTty = new CodexTtyManager(ctx.db, proxy, broadcaster);
  sessions.setCodexTtyManager(codexTty);

  // Workbench terminal manager — standalone shell PTYs, independent of
  // any Gian session. The xterm tabs in the workbench pane are bound to
  // client-minted `term_id`s and routed through `term:*` WS messages.
  const term = new WorkbenchTerminalManager(broadcaster);

  // Live Sync v2: on host boot, attach a watcher to every active session so
  // we resume picking up external CLI appends after a host restart. New
  // sessions get watched lazily inside SessionManager.bringUpProxySession.
  bootJsonlWatchers(ctx.db, watcher);

  // Break the circular dependency: ApprovalManager needs to call back into
  // SessionManager to forward auto-approve decisions to the proxy, but we
  // can't import SessionManager from ApprovalManager. Inject the callbacks
  // here after both objects exist.
  approvals.setRespondFn((sid, aid, dec) => sessions.respondApproval(sid, aid, dec));
  approvals.setGetModeFn(sid => sessions.getSession(sid).approval_mode);

  // IM layer — instantiate per-platform managers, wire SessionManager
  // events into them, and start enabled bots.
  // The bridged repos delegate every session-related method to Gian's
  // SessionManager so `/switch` / `/status` etc. see Gian sessions instead
  // of empty rvc-side `*_coding_sessions` tables. Bot CRUD, outbox, and
  // queued-turn methods stay on the rvc base implementation.
  const discordRepo = new GianBridgedDiscordRepository(ctx.db, { sessions });
  const slackRepo = new GianBridgedSlackRepository(ctx.db, { sessions });
  const imOptions = buildIMOptions(
    { sessions, approvals, db: ctx.db },
    { discord: discordRepo, slack: slackRepo },
  );
  const discordMgr = new DiscordCodingManager({
    ...imOptions.shared,
    ...imOptions.discordExtras,
  });
  const slackMgr = new SlackCodingManager({
    ...imOptions.shared,
    ...imOptions.slackExtras,
  });
  const platforms: MessagingPlatform[] = [discordMgr, slackMgr];

  // Fan SessionManager events out to every IM platform. Errors are logged
  // and swallowed so a slow / broken IM bot can't poison the session loop.
  sessions.onEvent(e => {
    void fanIMEvent(e, sessions, approvals, platforms).catch(err => {
      console.error('[im] event fan-out failed', err);
    });
  });

  // Pre-warm proxy capabilities so IM `/alter` (which reads model options
  // synchronously via `sessions.getCapabilities`) sees a populated cache
  // even before any web session has spun up. Async, non-blocking — failures
  // are tolerated (warmCapabilities itself catches inside).
  //
  // Skipped when `GIAN_SKIP_PROXY_WARMUP=1` so tests can `createApp` an
  // in-memory Hono harness without spawning a real cc-proxy / codex-proxy
  // child. The fire-and-forget warmup would otherwise leak subprocesses
  // and a fixture tmp dir gets polluted with daemon logs.
  if (process.env['GIAN_SKIP_PROXY_WARMUP'] !== '1') {
    void Promise.all([
      sessions.warmCapabilities('claude').catch(err => {
        console.warn('[im] warmCapabilities(claude) failed:', err instanceof Error ? err.message : err);
      }),
      sessions.warmCapabilities('codex').catch(err => {
        console.warn('[im] warmCapabilities(codex) failed:', err instanceof Error ? err.message : err);
      }),
    ]);
  }

  // One-shot migration of legacy `bots` rows into rvc-shaped tables. Idempotent:
  // re-runs are no-ops once a bot id is present in the new tables. Runs before
  // startAll so newly-migrated bots that were enabled in the old table get
  // started immediately on this boot.
  void migrateLegacyBots(ctx.db).then(result => {
    if (result.discordMigrated || result.slackMigrated) {
      console.log(
        `[im] migrated legacy bots → discord:${result.discordMigrated} slack:${result.slackMigrated} skipped:${result.skipped}`,
      );
    }
    for (const e of result.errors) {
      console.warn(`[im] legacy bot ${e.id} migration failed: ${e.error}`);
    }
  }).catch(err => {
    console.error('[im] migrateLegacyBots failed', err);
  }).finally(() => {
    // Boot enabled bots without blocking startup.
    void Promise.all(platforms.map(p => p.startAll().catch(err => {
      console.error(`[im] ${p.platformId} startAll failed`, err);
    })));
  });

  const handlers = makeWsHandlers({ sessions, broadcaster, approvals, tty, codexTty, term, db: ctx.db });

  if (AUTH_REQUIRED) {
    ensurePasswordHash(ctx.db);
  }

  // Static SPA assets are served before requireAuth so the login page itself
  // can load when AUTH_REQUIRED is true. The handler returns a Response only
  // when it actually finds a file; otherwise it falls through to requireAuth
  // and the API routes below.
  const webDist = resolveWebDistDir();
  if (webDist) {
    app.use('*', staticFiles(webDist));
  }

  // Hook receivers — registered BEFORE requireAuth() because the in-PTY
  // `claude` carries no web session cookie. Auth here is:
  //   1. server binds to 127.0.0.1 (loopback only) — see scripts/install
  //   2. per-spawn token in `?t=` (one-shot, rotated on every mode flip)
  // The token namespace is the TTY registry — see packages/host/src/tty.
  app.post('/internal/hooks/claude/:sessionId/:event', async c => {
    const sessionIdParam = c.req.param('sessionId');
    const event = c.req.param('event');
    const token = c.req.query('t') ?? '';
    if (!token) return c.json({ error: 'missing token' }, 401);
    const resolvedSession = tty.registry.resolve(token);
    if (!resolvedSession || resolvedSession !== sessionIdParam) {
      return c.json({ error: 'invalid token' }, 401);
    }
    let body: unknown = null;
    try { body = await c.req.json(); } catch { /* empty body is fine */ }
    const result = await tty.handleHook(sessionIdParam, event, body);
    return c.json({ ok: true }, result.status === 200 ? 200 : (result.status as 200));
  });

  app.use('*', requireAuth());

  app.get('/health', c => c.json({ ok: true, version: '0.1.0' }));

  app.post('/api/auth/login', async c => {
    const body = await c.req.json<{ username?: string; password?: string }>();
    const cfg = loadConfig(ctx.db);
    const username = cfg.auth_username || 'admin';
    if (!body.username || !body.password) {
      return c.json({ error: 'username and password required' }, 400);
    }
    if (body.username !== username) {
      return c.json({ error: 'invalid credentials' }, 401);
    }
    const storedHash = loadPasswordHash(ctx.db);
    const ok = storedHash ? await verifyPassword(body.password, storedHash) : false;
    if (!ok) {
      return c.json({ error: 'invalid credentials' }, 401);
    }
    const token = await createSessionToken(username);
    setCookie(c, 'gian_session', token, {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
    });
    return c.json({ user: username });
  });

  app.get('/api/auth/me', c => {
    if (!AUTH_REQUIRED) {
      const cfg = loadConfig(ctx.db);
      return c.json({ user: cfg.auth_username || 'dev' });
    }
    const cookie = c.req.header('cookie') ?? '';
    const match = cookie.match(/(?:^|;\s*)gian_session=([^;]+)/);
    const cookieToken = match?.[1] ?? '';
    const authHeader = c.req.header('Authorization') ?? '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const token = cookieToken || bearerToken;
    const username = token ? getUsernameForToken(token) : null;
    if (!username) return c.json({ error: 'unauthorized' }, 401);
    return c.json({ user: username });
  });

  // The login cookie is httpOnly so the browser JS cannot read it for use in
  // the WS auth message. This endpoint echoes the same token back in JSON
  // for any caller already authenticated via cookie or bearer header. When
  // AUTH_REQUIRED is false the WS handler accepts any non-empty token, so
  // we still return a stable placeholder value.
  app.get('/api/auth/ws-token', c => {
    if (!AUTH_REQUIRED) return c.json({ token: 'dev-token' });
    const cookie = c.req.header('cookie') ?? '';
    const match = cookie.match(/(?:^|;\s*)gian_session=([^;]+)/);
    const cookieToken = match?.[1] ?? '';
    const authHeader = c.req.header('Authorization') ?? '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const token = cookieToken || bearerToken;
    if (!token || !getUsernameForToken(token)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    return c.json({ token });
  });

  app.post('/api/auth/logout', c => {
    const cookie = c.req.header('cookie') ?? '';
    const match = cookie.match(/(?:^|;\s*)gian_session=([^;]+)/);
    const cookieToken = match?.[1] ?? '';
    const authHeader = c.req.header('Authorization') ?? '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const token = cookieToken || bearerToken;
    if (token) deleteToken(token);
    deleteCookie(c, 'gian_session', { path: '/' });
    return c.json({ ok: true });
  });

  app.post('/api/auth/password', async c => {
    if (!AUTH_REQUIRED) {
      return c.json({ error: 'auth not enabled' }, 400);
    }
    const body = await c.req.json<{ current_password?: string; new_password?: string }>();
    if (!body.current_password || !body.new_password) {
      return c.json({ error: 'current_password and new_password required' }, 400);
    }
    const storedHash = loadPasswordHash(ctx.db);
    const ok = storedHash ? await verifyPassword(body.current_password, storedHash) : false;
    if (!ok) {
      return c.json({ error: 'invalid current password' }, 401);
    }
    const newHash = await hashPassword(body.new_password);
    savePasswordHash(ctx.db, newHash);
    return c.json({ ok: true });
  });

  app.get('/api/settings', c => {
    return c.json(loadConfig(ctx.db));
  });

  app.patch('/api/settings', async c => {
    const body = await c.req.json<Partial<SystemConfig>>();
    saveConfig(ctx.db, body);
    return c.json(loadConfig(ctx.db));
  });

  app.get('/api/workspaces', c => {
    const rows = ctx.db
      .prepare('SELECT * FROM workspaces ORDER BY sort_order, name')
      .all();
    return c.json(rows);
  });

  app.post('/api/workspaces', async c => {
    const body = await c.req.json<{
      name: string;
      git_remote?: string;
      /** Absolute path (~ allowed) to adopt as workspace. When set, name is
       *  a display label only; the path is used verbatim and no mkdir/git
       *  init runs against it. */
      path?: string;
    }>();
    if (!body.name) {
      return c.json({ error: 'name required' }, 400);
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(body.name)) {
      return c.json({ error: 'name may only contain letters, digits, dot, dash, underscore' }, 400);
    }

    const adopt = typeof body.path === 'string' && body.path.trim() !== '';
    const cfg = loadConfig(ctx.db);
    const root = resolve(expandHome(cfg.workspace_root || '~/Coding'));
    let path: string;
    if (adopt) {
      const expanded = expandHome(body.path!.trim());
      if (!isAbsolute(expanded)) {
        return c.json({ error: 'path must be absolute (or start with ~)' }, 400);
      }
      path = resolve(expanded);
      if (path === root) {
        return c.json({ error: `cannot adopt the workspace root itself (${root}) — pick a subdirectory or another path` }, 400);
      }
    } else {
      path = resolve(root, body.name);
    }

    // Block duplicate paths — two workspaces pointing at the same dir would
    // share files/git state and confuse session listings.
    const existing = ctx.db
      .prepare('SELECT id, name FROM workspaces WHERE path = ?')
      .get(path) as { id: string; name: string } | undefined;
    if (existing) {
      return c.json({ error: `path is already a workspace: "${existing.name}"` }, 409);
    }

    const result = initWorkspace({
      path,
      ...(body.git_remote ? { gitRemote: body.git_remote } : {}),
      name: body.name,
      ...(adopt ? { adopt: true } : {}),
    });
    if (!result.ok) {
      return c.json({ error: result.error ?? 'init failed', notes: result.notes }, 400);
    }

    const id = crypto.randomUUID();
    try {
      ctx.db
        .prepare(`INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)`)
        .run(id, body.name, path);
    } catch (err) {
      return c.json({ error: String(err), notes: result.notes }, 400);
    }
    const row = ctx.db
      .prepare('SELECT * FROM workspaces WHERE id = ?')
      .get(id);
    return c.json({ workspace: row, notes: result.notes });
  });

  app.patch('/api/workspaces/:id', async c => {
    const id = c.req.param('id');
    const ws = ctx.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
    if (!ws) return c.json({ error: 'workspace not found' }, 404);

    const body = await c.req.json<Record<string, unknown>>();

    // Validate hidden explicitly before the loop (boolean → 0/1 coercion)
    if ('hidden' in body && typeof body.hidden !== 'boolean') {
      return c.json({ error: 'hidden must be boolean' }, 400);
    }

    const allowed = ['name', 'hidden'] as const;
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const key of allowed) {
      if (key in body) {
        sets.push(`${key} = ?`);
        vals.push(key === 'hidden' ? (body.hidden ? 1 : 0) : body[key]);
      }
    }
    if (sets.length === 0) return c.json({ error: 'no updatable fields' }, 400);
    sets.push(`updated_at = datetime('now')`);
    vals.push(id);
    try {
      ctx.db.prepare(`UPDATE workspaces SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
    const updated = ctx.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
    return c.json(updated);
  });

  app.delete('/api/workspaces/:id', c => {
    const id = c.req.param('id');
    const ws = ctx.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
    if (!ws) return c.json({ error: 'workspace not found' }, 404);
    const ref = ctx.db.prepare('SELECT COUNT(*) as n FROM sessions WHERE workspace_id = ?').get(id) as { n: number };
    if (ref.n > 0) return c.json({ error: 'workspace has associated sessions' }, 409);
    // Block deletion when there are still-live worktree sessions on this
    // workspace — their worktree dirs would be orphaned. Caller must merge
    // or drop them first.
    const liveWt = ctx.db
      .prepare('SELECT COUNT(*) as n FROM sessions WHERE workspace_id = ? AND worktree_path IS NOT NULL')
      .get(id) as { n: number };
    if (liveWt.n > 0) return c.json({ error: 'workspace has live worktrees; merge or drop them first' }, 409);
    ctx.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
    return c.json({ ok: true });
  });

  // macOS native folder picker — invokes osascript's `choose folder` dialog.
  // The browser cannot read absolute filesystem paths through a normal file
  // input, so we round-trip through the host (which is running locally on
  // the user's mac anyway). User cancel → 200 { canceled: true }.
  app.post('/api/workspaces/pick-folder', async c => {
    if (process.platform !== 'darwin') {
      return c.json({ error: 'directory picker only available on macOS' }, 400);
    }
    const outcome = await new Promise<
      | { kind: 'ok'; path: string }
      | { kind: 'canceled' }
      | { kind: 'error'; error: string }
    >((resolve) => {
      const child = spawn(
        'osascript',
        [
          // Activate System Events first so the dialog steals focus from
          // Chrome — otherwise it can pop up behind the browser window.
          '-e', 'tell application "System Events" to activate',
          '-e', 'POSIX path of (choose folder with prompt "Select workspace folder")',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', d => { stdout += d.toString(); });
      child.stderr.on('data', d => { stderr += d.toString(); });
      child.on('error', err => resolve({ kind: 'error', error: String(err) }));
      child.on('close', code => {
        if (code === 0) {
          // POSIX path returns with a trailing slash for directories — strip
          // it so we match the canonical form used elsewhere in the codebase.
          const path = stdout.trim().replace(/\/+$/, '');
          if (!path) resolve({ kind: 'error', error: 'empty path returned' });
          else resolve({ kind: 'ok', path });
        } else if (stderr.includes('User canceled') || code === 1) {
          resolve({ kind: 'canceled' });
        } else {
          resolve({ kind: 'error', error: stderr.trim() || `osascript exited ${code}` });
        }
      });
    });
    if (outcome.kind === 'ok') return c.json({ path: outcome.path });
    if (outcome.kind === 'canceled') return c.json({ canceled: true });
    return c.json({ error: outcome.error }, 500);
  });

  app.post('/api/workspaces/reorder', async c => {
    const body = await c.req.json<{ ids: string[] }>();
    if (!Array.isArray(body.ids)) return c.json({ error: 'ids required' }, 400);
    const update = ctx.db.prepare(`UPDATE workspaces SET sort_order = ?, updated_at = datetime('now') WHERE id = ?`);
    ctx.db.transaction(() => {
      for (let i = 0; i < body.ids.length; i++) {
        update.run(i, body.ids[i]);
      }
    })();
    return c.json({ ok: true });
  });

  // Proxy capabilities — surfaces real model list (id / displayName /
   // description / supportedEfforts) so the Composer doesn't hardcode.
  app.get('/api/proxy/:executor/models', async c => {
    const executor = c.req.param('executor');
    if (executor !== 'codex' && executor !== 'claude') {
      return c.json({ error: 'unknown executor' }, 400);
    }
    try {
      const caps = await sessions.warmCapabilities(executor);
      return c.json({ models: caps.models });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  /**
   * Slash commands available in the executor's CLI. Optional ?workspace=<id>
   * adds project-level custom commands (scanned from <workspace>/.claude/commands
   * or .codex/prompts) on top of the built-ins + user-level customs.
   */
  app.get('/api/proxy/:executor/slash', async c => {
    const executor = c.req.param('executor');
    if (executor !== 'codex' && executor !== 'claude') {
      return c.json({ error: 'unknown executor' }, 400);
    }
    const wsId = c.req.query('workspace');
    let cwd: string | undefined;
    if (wsId) {
      const ws = ctx.db.prepare('SELECT path FROM workspaces WHERE id = ?').get(wsId) as
        | { path: string }
        | undefined;
      if (ws) cwd = ws.path;
    }
    try {
      const list = await sessions.listSlashCommands(executor, cwd);
      return c.json(list);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.get('/api/sessions', c => {
    const archived = c.req.query('archived');
    if (archived === 'true') return c.json(sessions.listSessions({ archivedOnly: true }));
    if (archived === 'all') return c.json(sessions.listSessions({ includeArchived: true }));
    return c.json(sessions.listSessions());
  });

  app.post('/api/sessions/:id/merge', async c => {
    const id = c.req.param('id');
    try {
      await sessions.mergeWorktree(id);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.post('/api/sessions/:id/drop', async c => {
    const id = c.req.param('id');
    try {
      await sessions.dropWorktree(id);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.post('/api/sessions/:id/attachments', async c => {
    const sessionId = c.req.param('id');
    // 404 if no such session in DB — checked before parsing the body (cheaper).
    const row = ctx.db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
    if (!row) return c.json({ error: 'session not found' }, 404);

    const body = await c.req.parseBody();
    const file = body['file'];
    if (!(file instanceof File)) {
      return c.json({ error: 'file field required' }, 400);
    }
    if (!ALLOWED_MIME.has(file.type)) {
      return c.json({ error: `unsupported mime: ${file.type}` }, 415);
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      return c.json({ error: `file too large: ${file.size} bytes` }, 413);
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    const path = await writeAttachment(sessionId, bytes, file.type);
    return c.json({ path, name: file.name, size: file.size, mime: file.type });
  });

  app.post('/api/sessions/:id/archive', async c => {
    const id = c.req.param('id');
    const body = await c.req.json<{ archived: boolean }>().catch(() => ({ archived: true }));
    try {
      sessions.archiveSession(id, body.archived !== false);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.delete('/api/sessions/:id', async c => {
    const id = c.req.param('id');
    try {
      await sessions.deleteSession(id);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.get('/api/sessions/:id/events', c => {
    const id = c.req.param('id');
    try {
      // Lazy rebuild from JSONL if this is a cold session whose events
      // were swept by sweepColdEvents at boot. Idempotent — no-ops when
      // the hot cache is already populated. Touch last_accessed_at so
      // future sweeps know this session is still in active use.
      try {
        ensureEventsRebuilt(ctx.db, id);
      } catch (err) {
        console.warn(`[gian] failed to rebuild events for session ${id}:`, err);
      }
      markAccessed(ctx.db, id);
      return c.json(sessions.listEvents(id));
    } catch (err) {
      return c.json({ error: String(err) }, 404);
    }
  });

  // Files browser — scoped to a workspace's root path. Path traversal outside
  // the workspace is rejected.
  app.get('/api/workspaces/:id/tree', async c => {
    const id = c.req.param('id');
    const rel = c.req.query('path') ?? '';
    const ws = ctx.db.prepare('SELECT path FROM workspaces WHERE id = ?').get(id) as
      | { path: string }
      | undefined;
    if (!ws) return c.json({ error: 'workspace not found' }, 404);
    const resolved = await resolveWithinWorkspace(ws.path, rel);
    if (!resolved) return c.json({ error: 'path escapes workspace' }, 400);
    try {
      const entries = await readdir(resolved, { withFileTypes: true });
      const out = entries
        .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
        .map(e => ({
          name: e.name,
          type: e.isDirectory() ? 'dir' : 'file',
          path: rel ? `${rel}/${e.name}` : e.name,
        }))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      return c.json(out);
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.get('/api/workspaces/:id/file', async c => {
    const id = c.req.param('id');
    const rel = c.req.query('path') ?? '';
    if (!rel) return c.json({ error: 'path required' }, 400);
    const ws = ctx.db.prepare('SELECT path FROM workspaces WHERE id = ?').get(id) as
      | { path: string }
      | undefined;
    if (!ws) return c.json({ error: 'workspace not found' }, 404);
    const resolved = await resolveWithinWorkspace(ws.path, rel);
    if (!resolved) return c.json({ error: 'path escapes workspace' }, 400);
    try {
      const info = await stat(resolved);
      if (!info.isFile()) return c.json({ error: 'not a file' }, 400);
      // Cap at 1 MiB; agents shouldn't be uploading 50MB blobs into the
      // transcript view, and we read the whole thing into memory.
      if (info.size > 1024 * 1024) return c.json({ error: 'file too large' }, 413);
      const content = await readFile(resolved, 'utf8');
      return c.json({ path: rel, size: info.size, content });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.get('/api/workspaces/:id/diff', async c => {
    const id = c.req.param('id');
    const rel = c.req.query('path') ?? '';
    if (!rel) return c.json({ error: 'path required' }, 400);
    const ws = ctx.db.prepare('SELECT path FROM workspaces WHERE id = ?').get(id) as
      | { path: string }
      | undefined;
    if (!ws) return c.json({ error: 'workspace not found' }, 404);
    const resolved = await resolveWithinWorkspace(ws.path, rel);
    if (!resolved) return c.json({ error: 'path escapes workspace' }, 400);
    // `resolved` is intentionally unused here — the validation that `rel`
    // stays inside the workspace is what we care about; git operates on
    // ws.path directly.
    void resolved;
    return c.json({ diff: computeFileDiff(ws.path, rel) });
  });

  // -------------------------------------------------------------------------
  // CLAUDE.md viewer / editor — workspace-level "agent notes" file.
  // AGENTS.md is symlinked to it on init, so editing one updates both.
  // -------------------------------------------------------------------------

  app.get('/api/workspaces/:id/claude_md', async c => {
    const id = c.req.param('id');
    const ws = ctx.db.prepare('SELECT path FROM workspaces WHERE id = ?').get(id) as
      | { path: string }
      | undefined;
    if (!ws) return c.json({ error: 'workspace not found' }, 404);
    const file = resolve(ws.path, 'CLAUDE.md');
    try {
      const content = await readFile(file, 'utf8');
      return c.json({ content });
    } catch {
      return c.json({ content: '' });
    }
  });

  app.put('/api/workspaces/:id/claude_md', async c => {
    const id = c.req.param('id');
    const ws = ctx.db.prepare('SELECT path FROM workspaces WHERE id = ?').get(id) as
      | { path: string }
      | undefined;
    if (!ws) return c.json({ error: 'workspace not found' }, 404);
    const body = await c.req.json<{ content: string }>();
    if (typeof body.content !== 'string') {
      return c.json({ error: 'content must be a string' }, 400);
    }
    const file = resolve(ws.path, 'CLAUDE.md');
    try {
      await writeFile(file, body.content, 'utf8');
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // Adopt a native session as a new Gian session. Body: {executor,
  // native_session_id, name?, approval_mode?}. Creates a Gian session row
  // bound to the native UUID, replays the on-disk JSONL into the events
  // table for transcript display, and lets the proxy resume from there.
  app.post('/api/workspaces/:id/native-sessions/adopt', async c => {
    const id = c.req.param('id');
    const ws = ctx.db.prepare('SELECT id, path FROM workspaces WHERE id = ?').get(id) as
      | { id: string; path: string }
      | undefined;
    if (!ws) return c.json({ error: 'workspace not found' }, 404);

    const body = await c.req.json<{
      executor?: 'claude' | 'codex';
      native_session_id?: string;
      name?: string;
      approval_mode?: 'plan' | 'ask' | 'auto';
    }>();
    const executor = body.executor;
    const nativeId = body.native_session_id;
    if (executor !== 'claude' && executor !== 'codex') {
      return c.json({ error: 'executor must be claude or codex' }, 400);
    }
    if (!nativeId) {
      return c.json({ error: 'native_session_id required' }, 400);
    }

    // Enforce 1:1: reject if this native session is already adopted.
    const existingBinding = ctx.db
      .prepare(
        `SELECT id, name FROM sessions
         WHERE executor = ? AND native_session_id = ?`,
      )
      .get(executor, nativeId) as { id: string; name: string | null } | undefined;
    if (existingBinding) {
      return c.json({
        error: `Already adopted as session ${existingBinding.name ?? existingBinding.id}`,
        gian_session_id: existingBinding.id,
      }, 409);
    }

    // Verify the native session actually exists by scanning.
    const { scanNativeSessions } = await import('../native/scanner.js');
    const candidates = await scanNativeSessions(ws.path);
    const native = candidates.find(s => s.executor === executor && s.id === nativeId);
    if (!native) {
      return c.json({ error: 'native session not found in this workspace' }, 404);
    }

    const sessionId = (await import('node:crypto')).randomUUID();
    const now = new Date().toISOString();
    const approvalMode = body.approval_mode ?? 'ask';
    const sessionName = body.name?.trim() || `adopted ${nativeId.slice(0, 8)}`;

    ctx.db
      .prepare(
        `INSERT INTO sessions
          (id, name, type, workspace_id, executor, model, approval_mode, turns,
           active_channel, status, archived,
           worktree_path, branch, base_branch, worktree_outcome,
           native_session_id,
           created_at, updated_at)
         VALUES
          (?, ?, 'coding', ?, ?, NULL, ?, 1,
           'web', 'new', 0,
           NULL, NULL, NULL, NULL,
           ?,
           ?, ?)`,
      )
      .run(sessionId, sessionName, ws.id, executor, approvalMode, nativeId, now, now);

    // Replay the native JSONL into Gian's events/turns tables so the
    // transcript renders immediately when the user opens this session.
    const { replayNativeJsonl } = await import('../native/replay.js');
    const replay = replayNativeJsonl(ctx.db, sessionId, native.filePath, executor);

    // Invalidate the scanner cache so the listing reflects the new binding.
    const { clearNativeSessionsCache } = await import('../native/scanner.js');
    clearNativeSessionsCache();

    const session = ctx.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);

    // Broadcast to all WS clients so the Coding view sidebar picks up the
    // newly adopted session immediately. Without this the user would have
    // to refresh to see it.
    if (session) {
      broadcaster.broadcast({
        type: 'session:created',
        session: session as import('@gian/shared').Session,
      });
    }

    return c.json({ session, replay });
  });

  // Delete a native session from disk. cc: rm the .jsonl file. codex: TODO
  // archive RPC (for now we also rm to keep symmetry; archive can be added
  // when codex-proxy exposes a method for it). Refuses if the session is
  // currently adopted as a Gian session.
  app.delete('/api/workspaces/:id/native-sessions/:nativeId', async c => {
    const id = c.req.param('id');
    const nativeId = c.req.param('nativeId');
    const executor = c.req.query('executor') as 'claude' | 'codex' | undefined;
    if (executor !== 'claude' && executor !== 'codex') {
      return c.json({ error: 'executor query param must be claude or codex' }, 400);
    }
    const ws = ctx.db.prepare('SELECT path FROM workspaces WHERE id = ?').get(id) as
      | { path: string }
      | undefined;
    if (!ws) return c.json({ error: 'workspace not found' }, 404);

    // Refuse to delete an adopted native session — user should unbind first.
    const adopted = ctx.db
      .prepare(
        `SELECT id, name FROM sessions
         WHERE executor = ? AND native_session_id = ?`,
      )
      .get(executor, nativeId) as { id: string; name: string | null } | undefined;
    if (adopted) {
      return c.json({
        error: `Native session is currently adopted as ${adopted.name ?? adopted.id}. Delete the Gian session first.`,
        gian_session_id: adopted.id,
      }, 409);
    }

    // Locate the file via the scanner so we don't have to rebuild the path
    // logic here — the scanner already knows where each executor stores
    // sessions and verifies the workspace path matches.
    const { scanNativeSessions, clearNativeSessionsCache } = await import('../native/scanner.js');
    const candidates = await scanNativeSessions(ws.path);
    const target = candidates.find(s => s.executor === executor && s.id === nativeId);
    if (!target) {
      return c.json({ error: 'native session not found in this workspace' }, 404);
    }

    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(target.filePath);
    } catch (err) {
      return c.json({ error: `Failed to delete: ${String(err)}` }, 500);
    }

    clearNativeSessionsCache();
    return c.json({ ok: true });
  });

  // List native sessions (claude / codex JSONL files on disk) that ran inside
  // this workspace's path. Cross-references the sessions table to mark which
  // ones are already adopted as Gian sessions.
  app.get('/api/workspaces/:id/native-sessions', async c => {
    const id = c.req.param('id');
    const ws = ctx.db.prepare('SELECT path FROM workspaces WHERE id = ?').get(id) as
      | { path: string }
      | undefined;
    if (!ws) return c.json({ error: 'workspace not found' }, 404);

    const { scanNativeSessions } = await import('../native/scanner.js');
    const sessions = await scanNativeSessions(ws.path);

    // Cross-reference: which native sessions are already adopted?
    const adoptedRows = ctx.db
      .prepare(
        `SELECT id AS gianSessionId, name AS gianSessionName, executor, native_session_id
           FROM sessions
          WHERE workspace_id = ? AND native_session_id IS NOT NULL`,
      )
      .all(id) as Array<{
        gianSessionId: string;
        gianSessionName: string | null;
        executor: 'claude' | 'codex';
        native_session_id: string;
      }>;

    const adoptedMap = new Map<string, { gianSessionId: string; gianSessionName: string | null }>();
    for (const r of adoptedRows) {
      adoptedMap.set(`${r.executor}:${r.native_session_id}`, {
        gianSessionId: r.gianSessionId,
        gianSessionName: r.gianSessionName,
      });
    }

    return c.json({
      sessions: sessions.map(s => {
        const adopted = adoptedMap.get(`${s.executor}:${s.id}`);
        return adopted ? { ...s, adoptedBy: adopted } : s;
      }),
    });
  });

  // -------------------------------------------------------------------------
  // File meta — git uncommitted status + today's edit count (M6)
  // -------------------------------------------------------------------------

  app.get('/api/workspaces/:id/file_meta', async c => {
    const id = c.req.param('id');
    const rel = c.req.query('path') ?? '';
    if (!rel) return c.json({ error: 'path required' }, 400);
    const ws = ctx.db.prepare('SELECT path FROM workspaces WHERE id = ?').get(id) as
      | { path: string }
      | undefined;
    if (!ws) return c.json({ error: 'workspace not found' }, 404);
    const resolved = await resolveWithinWorkspace(ws.path, rel);
    if (!resolved) return c.json({ error: 'path escapes workspace' }, 400);

    let uncommitted = false;
    try {
      const out = execFileSync('git', ['-C', ws.path, 'status', '--porcelain', '--', rel], {
        timeout: 5000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      uncommitted = out.trim().length > 0;
    } catch {
      // git not available or not a repo — leave false
    }

    // Approximate: counts file_change events whose JSON data contains the path
    // string. May over-count if the path appears in a different field, but is
    // good enough for the "today's edit count" indicator.
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayIso = todayStart.toISOString().slice(0, 19).replace('T', ' ');
    const row = ctx.db
      .prepare(
        `SELECT COUNT(*) as n FROM events WHERE type = 'file_change' AND data LIKE ? AND created_at >= ?`,
      )
      .get(`%"path":"${rel}"%`, todayIso) as { n: number };

    return c.json({ uncommitted, edit_count_today: row.n });
  });

  // -------------------------------------------------------------------------
  // Working trees — the right unit for "files I can see and edit right now".
  //
  // A working tree = one git working directory. A workspace's primary checkout
  // is a working tree (id `ws:<workspace_id>`); each session.worktree_path is
  // a linked worktree (id `wt:<session_id>`). All file/tree/diff/changed ops
  // operate on a working tree, not a workspace, because git status / git diff
  // / file listings only make sense at the level of a specific checkout.
  // -------------------------------------------------------------------------

  function gitBranchAt(path: string): string | null {
    try {
      const out = execFileSync('git', ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        timeout: 2000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return out || null;
    } catch { return null; }
  }

  /**
   * Detect "I'm in the middle of an operation" states that leave the index in
   * a half-baked spot — typically because a merge/rebase/cherry-pick hit
   * conflicts. We surface this in the UI so the user knows why their tools
   * are stuck instead of silently working on a poisoned tree.
   */
  function gitPendingOpAt(path: string):
    | { kind: 'merge'; mergeHead: string }
    | { kind: 'rebase' }
    | { kind: 'cherry-pick'; head: string }
    | { kind: 'revert'; head: string }
    | null {
    function tryRevParse(ref: string): string | null {
      try {
        const out = execFileSync('git', ['-C', path, 'rev-parse', '--verify', '--quiet', ref], {
          timeout: 2000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        return out || null;
      } catch { return null; }
    }
    const merge = tryRevParse('MERGE_HEAD');
    if (merge) return { kind: 'merge', mergeHead: merge };
    // `rebase-merge` (interactive / merge backend) and `rebase-apply` (am)
    // are directories under .git, not refs. Easiest probe is `git status
    // --porcelain=v2` header lines, but checking the filesystem is faster.
    try {
      const gitDir = execFileSync('git', ['-C', path, 'rev-parse', '--git-dir'], {
        timeout: 2000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (gitDir) {
        const dir = isAbsolute(gitDir) ? gitDir : resolve(path, gitDir);
        if (existsSync(resolve(dir, 'rebase-merge')) || existsSync(resolve(dir, 'rebase-apply'))) {
          return { kind: 'rebase' };
        }
      }
    } catch { /* swallow — non-rebase path falls through */ }
    const cherry = tryRevParse('CHERRY_PICK_HEAD');
    if (cherry) return { kind: 'cherry-pick', head: cherry };
    const revert = tryRevParse('REVERT_HEAD');
    if (revert) return { kind: 'revert', head: revert };
    return null;
  }

  function gitInfoAt(path: string): {
    isRepo: boolean;
    remote: string | null;
    defaultBranch: string | null;
    currentBranch: string | null;
    lastCommit: { hash: string; message: string; age: string } | null;
    modifiedCount: number;
    pendingOp: ReturnType<typeof gitPendingOpAt>;
  } {
    function safe(args: string[]): string | null {
      try {
        return execFileSync('git', ['-C', path, ...args], {
          timeout: 2000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch { return null; }
    }
    const inside = safe(['rev-parse', '--is-inside-work-tree']);
    if (inside !== 'true') {
      return {
        isRepo: false, remote: null, defaultBranch: null,
        currentBranch: null, lastCommit: null, modifiedCount: 0, pendingOp: null,
      };
    }
    const remote = safe(['remote', 'get-url', 'origin']);
    let remoteHuman: string | null = null;
    if (remote) {
      // git@github.com:user/repo.git → github.com/user/repo
      // https://github.com/user/repo.git → github.com/user/repo
      remoteHuman = remote
        .replace(/^git@([^:]+):/, '$1/')
        .replace(/^https?:\/\//, '')
        .replace(/\.git$/, '');
    }
    const defaultBranchRaw = safe(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    const defaultBranch = defaultBranchRaw ? defaultBranchRaw.replace(/^origin\//, '') : null;
    const currentBranch = gitBranchAt(path);
    const last = safe(['log', '-1', '--format=%h\x1f%s\x1f%cr']);
    let lastCommit: { hash: string; message: string; age: string } | null = null;
    if (last) {
      const [hash, message, age] = last.split('\x1f');
      if (hash && message && age) lastCommit = { hash, message, age };
    }
    const status = safe(['status', '--porcelain']);
    const modifiedCount = status ? status.split('\n').filter(l => l.trim()).length : 0;
    const pendingOp = gitPendingOpAt(path);
    return { isRepo: true, remote: remoteHuman, defaultBranch, currentBranch, lastCommit, modifiedCount, pendingOp };
  }

  function claudeMdInfoAt(path: string): { exists: boolean; lines: number; mtime: string | null } {
    try {
      const file = resolve(path, 'CLAUDE.md');
      const content = readFileSync(file, 'utf8');
      const stat = statSync(file);
      return { exists: true, lines: content.split('\n').length, mtime: stat.mtime.toISOString() };
    } catch {
      return { exists: false, lines: 0, mtime: null };
    }
  }

  app.get('/api/workspaces/:id/repo-info', c => {
    const id = c.req.param('id');
    const ws = ctx.db.prepare('SELECT path FROM workspaces WHERE id = ?').get(id) as
      | { path: string } | undefined;
    if (!ws) return c.json({ error: 'workspace not found' }, 404);
    return c.json({
      git: gitInfoAt(ws.path),
      claudeMd: claudeMdInfoAt(ws.path),
    });
  });

  app.get('/api/workspaces/:id/trees', c => {
    const id = c.req.param('id');
    const ws = ctx.db.prepare('SELECT id, name, path, created_at FROM workspaces WHERE id = ?').get(id) as
      | { id: string; name: string; path: string; created_at: string } | undefined;
    if (!ws) return c.json({ error: 'workspace not found' }, 404);

    const sessRows = ctx.db.prepare(`
      SELECT id, name, worktree_path, branch
      FROM sessions
      WHERE workspace_id = ? AND worktree_path IS NOT NULL AND archived = 0
      ORDER BY updated_at DESC
    `).all(id) as Array<{ id: string; name: string | null; worktree_path: string; branch: string | null }>;

    function dirty(path: string): { isDirty: boolean; modifiedCount: number } {
      try {
        const out = execFileSync('git', ['-C', path, 'status', '--porcelain'], {
          timeout: 2000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        });
        const lines = out.split('\n').filter(l => l.trim());
        return { isDirty: lines.length > 0, modifiedCount: lines.length };
      } catch {
        return { isDirty: false, modifiedCount: 0 };
      }
    }

    const out: Array<{
      id: string;
      kind: 'main' | 'worktree';
      label: string;
      path: string;
      branch: string | null;
      isDirty: boolean;
      modifiedCount: number;
      claudeMd: { exists: boolean; lines: number; mtime: string | null };
      session?: { id: string; name: string | null };
    }> = [];

    out.push({
      id: `ws:${ws.id}`,
      kind: 'main',
      label: ws.name,
      path: ws.path,
      branch: gitBranchAt(ws.path),
      ...dirty(ws.path),
      claudeMd: claudeMdInfoAt(ws.path),
    });
    for (const s of sessRows) {
      out.push({
        id: `wt:${s.id}`,
        kind: 'worktree',
        label: s.name || `session ${s.id.slice(0, 6)}`,
        path: s.worktree_path,
        branch: s.branch ?? gitBranchAt(s.worktree_path),
        ...dirty(s.worktree_path),
        claudeMd: claudeMdInfoAt(s.worktree_path),
        session: { id: s.id, name: s.name },
      });
    }
    return c.json(out);
  });

  // ── Branches / remote-branches / fetch ─────────────────────────────────────
  // Powering the workspace-level Git panel (IDE-style branch management).
  // All three endpoints are thin wrappers around `git for-each-ref` and
  // `git fetch`. The sessions table is joined in `listLocalBranches` purely
  // for "which Gian session's worktree has this branch checked out" linkage.

  interface LocalBranchOut {
    name: string;
    upstream: string | null;
    ahead: number;
    behind: number;
    gone: boolean;
    lastCommit: { hash: string; subject: string; age: string } | null;
    worktreePath: string | null;
    /** True when the branch was auto-created by a Gian session worktree.
     *  Matches both the new `worktree/*` prefix and the legacy `gian/*`
     *  prefix used in older versions, so historical branches still flag
     *  correctly in the Git panel filter. */
    isWorktreeBranch: boolean;
    session: { id: string; name: string | null } | null;
  }

  app.get('/api/workspaces/:id/branches', c => {
    const id = c.req.param('id');
    const ws = ctx.db.prepare('SELECT path FROM workspaces WHERE id = ?').get(id) as
      | { path: string } | undefined;
    if (!ws) return c.json({ error: 'workspace not found' }, 404);
    const branches: LocalBranchOut[] = listLocalBranches(ws.path).map(b => ({ ...b, session: null }));
    const sessRows = ctx.db.prepare(`
      SELECT id, name, branch FROM sessions
      WHERE workspace_id = ? AND branch IS NOT NULL AND archived = 0
    `).all(id) as Array<{ id: string; name: string | null; branch: string }>;
    const byBranch = new Map(sessRows.map(s => [s.branch, { id: s.id, name: s.name }]));
    for (const b of branches) {
      const s = byBranch.get(b.name);
      if (s) b.session = s;
    }
    return c.json(branches);
  });

  app.get('/api/workspaces/:id/remote-branches', c => {
    const id = c.req.param('id');
    const search = (c.req.query('search') ?? '').trim().toLowerCase();
    const ws = ctx.db.prepare('SELECT path FROM workspaces WHERE id = ?').get(id) as
      | { path: string } | undefined;
    if (!ws) return c.json({ error: 'workspace not found' }, 404);
    let raw: string;
    try {
      raw = execFileSync(
        'git',
        ['-C', ws.path, 'for-each-ref', '--format=' + REMOTE_BRANCHES_FOR_EACH_REF_FMT, 'refs/remotes'],
        { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
    } catch {
      return c.json([]);
    }
    const localNames = new Set(listLocalBranches(ws.path).map(b => b.name));
    const out = buildRemoteBranchList({ rawForEachRef: raw, localBranchNames: localNames, search });
    return c.json(out);
  });

  app.post('/api/workspaces/:id/branches', async c => {
    const id = c.req.param('id');
    const ws = ctx.db.prepare('SELECT path FROM workspaces WHERE id = ?').get(id) as
      | { path: string } | undefined;
    if (!ws) return c.json({ error: 'workspace not found' }, 404);
    const body = await c.req.json<{ name?: string; base?: string }>().catch(() => ({} as { name?: string; base?: string }));
    const name = (body.name ?? '').trim();
    const base = (body.base ?? '').trim();
    if (!name) return c.json({ error: 'name is required' }, 400);
    // `git check-ref-format --branch <name>` validates the proposed branch
    // name without creating anything. Cheaper than letting `git branch` blow
    // up with a vague error.
    try {
      execFileSync('git', ['-C', ws.path, 'check-ref-format', '--branch', name], {
        timeout: 2000, stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch {
      return c.json({ error: `invalid branch name: ${name}` }, 400);
    }
    // When base is a remote-tracking ref (origin/foo), --track makes the new
    // local branch follow it for ahead/behind. Probe with rev-parse against
    // refs/remotes/<base> — `feature/x` happens to look like `origin/foo` by
    // shape, so a regex isn't enough.
    let isRemote = false;
    if (base) {
      try {
        execFileSync('git', ['-C', ws.path, 'rev-parse', '--verify', '--quiet', `refs/remotes/${base}`], {
          timeout: 2000, stdio: ['ignore', 'ignore', 'ignore'],
        });
        isRemote = true;
      } catch {
        isRemote = false;
      }
    }
    const args = ['-C', ws.path, 'branch'];
    if (isRemote) args.push('--track');
    args.push(name);
    if (base) args.push(base);
    try {
      execFileSync('git', args, {
        timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const e = err as { stderr?: Buffer | string; message?: string };
      const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf8') ?? '';
      return c.json({ ok: false, error: stderr.trim() || e.message || 'branch create failed' }, 400);
    }
    broadcaster.broadcast({ type: 'workspace:git-updated', workspace_id: id, reason: 'branch-created' });
    return c.json({ ok: true });
  });

  app.post('/api/workspaces/:id/abort-merge', c => {
    const id = c.req.param('id');
    const ws = ctx.db.prepare('SELECT path FROM workspaces WHERE id = ?').get(id) as
      | { path: string } | undefined;
    if (!ws) return c.json({ error: 'workspace not found' }, 404);
    const pending = gitPendingOpAt(ws.path);
    if (!pending) return c.json({ ok: false, error: 'no merge in progress' }, 400);
    // `git <op> --abort` is the canonical way to back out each state. The
    // command matches the pending op kind we detected.
    const args: Record<typeof pending.kind, string[]> = {
      'merge':       ['merge', '--abort'],
      'rebase':      ['rebase', '--abort'],
      'cherry-pick': ['cherry-pick', '--abort'],
      'revert':      ['revert', '--abort'],
    };
    try {
      execFileSync('git', ['-C', ws.path, ...args[pending.kind]], {
        timeout: 10_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const e = err as { stderr?: Buffer | string; message?: string };
      const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf8') ?? '';
      return c.json({ ok: false, error: stderr.trim() || e.message || 'abort failed' }, 500);
    }
    broadcaster.broadcast({ type: 'workspace:git-updated', workspace_id: id, reason: 'merge' });
    return c.json({ ok: true });
  });

  app.post('/api/workspaces/:id/fetch', c => {
    const id = c.req.param('id');
    const ws = ctx.db.prepare('SELECT path FROM workspaces WHERE id = ?').get(id) as
      | { path: string } | undefined;
    if (!ws) return c.json({ error: 'workspace not found' }, 404);
    try {
      execFileSync('git', ['-C', ws.path, 'fetch', '--prune', '--all'], {
        timeout: 60_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const e = err as { stderr?: Buffer | string; message?: string };
      const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf8') ?? '';
      return c.json({ ok: false, error: stderr || e.message || 'fetch failed' }, 500);
    }
    broadcaster.broadcast({ type: 'workspace:git-updated', workspace_id: id, reason: 'fetch' });
    return c.json({ ok: true, fetchedAt: new Date().toISOString() });
  });

  function resolveWorkingTree(id: string): { path: string; workspace_id: string; session_id: string | null } | null {
    if (id.startsWith('ws:')) {
      const wsId = id.slice(3);
      const ws = ctx.db.prepare('SELECT id, path FROM workspaces WHERE id = ?').get(wsId) as
        | { id: string; path: string } | undefined;
      if (!ws) return null;
      return { path: ws.path, workspace_id: ws.id, session_id: null };
    }
    if (id.startsWith('wt:')) {
      const sid = id.slice(3);
      const s = ctx.db.prepare('SELECT id, workspace_id, worktree_path FROM sessions WHERE id = ?').get(sid) as
        | { id: string; workspace_id: string; worktree_path: string | null } | undefined;
      if (!s || !s.worktree_path) return null;
      return { path: s.worktree_path, workspace_id: s.workspace_id, session_id: s.id };
    }
    return null;
  }

  // Per-file diff aligned with what Files Changed surfaces: includes both
  // staged and unstaged edits on tracked files (via `diff HEAD`), and
  // synthesizes a new-file diff for untracked paths (via `diff --no-index`
  // against /dev/null). Bare `git diff -- <path>` would miss anything
  // already `git add`-ed and every untracked file.
  function computeFileDiff(cwd: string, rel: string): string {
    try {
      const out = execFileSync('git', ['-C', cwd, 'diff', 'HEAD', '--', rel], {
        timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (out) return out;
    } catch {
      // Not a repo, or some other git failure — nothing more we can do.
      return '';
    }
    // Empty result so far means either tracked-but-clean or untracked. Probe
    // tracked-ness; only fall through to --no-index for untracked.
    try {
      execFileSync('git', ['-C', cwd, 'ls-files', '--error-unmatch', '--', rel], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      return '';
    } catch {
      // Untracked: synthesize a "new file" diff. `--no-index` exits 1 when
      // the two paths differ, so stdout is on the thrown error object.
      try {
        execFileSync('git', ['-C', cwd, 'diff', '--no-index', '--', '/dev/null', rel], {
          timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        });
        return '';
      } catch (err) {
        const e = err as { stdout?: Buffer | string; status?: number };
        if (e.status === 1 && e.stdout != null) {
          return typeof e.stdout === 'string' ? e.stdout : e.stdout.toString('utf8');
        }
        return '';
      }
    }
  }

  app.get('/api/working_trees', c => {
    const wsRows = ctx.db.prepare('SELECT id, name, path FROM workspaces ORDER BY sort_order ASC').all() as
      Array<{ id: string; name: string; path: string }>;
    const sessRows = ctx.db.prepare(`
      SELECT id, name, workspace_id, worktree_path, branch
      FROM sessions
      WHERE worktree_path IS NOT NULL AND archived = 0
      ORDER BY updated_at DESC
    `).all() as Array<{ id: string; name: string | null; workspace_id: string; worktree_path: string; branch: string | null }>;

    const out: Array<{
      id: string;
      kind: 'workspace' | 'worktree';
      label: string;
      path: string;
      branch: string | null;
      workspace_id: string;
      workspace_name: string;
      session_id: string | null;
      session_name: string | null;
    }> = [];

    for (const ws of wsRows) {
      out.push({
        id: `ws:${ws.id}`,
        kind: 'workspace',
        label: ws.name,
        path: ws.path,
        branch: gitBranchAt(ws.path),
        workspace_id: ws.id,
        workspace_name: ws.name,
        session_id: null,
        session_name: null,
      });
    }
    for (const s of sessRows) {
      const ws = wsRows.find(w => w.id === s.workspace_id);
      out.push({
        id: `wt:${s.id}`,
        kind: 'worktree',
        label: s.name || `session ${s.id.slice(0, 6)}`,
        path: s.worktree_path,
        branch: s.branch ?? gitBranchAt(s.worktree_path),
        workspace_id: s.workspace_id,
        workspace_name: ws?.name ?? '',
        session_id: s.id,
        session_name: s.name,
      });
    }
    return c.json(out);
  });

  app.get('/api/working_trees/:id/tree', async c => {
    const id = c.req.param('id');
    const rel = c.req.query('path') ?? '';
    const wt = resolveWorkingTree(id);
    if (!wt) return c.json({ error: 'working tree not found' }, 404);
    const resolved = await resolveWithinWorkspace(wt.path, rel);
    if (!resolved) return c.json({ error: 'path escapes working tree' }, 400);
    try {
      const entries = await readdir(resolved, { withFileTypes: true });
      const out = entries
        .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
        .map(e => ({
          name: e.name,
          type: e.isDirectory() ? 'dir' : 'file',
          path: rel ? `${rel}/${e.name}` : e.name,
        }))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      return c.json(out);
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.get('/api/working_trees/:id/file', async c => {
    const id = c.req.param('id');
    const rel = c.req.query('path') ?? '';
    if (!rel) return c.json({ error: 'path required' }, 400);
    const wt = resolveWorkingTree(id);
    if (!wt) return c.json({ error: 'working tree not found' }, 404);
    const resolved = await resolveWithinWorkspace(wt.path, rel);
    if (!resolved) return c.json({ error: 'path escapes working tree' }, 400);
    try {
      const info = await stat(resolved);
      if (!info.isFile()) return c.json({ error: 'not a file' }, 400);
      if (info.size > 1024 * 1024) return c.json({ error: 'file too large' }, 413);
      const content = await readFile(resolved, 'utf8');
      return c.json({ path: rel, size: info.size, content });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // Serve a file's raw bytes with a real Content-Type so the browser can
  // render html / display pdf / show images directly. Used by the Files
  // view's "Open in new tab" for previewable types. Path-traversal check
  // mirrors /file. Security headers mirror remote-vibe-coding's preview
  // endpoint: Content-Disposition:inline, X-Frame-Options:DENY, strict
  // CSP for html/svg so a user-authored html file can't pivot into the
  // host origin.
  app.get('/api/working_trees/:id/raw', async c => {
    const id = c.req.param('id');
    const rel = c.req.query('path') ?? '';
    if (!rel) return c.json({ error: 'path required' }, 400);
    const wt = resolveWorkingTree(id);
    if (!wt) return c.json({ error: 'working tree not found' }, 404);
    const resolved = await resolveWithinWorkspace(wt.path, rel);
    if (!resolved) return c.json({ error: 'path escapes working tree' }, 400);
    try {
      const info = await stat(resolved);
      if (!info.isFile()) return c.json({ error: 'not a file' }, 400);
      if (rawPreviewOversize(info.size)) return c.json({ error: 'file too large' }, 413);
      const { headers } = buildRawPreviewHeaders({ rel, size: info.size });
      const bytes = await readFile(resolved);
      return new Response(new Uint8Array(bytes), { status: 200, headers });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.get('/api/working_trees/:id/diff', async c => {
    const id = c.req.param('id');
    const rel = c.req.query('path') ?? '';
    if (!rel) return c.json({ error: 'path required' }, 400);
    const wt = resolveWorkingTree(id);
    if (!wt) return c.json({ error: 'working tree not found' }, 404);
    const resolved = await resolveWithinWorkspace(wt.path, rel);
    if (!resolved) return c.json({ error: 'path escapes working tree' }, 400);
    void resolved;
    return c.json({ diff: computeFileDiff(wt.path, rel) });
  });

  app.get('/api/working_trees/:id/file_meta', async c => {
    const id = c.req.param('id');
    const rel = c.req.query('path') ?? '';
    if (!rel) return c.json({ error: 'path required' }, 400);
    const wt = resolveWorkingTree(id);
    if (!wt) return c.json({ error: 'working tree not found' }, 404);
    const resolved = await resolveWithinWorkspace(wt.path, rel);
    if (!resolved) return c.json({ error: 'path escapes working tree' }, 400);

    let uncommitted = false;
    try {
      const out = execFileSync('git', ['-C', wt.path, 'status', '--porcelain', '--', rel], {
        timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
      uncommitted = out.trim().length > 0;
    } catch {
      // no git or not a repo
    }

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayIso = todayStart.toISOString().slice(0, 19).replace('T', ' ');
    const row = ctx.db
      .prepare(
        `SELECT COUNT(*) as n FROM events WHERE type = 'file_change' AND data LIKE ? AND created_at >= ?`,
      )
      .get(`%"path":"${rel}"%`, todayIso) as { n: number };

    return c.json({ uncommitted, edit_count_today: row.n });
  });

  // git status --porcelain -z, parsed into the same shape Files Changed expects.
  // X (index) / Y (worktree) two-letter codes mapped to a single kind.
  app.get('/api/working_trees/:id/changed', c => {
    const id = c.req.param('id');
    const wt = resolveWorkingTree(id);
    if (!wt) return c.json({ error: 'working tree not found' }, 404);

    let raw = '';
    try {
      raw = execFileSync('git', ['-C', wt.path, 'status', '--porcelain=1', '-z'], {
        timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return c.json([]);
    }

    // -z output: each entry is `XY <space> <path>\0`. Renames (R/C) are
    // followed by an extra `<oldpath>\0` record we discard.
    const out: Array<{ path: string; kind: 'create' | 'update' | 'delete' | 'rename'; staged: boolean; added: number; removed: number }> = [];
    const records = raw.split('\0');
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (!rec || rec.length < 3) continue;
      const x = rec[0]!;
      const y = rec[1]!;
      const path = rec.slice(3);
      const isRename = x === 'R' || y === 'R' || x === 'C' || y === 'C';
      if (isRename) i += 1; // skip the old-name record that follows
      const code = (x !== ' ' && x !== '?' ? x : y);
      let kind: 'create' | 'update' | 'delete' | 'rename';
      if (isRename) kind = 'rename';
      else if (code === 'A' || code === '?') kind = 'create';
      else if (code === 'D') kind = 'delete';
      else kind = 'update';
      const staged = x !== ' ' && x !== '?';
      out.push({ path, kind, staged, added: 0, removed: 0 });
    }

    // Per-file added/removed line counts via `git diff --numstat HEAD`.
    // Cheap enough for a typical working tree; bail silently on error.
    try {
      const numstat = execFileSync('git', ['-C', wt.path, 'diff', '--numstat', 'HEAD'], {
        timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
      const stats = new Map<string, { added: number; removed: number }>();
      for (const line of numstat.split('\n')) {
        if (!line) continue;
        const [a, r, p] = line.split('\t');
        if (!p) continue;
        stats.set(p, {
          added: a === '-' ? 0 : Number(a) || 0,
          removed: r === '-' ? 0 : Number(r) || 0,
        });
      }
      for (const e of out) {
        const s = stats.get(e.path);
        if (s) { e.added = s.added; e.removed = s.removed; }
      }
    } catch {
      // numstat optional
    }

    // Untracked files (`??`) don't appear in `git diff --numstat HEAD`. Count
    // their lines from disk so they contribute to +N totals. Skip files larger
    // than 1 MiB or with a null byte in the first 8 KiB (binary).
    for (const e of out) {
      if (e.kind !== 'create' || e.staged || e.added !== 0) continue;
      try {
        const filePath = resolve(wt.path, e.path);
        const st = statSync(filePath);
        if (!st.isFile() || st.size > 1024 * 1024) continue;
        const buf = readFileSync(filePath);
        const probe = buf.subarray(0, Math.min(buf.length, 8192));
        if (probe.includes(0)) continue;
        let lines = 0;
        for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) lines++;
        // Count a trailing-newline-less last line as a line too.
        if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) lines++;
        e.added = lines;
      } catch {
        // file vanished or unreadable — leave at 0
      }
    }

    return c.json(out);
  });

  // Reveal a working tree (main tree or worktree) in macOS Finder.
  // :id accepts `ws:<workspace-id>` or `wt:<session-id>`, same shape used by
  // the rest of the /api/working_trees/:id endpoints.
  app.post('/api/working_trees/:id/reveal', c => {
    const id = c.req.param('id');
    const wt = resolveWorkingTree(id);
    if (!wt) return c.json({ error: 'working tree not found' }, 404);
    try {
      execFileSync('open', [wt.path], { timeout: 5000, stdio: 'ignore' });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // Open a file via the system default opener or a configured external
  // editor. Path resolution mirrors /raw and /reveal — id must be a known
  // ws:/wt: handle and the relative path is bounded to the working tree.
  app.post('/api/working_trees/:id/open', async c => {
    const id = c.req.param('id');
    const wt = resolveWorkingTree(id);
    if (!wt) return c.json({ error: 'working tree not found' }, 404);

    let body: { path?: string; editor_id?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid json body' }, 400);
    }
    if (!body.path || typeof body.path !== 'string') {
      return c.json({ error: 'path required' }, 400);
    }

    const absPath = await resolveWithinWorkspace(wt.path, body.path);
    if (!absPath) {
      return c.json({ error: 'path escapes working tree' }, 400);
    }

    try {
      statSync(absPath);
    } catch {
      return c.json({ error: 'file not found' }, 404);
    }

    let cmd: OpenCommand;
    if (body.editor_id) {
      const cfg = loadConfig(ctx.db);
      const editor = cfg.external_editors.find(e => e.id === body.editor_id);
      if (!editor) return c.json({ error: 'editor not found' }, 404);
      cmd = buildEditorArgs(editor, absPath);
    } else {
      try {
        cmd = defaultOpenerArgs(process.platform, absPath);
      } catch (err) {
        return c.json({ error: String((err as Error).message) }, 500);
      }
    }

    return new Promise<Response>(resolve => {
      const timer = setTimeout(
        () => resolve(c.json({ ok: true }) as unknown as Response),
        50,
      );
      runOpen(cmd, err => {
        clearTimeout(timer);
        resolve(c.json({ error: String(err.message) }, 500) as unknown as Response);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Reconnect endpoints — force-restart proxy / IM adapters (M6)
  // -------------------------------------------------------------------------

  app.post('/api/reconnect/:component', async c => {
    const component = c.req.param('component');
    if (component === 'codex') {
      await proxy.closeByExecutor('codex');
      return c.json({ ok: true });
    }
    if (component === 'claude') {
      await proxy.closeByExecutor('claude');
      return c.json({ ok: true });
    }
    if (component === 'discord' || component === 'slack') {
      const mgr = platforms.find(p => p.platformId === component);
      if (!mgr) return c.json({ error: `no ${component} platform registered` }, 500);
      const bots = await imListBots(ctx.db);
      const enabled = bots.filter(b => b.platform === component && b.enabled === 1);
      const errors: string[] = [];
      for (const bot of enabled) {
        try {
          await mgr.stopBot(bot.id);
          await mgr.syncBot(bot.id);
        } catch (err) {
          errors.push(`${bot.label}: ${String(err)}`);
        }
      }
      if (errors.length > 0) return c.json({ ok: false, error: errors.join('; ') }, 500);
      return c.json({ ok: true });
    }
    return c.json({ error: 'unknown component' }, 400);
  });

  // -------------------------------------------------------------------------
  // Bot REST endpoints (M3-C)
  // -------------------------------------------------------------------------

  // Bot REST endpoints — wire format unchanged (Bot / BotExtra) so the web
  // UI doesn't need to know that storage moved to per-platform tables. The
  // im/bots-api translation layer handles encryption + column splitting.
  app.get('/api/bots', async c => c.json(await imListBots(ctx.db)));

  app.post('/api/bots', async c => {
    const body = await c.req.json<{
      label?: string;
      platform?: IMPlatform;
      workspace_id?: string | null;
      mode?: BotMode;             // accepted for back-compat, ignored — rvc dropped per-bot mode
      allowed_user_id?: string | null;
      extra?: BotExtra;
    }>();
    if (!body.label || !body.platform) {
      return c.json({ error: 'label and platform required' }, 400);
    }
    if (body.platform !== 'discord' && body.platform !== 'slack') {
      return c.json({ error: 'platform must be discord or slack' }, 400);
    }
    if (!body.extra) {
      return c.json({ error: 'extra (token / channel) required' }, 400);
    }
    try {
      const bot = await imCreateBot(ctx.db, {
        label: body.label,
        platform: body.platform,
        workspace_id: body.workspace_id ?? null,
        allowed_user_id: body.allowed_user_id ?? null,
        extra: body.extra,
      });
      return c.json(bot, 201);
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  app.patch('/api/bots/:id', async c => {
    const id = c.req.param('id');
    const existing = await imGetBot(ctx.db, id);
    if (!existing) return c.json({ error: 'bot not found' }, 404);
    const body = await c.req.json<{
      label?: string;
      workspace_id?: string | null;
      mode?: BotMode;             // accepted but ignored — see POST
      allowed_user_id?: string | null;
      extra?: BotExtra;
    }>();
    const updated = await imUpdateBot(ctx.db, id, {
      ...(body.label !== undefined ? { label: body.label } : {}),
      ...('workspace_id' in body ? { workspace_id: body.workspace_id ?? null } : {}),
      ...('allowed_user_id' in body ? { allowed_user_id: body.allowed_user_id ?? null } : {}),
      ...(body.extra !== undefined ? { extra: body.extra } : {}),
    });
    return c.json(updated);
  });

  app.delete('/api/bots/:id', async c => {
    const id = c.req.param('id');
    const existing = await imGetBot(ctx.db, id);
    if (!existing) return c.json({ error: 'bot not found' }, 404);
    if (existing.enabled === 1) {
      // Stop the bot via its platform manager before tearing down the row.
      const mgr = platforms.find(p => p.platformId === existing.platform);
      if (mgr) {
        try { await mgr.stopBot(id); } catch (err) {
          console.warn(`[im] stopBot failed during delete: ${String(err)}`);
        }
      }
    }
    const ok = imDeleteBot(ctx.db, id, existing.platform);
    return c.json({ ok });
  });

  app.post('/api/bots/:id/toggle', async c => {
    const id = c.req.param('id');
    const existing = await imGetBot(ctx.db, id);
    if (!existing) return c.json({ error: 'bot not found' }, 404);
    const wantEnabled = existing.enabled !== 1;
    await imSetBotEnabled(ctx.db, id, wantEnabled);
    const mgr = platforms.find(p => p.platformId === existing.platform);
    if (mgr) {
      try {
        await mgr.syncBot(id);
      } catch (err) {
        // Manager flips status to error itself; we still return the row.
        console.warn(`[im] syncBot failed: ${String(err)}`);
      }
    }
    return c.json(await imGetBot(ctx.db, id));
  });

  app.get(
    '/ws',
    upgradeWebSocket(() => ({
      onOpen: handlers.onOpen,
      onClose: handlers.onClose,
      onMessage: handlers.onMessage,
      onError(err) {
        console.error('[ws] error', err);
      },
    })),
  );

  return {
    app,
    injectWebSocket,
    shutdown: async () => {
      watcher.stopAll();
      await term.closeAll();
      await Promise.all(platforms.map(p => p.shutdown().catch(err => {
        console.error(`[im] ${p.platformId} shutdown failed`, err);
      })));
      await proxy.closeAll();
    },
  };
}

/**
 * On host boot, walk every non-archived session and attach a JSONL watcher
 * if its native_session_id resolves to an on-disk file. Sessions whose
 * file isn't found are silently skipped — the watcher will start lazily
 * the next time bringUpProxySession runs for them.
 */
function bootJsonlWatchers(db: Db, watcher: NativeJsonlWatcher): void {
  const rows = db
    .prepare(
      `SELECT s.id, s.executor, s.native_session_id, s.worktree_path, w.path AS workspace_path
         FROM sessions s
         JOIN workspaces w ON w.id = s.workspace_id
        WHERE s.archived = 0
          AND s.native_session_id IS NOT NULL
          AND s.worktree_outcome IS NULL`,
    )
    .all() as Array<{
      id: string;
      executor: 'claude' | 'codex';
      native_session_id: string;
      worktree_path: string | null;
      workspace_path: string;
    }>;

  for (const row of rows) {
    const cwd = row.worktree_path ?? row.workspace_path;
    const filePath = locateNativeJsonl(row.executor, row.native_session_id, cwd);
    if (filePath) watcher.start(row.id, filePath, row.executor);
  }
}

/**
 * Fan a SessionManager UnifiedEvent out to every registered IM platform.
 * Currently routes:
 *   - turn_completed     → sendTurnCompletion
 *   - approval_requested → sendApprovalRequested (looks up the
 *                          ApprovalRecord from ApprovalManager so the
 *                          manager can format risk/title/payload)
 *   - session_error      → sendSessionError
 *
 * Other event types (assistant_text deltas, file_change, etc.) are
 * intentionally not relayed — IM only cares about turn boundaries.
 */
async function fanIMEvent(
  e: import('@gian/shared').UnifiedEvent,
  sessions: SessionManager,
  approvals: ApprovalManager,
  platforms: MessagingPlatform[],
): Promise<void> {
  const session = (() => {
    try { return sessions.getSession(e.session_id); } catch { return null; }
  })();
  if (!session) return;
  const rvcSession = gianSessionToRvcRecord(session);

  if (e.type === 'turn_completed') {
    const data = e.data as { turnId?: string; summary?: string };
    const turnId = data.turnId ?? e.call_id;
    // The manager expects a `CodexThread` so it can pull assistantText out of
    // a `type: 'agentMessage'` item. Gian doesn't model codex threads — we
    // synthesize the minimum shape from `data.summary`. If summary is missing
    // we still pass the thread so the manager can take the empty-text branch.
    const thread: import('../im/types.js').CodexThread = {
      id: session.native_session_id ?? session.id,
      preview: '',
      cwd: '',
      name: session.name ?? null,
      status: 'completed',
      updatedAt: Date.now(),
      turns: [{
        id: turnId,
        status: 'completed',
        error: null,
        items: data.summary
          ? [{ type: 'agentMessage' as const, id: turnId, text: data.summary, phase: null }]
          : [],
      }],
    };
    await Promise.all(platforms.map(p =>
      p.sendTurnCompletion(rvcSession, thread, turnId).catch(err => {
        console.error(`[im] ${p.platformId} sendTurnCompletion failed`, err);
      }),
    ));
    return;
  }

  if (e.type === 'approval_requested') {
    const data = e.data as { approvalId?: string };
    const approvalId = typeof data.approvalId === 'string' ? data.approvalId : '';
    if (!approvalId) return;
    const record = approvals.getPending(approvalId);
    if (!record) return;
    const pending = gianApprovalToRvcPending(record, session.executor);
    await Promise.all(platforms.map(p =>
      p.sendApprovalRequested(rvcSession, pending).catch(err => {
        console.error(`[im] ${p.platformId} sendApprovalRequested failed`, err);
      }),
    ));
    return;
  }

  if (e.type === 'session_error') {
    const data = e.data as { message?: string };
    const message = typeof data.message === 'string' ? data.message : 'Session error';
    await Promise.all(platforms.map(p =>
      p.sendSessionError(rvcSession, message).catch(err => {
        console.error(`[im] ${p.platformId} sendSessionError failed`, err);
      }),
    ));
    return;
  }
}

function ensurePasswordHash(db: Db): void {
  const envUsername = process.env['GIAN_AUTH_USERNAME'];
  const envPassword = process.env['GIAN_AUTH_PASSWORD'];

  if (envUsername) {
    saveConfig(db, { auth_username: envUsername });
  }

  if (envPassword) {
    void hashPassword(envPassword).then(h => savePasswordHash(db, h));
    return;
  }

  const existing = loadPasswordHash(db);
  if (existing) return;

  const plain = randomBytes(12).toString('base64url');
  void hashPassword(plain).then(h => {
    savePasswordHash(db, h);
    console.log(`[gian] initial password: ${plain}`);
  });
}

/**
 * Locate the bundled web/dist directory for production (daemon) mode. The
 * resolver checks, in order:
 *   1. GIAN_WEB_DIST env var (absolute path), used by ops to relocate.
 *   2. ../../../web/dist relative to this file — works when running the
 *      built host (`packages/host/dist/web/app.js`) inside the monorepo.
 *   3. ../../web/dist relative to this file — works when running from src/
 *      via tsx in dev (rare, but harmless to support).
 * Returns null if no dist dir is found; the caller skips static serving.
 */
function resolveWebDistDir(): string | null {
  const override = process.env['GIAN_WEB_DIST'];
  if (override) return override;
  const here = fileURLToPath(new URL('.', import.meta.url));
  const candidates = [
    resolve(here, '../../../web/dist'),
    resolve(here, '../../web/dist'),
  ];
  for (const dir of candidates) {
    if (existsSync(resolve(dir, 'index.html'))) return dir;
  }
  return null;
}

/**
 * Tiny static-file middleware that serves `rootDir` for non-API GET requests.
 * Skips /api/* and /ws so route handlers below get a chance to match. For
 * any URL that maps to no file, falls back to rootDir/index.html so the SPA
 * router can take over (client-side routes like /coding, /files).
 *
 * Doesn't use @hono/node-server/serve-static because that helper resolves
 * its `root` relative to process cwd, which is brittle for daemon installs.
 */
function staticFiles(rootDir: string): MiddlewareHandler {
  const rootReal = resolve(rootDir);
  return async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
    const url = new URL(c.req.url);
    const reqPath = url.pathname;
    if (reqPath.startsWith('/api/') || reqPath === '/ws' || reqPath === '/health') {
      return next();
    }
    const rel = reqPath.replace(/^\/+/, '');
    const target = resolve(rootReal, rel || 'index.html');
    if (target !== rootReal && !target.startsWith(rootReal + sep)) return next();
    const tryRead = async (p: string) => {
      const info = await stat(p);
      if (info.isDirectory()) return readFile(resolve(p, 'index.html'));
      return readFile(p);
    };
    try {
      const body = await tryRead(target);
      return c.body(new Uint8Array(body), 200, contentTypeFor(target));
    } catch {
      // Fall back to SPA index for client-side routes; if even index.html
      // is missing we let the request continue to the next handler.
      try {
        const body = await readFile(resolve(rootReal, 'index.html'));
        return c.body(new Uint8Array(body), 200, { 'Content-Type': 'text/html; charset=utf-8' });
      } catch {
        return next();
      }
    }
  };
}

function contentTypeFor(path: string): Record<string, string> {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  const map: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.mjs':  'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg':  'image/svg+xml',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif':  'image/gif',
    '.ico':  'image/x-icon',
    '.woff': 'font/woff',
    '.woff2':'font/woff2',
    '.ttf':  'font/ttf',
    '.map':  'application/json; charset=utf-8',
  };
  return { 'Content-Type': map[ext] ?? 'application/octet-stream' };
}

