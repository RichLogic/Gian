import { Hono } from 'hono';
import { createNodeWebSocket } from '@hono/node-ws';
import type { Db } from '../storage/db.js';
import type { SystemConfig } from '@gian/shared';
import { WsBroadcaster } from './ws-broadcast.js';
import { ProxyManager } from '../proxy/manager.js';
import { SessionManager } from '../session/manager.js';
import { TaskManager } from '../task/manager.js';
import { ApprovalManager } from '../approval/index.js';
import { QueueManager } from '../queue/index.js';
import { NativeJsonlWatcher } from '../native/watcher.js';
import { makeWsHandlers } from './ws-handler.js';
import { requireAuth, AUTH_REQUIRED } from '../auth/middleware.js';
// Per-platform managers own bot lifecycle and message delivery. Session,
// queue, approval, and workspace state all come from Gian's domain services.
import { DiscordCodingManager } from '../im/discord/manager.js';
import { DiscordCodingRepository } from '../im/discord/repository.js';
import { SlackCodingManager } from '../im/slack/manager.js';
import { SlackCodingRepository } from '../im/slack/repository.js';
import {
  buildIMOptions,
} from '../im/build-options.js';
import type { MessagingPlatform } from '../im/messaging/types.js';
import { migrateLegacyBots } from '../im/migrate-legacy-bots.js';
// `bots.ts` legacy helpers are referenced only by `migrateLegacyBots` (one
// shot at startup) — REST endpoints now go through `im/bots-api` against the
// per-platform tables.
import { WorkbenchTerminalManager } from '../term/manager.js';
import type { CliRuntimeManager } from '../runtime/manager.js';
import { ensureAuthConfigured, registerAuthRoutes } from './routes/auth.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerProxyRoutes } from './routes/proxy.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerBotRoutes } from './routes/bots.js';
import { registerReconnectRoutes } from './routes/reconnect.js';
import { registerNativeSessionRoutes } from './routes/native-sessions.js';
import { registerWorkspaceFileRoutes } from './routes/workspace-files.js';
import { registerWorkingTreeRoutes } from './routes/working-trees.js';
import { fanIMEvent } from './im-event-bridge.js';
import { bootJsonlWatchers } from './watcher-bootstrap.js';
import { resolveWebDistDir, staticFiles } from './static-files.js';

export interface AppContext {
  db: Db;
  config: SystemConfig;
  dataDir: string;
  ccProxyEntry: string;
  codexProxyEntry?: string;
  kimiProxyEntry?: string;
  codexBin?: string;
  runtimeManager?: CliRuntimeManager;
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
    kimiProxyEntry: ctx.kimiProxyEntry,
    codexBin: ctx.codexBin,
    runtimeManager: ctx.runtimeManager,
  });
  const approvals = new ApprovalManager(broadcaster);
  const queue = new QueueManager(ctx.db);
  const watcher = new NativeJsonlWatcher(ctx.db, broadcaster);
  const sessions = new SessionManager(ctx.db, proxy, broadcaster, approvals, queue, ctx.dataDir, watcher);
  const tasks = new TaskManager(ctx.db);

  // gian-task durability: re-drive any action rows a prior crash/restart left
  // non-terminal. Manager actions are always-on; coding/subtask actions still
  // respect GIAN_TASK_ROLES inside SessionManager.
  sessions.resumePendingTaskActions();

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
  const discordRepo = new DiscordCodingRepository(ctx.db);
  const slackRepo = new SlackCodingRepository(ctx.db);
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
    void fanIMEvent(e, ctx.db, sessions, approvals, platforms).catch(err => {
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

  // One-shot migration of legacy `bots` rows into platform tables. Idempotent:
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

  const handlers = makeWsHandlers({ sessions, tasks, broadcaster, approvals, term, db: ctx.db });

  if (AUTH_REQUIRED) {
    ensureAuthConfigured(ctx.db);
  }

  // Static SPA assets are served before requireAuth so the login page itself
  // can load when AUTH_REQUIRED is true. The handler returns a Response only
  // when it actually finds a file; otherwise it falls through to requireAuth
  // and the API routes below.
  const webDist = resolveWebDistDir();
  if (webDist) {
    app.use('*', staticFiles(webDist));
  }

  app.use('*', requireAuth());

  app.get('/health', c => c.json({ ok: true, version: '0.1.0' }));
  registerAuthRoutes(app, ctx.db);
  registerSettingsRoutes(app, ctx.db);
  registerWorkspaceRoutes(app, ctx.db);
  registerTaskRoutes(app, { tasks, sessions, broadcaster });
  registerProxyRoutes(app, ctx.db, sessions);
  registerSessionRoutes(app, ctx.db, sessions);
  registerNativeSessionRoutes(app, { db: ctx.db, sessions, broadcaster });
  registerWorkspaceFileRoutes(app, ctx.db);
  registerWorkingTreeRoutes(app, ctx.db, broadcaster);
  registerReconnectRoutes(app, ctx.db, proxy, platforms);
  registerBotRoutes(app, ctx.db, platforms);

  // -------------------------------------------------------------------------
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
