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
import { AttentionDispatcher } from '../session/attention.js';
import { makeWsHandlers } from './ws-handler.js';
import { requireAuth, AUTH_REQUIRED } from '../auth/middleware.js';
import { WorkbenchTerminalManager } from '../term/manager.js';
import type { CliRuntimeManager } from '../runtime/manager.js';
import type { AgentManager } from '../agents/manager.js';
import { ensureAuthConfigured, registerAuthRoutes } from './routes/auth.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerProxyRoutes } from './routes/proxy.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerReconnectRoutes } from './routes/reconnect.js';
import { registerNativeSessionRoutes } from './routes/native-sessions.js';
import { registerWorkspaceFileRoutes } from './routes/workspace-files.js';
import { registerWorkingTreeRoutes } from './routes/working-trees.js';
import { registerAbsoluteFileRoutes } from './routes/absolute-files.js';
import { registerAgentRoutes } from './routes/agents.js';
import { registerOnboardingRoutes } from './routes/onboarding.js';
import { bootJsonlWatchers } from './watcher-bootstrap.js';
import { resolveWebDistDir, staticFiles } from './static-files.js';
import { buildHealthPayload } from './health.js';
import { requireDesktopClient } from './desktop-boundary.js';
import { RuntimeGuardian } from '../runtime/guardian.js';
import type { ApplicationRouteOptions } from './routes/applications.js';
import { GianToolService } from '../tool/service.js';
import { GianToolCredentialManager } from '../tool/credentials.js';
import { GianToolAccessController } from '../tool/access.js';
import { gianToolMcpUrl, isLoopbackMcpHost, registerGianToolMcpRoute } from '../tool/mcp-http.js';
import { GianSessionHostServiceIssuer } from '../tool/session-host-services.js';

export interface AppContext {
  db: Db;
  config: SystemConfig;
  dataDir: string;
  hostVersion?: string;
  ccProxyEntry: string;
  claudeProxy?: {
    pluginVersion: string;
    processScope: 'shared' | 'session';
  };
  codexProxyEntry?: string;
  codexProxy?: {
    pluginVersion: string;
    processScope: 'shared' | 'session';
  };
  kimiProxyEntry?: string;
  kimiProxy?: {
    pluginVersion: string;
    processScope: 'shared' | 'session';
  };
  grokProxyEntry?: string;
  grokProxy?: {
    pluginVersion: string;
    processScope: 'shared' | 'session';
  };
  dshProxyEntry?: string;
  dshProxy?: {
    pluginVersion: string;
    processScope: 'shared' | 'session';
  };
  zcodeProxyEntry?: string;
  zcodeProxy?: {
    pluginVersion: string;
    processScope: 'shared' | 'session';
  };
  codexBin?: string;
  runtimeManager?: CliRuntimeManager;
  agentManager?: AgentManager;
  /** Test seam; production uses the guardian's five-minute cadence. */
  runtimeGuardianIntervalMs?: number;
  /** Test seam; production uses real operating-system application launchers. */
  applicationRouteOptions?: ApplicationRouteOptions;
  /** Test seam for the authenticated MCP request/wait bounds. */
  toolMcpLimits?: { requests?: number; waits?: number };
  /** Test seam for holding a Tool call while asserting concurrency bounds. */
  toolMcpBeforeCall?: (method: import('@gian/shared').GianToolMethod) => Promise<void>;
}

export interface AppHandle {
  app: Hono;
  injectWebSocket: ReturnType<typeof createNodeWebSocket>['injectWebSocket'];
  shutdown: () => Promise<void>;
  toolService: GianToolService;
  toolCredentials: GianToolCredentialManager;
}

export function createApp(ctx: AppContext): AppHandle {
  const app = new Hono();
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

  const broadcaster = new WsBroadcaster();
  const proxy = new ProxyManager({
    dataDir: ctx.dataDir,
    hostVersion: ctx.hostVersion,
    ccProxyEntry: ctx.ccProxyEntry,
    claudeProxy: ctx.claudeProxy,
    codexProxyEntry: ctx.codexProxyEntry,
    codexProxy: ctx.codexProxy,
    kimiProxyEntry: ctx.kimiProxyEntry,
    kimiProxy: ctx.kimiProxy,
    grokProxyEntry: ctx.grokProxyEntry,
    grokProxy: ctx.grokProxy,
    dshProxyEntry: ctx.dshProxyEntry,
    dshProxy: ctx.dshProxy,
    zcodeProxyEntry: ctx.zcodeProxyEntry,
    zcodeProxy: ctx.zcodeProxy,
    codexBin: ctx.codexBin,
    runtimeManager: ctx.runtimeManager,
    ...(ctx.agentManager
      ? {
          resolveProxyVersion: async (executor: import('@gian/shared').Executor, version: string) => {
            const descriptor = await ctx.agentManager!.proxyLaunchDescriptor(executor, version);
            return { entryPath: descriptor.entryPath, protocol: descriptor.protocol };
          },
        }
      : {}),
  });
  const runtimeGuardian = ctx.runtimeManager
    ? new RuntimeGuardian({
        runtimes: ctx.runtimeManager,
        closeRuntimeOwner: executor => proxy.closeByExecutor(executor),
        ...(ctx.runtimeGuardianIntervalMs
          ? { intervalMs: ctx.runtimeGuardianIntervalMs }
          : {}),
        log: (message, error) => error === undefined
          ? console.warn(message)
          : console.warn(message, error),
      })
    : undefined;
  runtimeGuardian?.start();
  const approvals = new ApprovalManager(broadcaster);
  const queue = new QueueManager(ctx.db);
  const attention = new AttentionDispatcher(broadcaster);
  const watcher = new NativeJsonlWatcher(ctx.db, broadcaster, attention);
  const toolCredentials = new GianToolCredentialManager(ctx.db);
  // No raw internal token survives the Host process. A restart invalidates
  // every prior attach generation before any Session can be rehydrated.
  toolCredentials.revokeAllInternalSessions();
  const sessionHostServices = isLoopbackMcpHost(ctx.config.host)
    ? new GianSessionHostServiceIssuer(
        toolCredentials,
        gianToolMcpUrl(ctx.config.host, ctx.config.port),
      )
    : undefined;
  const sessions = new SessionManager(
    ctx.db,
    proxy,
    broadcaster,
    approvals,
    queue,
    ctx.dataDir,
    watcher,
    ctx.agentManager ? executor => ctx.agentManager!.proxyDefaults(executor) : undefined,
    attention,
    ctx.agentManager
      ? {
          cliPathForKind: executor => ctx.agentManager!.firstAgentPath(executor),
          cliPathForSession: session => {
            if (session.agent_id) {
              try {
                ctx.agentManager!.getAgent(session.agent_id);
                return session.runtime_profile?.cliPath
                  ?? ctx.agentManager!.agentRuntimePath(session.agent_id).cliPath;
              } catch {
                return null;
              }
            }
            return ctx.agentManager!.firstAgentPath(session.executor);
          },
          requireCliPathForSession: session => {
            if (session.agent_id) {
              try {
                ctx.agentManager!.getAgent(session.agent_id);
                return session.runtime_profile?.cliPath
                  ?? ctx.agentManager!.agentRuntimePath(session.agent_id).cliPath;
              } catch {
                throw Object.assign(
                  new Error(`Agent was deleted: ${session.agent_name ?? session.agent_id}`),
                  { code: 'AGENT_DELETED' },
                );
              }
            }
            return ctx.agentManager!.firstAgentPath(session.executor);
          },
          agentRuntime: agentId => {
            const agent = ctx.agentManager!.getAgent(agentId);
            return {
              agent,
              cliPath: ctx.agentManager!.agentRuntimePath(agentId).cliPath,
            };
          },
          agentRuntimeProfile: async agentId => {
            const status = await ctx.agentManager!.agentStatus(agentId, true);
            if (!status.ready) throw new Error(`agent is not ready: ${status.name}`);
            return status.runtimeProfile;
          },
          agentsForKind: executor => (
            ctx.agentManager!.listAgents().filter(agent => agent.proxy === executor)
          ),
        }
      : undefined,
    sessionHostServices,
  );
  const tasks = new TaskManager(ctx.db);
  const toolService = new GianToolService({
    db: ctx.db,
    tasks,
    sessions,
    approvals,
    broadcaster,
    ...(ctx.agentManager ? { agents: ctx.agentManager } : {}),
  });
  const toolAccess = new GianToolAccessController(toolService, ctx.db);

  // Workbench terminal manager — standalone shell PTYs, independent of
  // any Gian session. The xterm tabs in the workbench pane are bound to
  // client-minted `term_id`s and routed through `term:*` WS messages.
  const term = new WorkbenchTerminalManager(broadcaster);

  // Live Sync v2: on host boot, attach a watcher to every active session so
  // we resume picking up external CLI appends after a host restart. New
  // sessions get watched lazily inside SessionManager.bringUpProxySession.
  bootJsonlWatchers(ctx.db, watcher, {
    executors: [],
  });

  // Break the circular dependency: ApprovalManager needs to call back into
  // SessionManager to forward auto-approve decisions to the proxy, but we
  // can't import SessionManager from ApprovalManager. Inject the callbacks
  // here after both objects exist.
  approvals.setRespondFn((sid, aid, dec) => sessions.respondApproval(sid, aid, dec));
  approvals.setGetModeFn(sid => sessions.getApprovalModeForActiveTurn(sid));

  // Pre-warm proxy capabilities so model controls are ready before the first
  // session opens. Async, non-blocking; failures are tolerated.
  //
  // Only saved Agents' (kind, path) pairs warm: the catalog itself never
  // spawns at boot, and an Agent whose CLI/Proxy is not ready is skipped.
  // `GIAN_SKIP_PROXY_WARMUP=1` lets tests `createApp` an in-memory Hono
  // harness without spawning a real cc-proxy / codex-proxy child.
  if (process.env['GIAN_SKIP_PROXY_WARMUP'] !== '1' && ctx.agentManager) {
    const agentManager = ctx.agentManager;
    const warm = (agentId: string, proxy: 'claude' | 'codex') => {
      const cliPath = agentManager.agentRuntimePath(agentId).cliPath;
      const run = () => sessions.warmCapabilities(proxy, cliPath).catch(err => {
        console.warn(`[proxy] warmCapabilities(${proxy}) failed:`, err instanceof Error ? err.message : err);
      });
      return agentManager.agentStatus(agentId).then(status => (
        status.ready ? run() : undefined
      ));
    };
    void Promise.all(
      agentManager.listAgents()
        .filter(agent => agent.proxy === 'claude' || agent.proxy === 'codex')
        .map(agent => warm(agent.id, agent.proxy as 'claude' | 'codex')),
    );
  }

  const handlers = makeWsHandlers({ sessions, tasks, broadcaster, approvals, term, db: ctx.db });

  // The MCP capability token is its own local credential boundary. Register
  // this endpoint before Desktop/Web auth middleware so Provider runtimes do
  // not need or inherit the Desktop token.
  registerGianToolMcpRoute(app, {
    dataDir: ctx.dataDir,
    host: ctx.config.host,
    port: ctx.config.port,
    credentials: toolCredentials,
    access: toolAccess,
    ...(ctx.toolMcpLimits ? { limits: ctx.toolMcpLimits } : {}),
    ...(ctx.toolMcpBeforeCall ? { beforeCall: ctx.toolMcpBeforeCall } : {}),
  });

  const desktopOrigin = `http://${ctx.config.host}:${ctx.config.port}`;
  app.use('*', requireDesktopClient(
    process.env['GIAN_DESKTOP_TOKEN']?.trim() ?? '',
    desktopOrigin,
  ));

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

  app.get('/health', c => c.json(buildHealthPayload()));
  registerAuthRoutes(app, ctx.db);
  registerSettingsRoutes(app, ctx.db);
  registerWorkspaceRoutes(app, ctx.db);
  registerTaskRoutes(app, { tasks, sessions, broadcaster });
  registerProxyRoutes(
    app,
    ctx.db,
    sessions,
    ctx.agentManager
      ? agentId => ctx.agentManager!.agentRuntimePath(agentId)
      : undefined,
  );
  registerSessionRoutes(app, ctx.db, sessions);
  registerNativeSessionRoutes(app, { db: ctx.db, sessions, broadcaster });
  registerWorkspaceFileRoutes(app, ctx.db);
  registerWorkingTreeRoutes(app, ctx.db, broadcaster, {
    applicationRoutes: ctx.applicationRouteOptions,
  });
  registerAbsoluteFileRoutes(app);
  registerReconnectRoutes(app, proxy);
  if (ctx.agentManager && ctx.runtimeManager) {
    registerOnboardingRoutes(app, {
      db: ctx.db,
      agents: ctx.agentManager,
    });
    registerAgentRoutes(app, {
      agents: ctx.agentManager,
      runtimes: ctx.runtimeManager,
      closeProxy: executor => proxy.closeByExecutor(executor),
      capabilities: executor => sessions.warmCapabilities(executor),
      resolveDefaultsCatalog: async (executor, catalog, config) => {
        if (sessions.getProtocolCapabilities(executor)?.['catalog.resolve'] === undefined) {
          return catalog;
        }
        return sessions.resolveCatalog(executor, {
          catalogRevision: catalog.catalogRevision,
          ...config,
        });
      },
    });
  }

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
    toolService,
    toolCredentials,
    shutdown: async () => {
      sessionHostServices?.revokeAll();
      toolService.close();
      watcher.stopAll();
      await term.closeAll();
      await runtimeGuardian?.stop();
      await proxy.closeAll();
    },
  };
}
