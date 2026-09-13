import type { Hono } from 'hono';
import type {
  AgentProxyDefaults,
  ConfigValue,
  Executor,
  LegacyExecutorId,
  ManagedRuntimeInstallStreamFrame,
  ProductExecutor,
  ProxyCatalog,
} from '@gian/shared';
import { executorIdForPluginId, isApprovalMode, isProductExecutor, usesNativeExecutorConfig } from '@gian/shared';
import type { AgentManager } from '../../agents/manager.js';
import { AgentCreateError, AgentNameTakenError, PluginIdImmutableError } from '../../agents/manager.js';
import { AgentHomeError } from '../../agents/home.js';
import { isProxyPluginId, parseProxyPluginId, resolvePluginIdInput } from '@gian/shared';
import { RuntimeResolverError, type RuntimeResolver } from '../../runtime/resolver.js';
import { RuntimeControlError, type RuntimeControlPlane } from '../../runtime/control-plane.js';
import { ManagedRuntimeDeliveryError, type ManagedRuntimeDeliveryService } from '../../runtime/delivery-service.js';
import { ManagedRuntimeInstallError } from '../../runtime/installer.js';
import { ManagedRuntimeActivationError } from '../../runtime/activation-service.js';
import { isCanonicalAbsolutePath } from '@gian/shared';
import { pickPath } from '../pick-path.js';
import { isCatalogDocumentKey, type CatalogService } from '../../catalog/service.js';
import { PluginStoreError } from '../../plugin-store/errors.js';

function executor(raw: string): LegacyExecutorId | null {
  return executorIdForPluginId(raw);
}

function errorResponse(error: unknown): { error: string; code?: string } {
  return {
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof AgentNameTakenError
      || error instanceof PluginIdImmutableError
      || error instanceof AgentHomeError
      || error instanceof AgentCreateError
      || error instanceof ManagedRuntimeDeliveryError
      || error instanceof ManagedRuntimeInstallError
      || error instanceof ManagedRuntimeActivationError
      || error instanceof RuntimeResolverError
      || error instanceof PluginStoreError
      ? { code: error.code } : {}),
  };
}

/** Agent mutations map onto HTTP statuses: name collisions 409, missing
 *  Agents 404, everything else is a bad request. */
function agentErrorStatus(error: unknown): 400 | 404 | 409 {
  if (error instanceof AgentCreateError) return error.status;
  if (error instanceof AgentHomeError) return error.status;
  if (error instanceof AgentNameTakenError) return 409;
  if (error instanceof PluginIdImmutableError) return 400;
  if (error instanceof Error && error.message.startsWith('agent not found:')) return 404;
  return 400;
}

function runtimeApiStatus(error: unknown): 400 | 404 | 409 | 413 | 502 {
  if (error instanceof RuntimeControlError) return error.status;
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : '';
  if (code === 'REQUEST_TOO_LARGE') return 413;
  if (error instanceof SyntaxError) return 400;
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('invalid pluginId') || message === 'invalid JSON body') return 400;
  return 502;
}

function runtimeDeliveryStatus(error: unknown): 400 | 409 | 502 {
  if (error instanceof ManagedRuntimeDeliveryError) {
    if (error.code === 'RUNTIME_AGENT_MISMATCH') return 400;
    return 409;
  }
  if (error instanceof ManagedRuntimeInstallError) {
    return error.code === 'RUNTIME_PLAN_INVALID' ? 400 : 502;
  }
  if (error instanceof ManagedRuntimeActivationError) return 409;
  if (error instanceof RuntimeResolverError) return 409;
  if (error instanceof PluginStoreError) {
    const status = installErrorStatus(error);
    return status === 410 ? 409 : status;
  }
  return 502;
}

function installErrorStatus(error: unknown): 400 | 409 | 410 | 502 {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : '';
  const message = error instanceof Error ? error.message : String(error);
  if (code === 'HOST_RUNTIME_INSTALLER_REMOVED') return 410;
  if (code === 'AGENT_UPDATE_BUSY' || code === 'PLUGIN_VERSION_CONFLICT') return 409;
  if (
    code === 'PLUGIN_ID_INVALID'
    || message.startsWith('invalid pluginId')
    || code === 'CATALOG_INSTALL_FORBIDDEN'
    || code === 'CATALOG_UPDATE_FORBIDDEN'
    || code === 'PLUGIN_PROTOCOL_INCOMPATIBLE'
  ) return 400;
  if (error instanceof PluginStoreError && (
    code === 'PLUGIN_URL_REJECTED'
    || code === 'CATALOG_ENTRY_MISSING'
    || code === 'PLUGIN_VERSION_INVALID'
    || code === 'PLUGIN_OFFICIAL_RESERVED'
    || code === 'PLUGIN_CURRENT_UNMANAGED'
  )) return 400;
  return 502;
}

function runtimeInstallProgressResponse(
  delivery: ManagedRuntimeDeliveryService,
  pluginId: string,
  agentId?: string,
): Response {
  const encoder = new TextEncoder();
  let open = true;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (frame: ManagedRuntimeInstallStreamFrame): void => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
        } catch {
          open = false;
        }
      };
      const close = (): void => {
        if (!open) return;
        open = false;
        try { controller.close(); } catch { /* renderer disconnected */ }
      };
      void delivery.install(pluginId, agentId, progress => {
        write({ type: 'progress', progress });
      }).then(generation => {
        write({ type: 'result', generation });
        close();
      }).catch(error => {
        const failure = errorResponse(error);
        write({
          type: 'error',
          error: {
            message: failure.error,
            ...(failure.code ? { code: failure.code } : {}),
          },
        });
        close();
      });
    },
    cancel() {
      // The Host-authorized installation keeps running. Disconnecting only
      // drops presentation output; it must not leave a partial generation.
      open = false;
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function publicAgentStatus<T extends { cliPath?: unknown }>(
  status: T,
  managed: boolean,
): Omit<T, 'cliPath'> | T {
  if (!managed) return status;
  const { cliPath: _legacyCliPath, ...publicStatus } = status;
  return publicStatus;
}

function managesRuntimePaths(agents: AgentManager): boolean {
  const method = (agents as Partial<Pick<AgentManager, 'managesRuntimePaths'>>).managesRuntimePaths;
  return typeof method === 'function' && method.call(agents) === true;
}

function optionChoices(catalog: ProxyCatalog, role: string): string[] {
  const option = catalog.configOptions.find((item) => item.role === role);
  return (option?.choices ?? []).map((choice) => String(choice.value));
}

function validateProxyDefaults(
  executorId: Executor,
  defaults: AgentProxyDefaults,
  patch: Partial<AgentProxyDefaults>,
  catalog: ProxyCatalog,
): void {
  const models = optionChoices(catalog, 'model');
  if (defaults.model && models.length > 0 && !models.includes(defaults.model)) {
    throw new Error('model is not advertised by the Proxy');
  }
  const efforts = optionChoices(catalog, 'effort');
  if (defaults.thinking && efforts.length > 0 && !efforts.includes(defaults.thinking)) {
    throw new Error('thinking/effort is not supported by the selected Proxy model');
  }
  const approvalModes = optionChoices(catalog, 'approval_mode');
  const executionModes = optionChoices(catalog, 'execution_mode');
  if (defaults.mode) {
    if (usesNativeExecutorConfig(executorId)) {
      const nativeModes = approvalModes.length > 0 ? approvalModes : executionModes;
      if (nativeModes.length > 0 && !nativeModes.includes(defaults.mode)) {
        throw new Error('mode is not advertised by the Proxy');
      }
    } else {
      const semanticModes = approvalModes.length > 0
        && approvalModes.every(isApprovalMode)
        ? approvalModes
        : [];
      if (!isApprovalMode(defaults.mode)) {
        throw new Error('mode is not a Gian approval preset');
      }
      if (semanticModes.length > 0 && !semanticModes.includes(defaults.mode)) {
        throw new Error('mode is not advertised by the Proxy');
      }
      if (patch.mode !== undefined && semanticModes.length === 0) {
        throw new Error('Proxy does not advertise product-level approval modes');
      }
    }
  }
}

function modelConfig(
  catalog: ProxyCatalog,
  model: string,
): { sessionConfig: Record<string, ConfigValue>; turnConfig: Record<string, ConfigValue> } {
  const sessionConfig: Record<string, ConfigValue> = {};
  const turnConfig: Record<string, ConfigValue> = {};
  const option = catalog.configOptions.find(item => item.role === 'model');
  if (option && model) {
    (option.binding === 'session' ? sessionConfig : turnConfig)[option.id] = model;
  }
  return { sessionConfig, turnConfig };
}

function normalizeDefaultsPatch(
  body: Record<string, unknown>,
): Partial<AgentProxyDefaults> | { error: string } {
  const patch: Partial<AgentProxyDefaults> = {};
  for (const key of ['model', 'thinking', 'mode'] as const) {
    const value = body[key];
    if (value !== undefined && typeof value !== 'string') {
      return { error: `${key} must be a string` };
    }
    if (typeof value === 'string') patch[key] = value;
  }
  return patch;
}

function normalizeHome(
  value: unknown,
): { kind: 'managed' } | { kind: 'custom'; path: string } | undefined | { error: string } {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'home must be an object' };
  }
  const home = value as Record<string, unknown>;
  const keys = Object.keys(home);
  if (home.kind === 'managed') {
    return keys.length === 1 ? { kind: 'managed' } : { error: 'managed home accepts only kind' };
  }
  if (home.kind === 'custom') {
    return keys.length === 2 && typeof home.path === 'string'
      ? { kind: 'custom', path: home.path }
      : { error: 'custom home requires kind and path' };
  }
  return { error: 'home.kind must be managed or custom' };
}

const MAX_RUNTIME_API_JSON_BYTES = 64 * 1024;

async function readBoundedJson(c: { req: { raw: Request } }): Promise<unknown> {
  const request = c.req.raw;
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > MAX_RUNTIME_API_JSON_BYTES) {
    throw Object.assign(new Error('request body exceeds 64 KiB'), { code: 'REQUEST_TOO_LARGE' });
  }
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > MAX_RUNTIME_API_JSON_BYTES) {
      await reader.cancel();
      throw Object.assign(new Error('request body exceeds 64 KiB'), { code: 'REQUEST_TOO_LARGE' });
    }
    chunks.push(value);
  }
  if (size === 0) return {};
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new SyntaxError('invalid JSON body');
  }
}

export function registerAgentRoutes(
  app: Hono,
  options: {
    agents: AgentManager;
    resolver?: RuntimeResolver;
    runtimeControl?: RuntimeControlPlane;
    runtimeDelivery?: ManagedRuntimeDeliveryService;
    closeProxy: (id: Executor) => Promise<void>;
    capabilities: (id: Executor) => Promise<ProxyCatalog>;
    resolveDefaultsCatalog?: (
      id: Executor,
      catalog: ProxyCatalog,
      config: { sessionConfig: Record<string, ConfigValue>; turnConfig: Record<string, ConfigValue> },
    ) => Promise<ProxyCatalog>;
    catalogService?: CatalogService;
    /** Test seam around the native folder picker; production uses pickPath. */
    pickHome?: () => ReturnType<typeof pickPath>;
  },
): void {
  // ------------------------------------------------------------------
  // Proxy-kind catalog (static metadata; drafts may call it — no Agent id
  // required, nothing is spawned or probed).
  // ------------------------------------------------------------------
  app.get('/api/proxies', async c => {
    const catalog = options.catalogService
      ? await options.catalogService.list()
      : { source: { id: null, sequence: null, state: 'empty', error: null }, items: [] };
    return c.json({
      proxies: options.agents.proxiesCatalog(),
      catalog,
    });
  });

  app.post('/api/proxies/sync', async c => {
    if (!options.catalogService) return c.json({ error: 'catalog unavailable' }, 404);
    try {
      return c.json(await options.catalogService.sync());
    } catch (error) {
      return c.json(errorResponse(error), 502);
    }
  });

  app.get('/api/proxies/:id/logo/:variant', async c => {
    const raw = decodeURIComponent(c.req.param('id'));
    const variant = c.req.param('variant');
    if (variant !== 'light' && variant !== 'dark') {
      return c.json({ error: 'logo not found' }, 404);
    }
    const official = executor(raw);
    if (official && isProductExecutor(official)) {
      const logo = await options.agents.proxyLogo(official, variant);
      if (logo) {
        c.header('content-type', logo.mediaType);
        c.header('cache-control', 'private, max-age=300');
        c.header('etag', `"${logo.sha256}"`);
        c.header('x-content-type-options', 'nosniff');
        return c.body(Uint8Array.from(logo.bytes).buffer);
      }
    }
    if (options.catalogService && isProxyPluginId(raw)) {
      const logo = await options.catalogService.logo(raw, variant);
      if (logo) {
        c.header('content-type', logo.mediaType);
        c.header('cache-control', 'private, max-age=300');
        c.header('etag', `"${logo.sha256}"`);
        c.header('x-content-type-options', 'nosniff');
        return c.body(Uint8Array.from(logo.bytes).buffer);
      }
    }
    return c.json({ error: 'logo not found' }, 404);
  });

  app.get('/api/proxies/:pluginId/docs/:document', async c => {
    if (!options.catalogService) return c.json({ error: 'documentation not found' }, 404);
    const pluginId = decodeURIComponent(c.req.param('pluginId'));
    const document = c.req.param('document');
    if (!isProxyPluginId(pluginId) || !isCatalogDocumentKey(document)) {
      return c.json({ error: 'documentation not found' }, 404);
    }
    const body = await options.catalogService.documentation(pluginId, document);
    if (!body) return c.json({ error: 'documentation not found' }, 404);
    c.header('content-type', body.mediaType);
    c.header('x-content-type-options', 'nosniff');
    c.header('cache-control', 'private, max-age=300');
    return c.body(Uint8Array.from(body.bytes).buffer);
  });

  app.get('/api/proxies/:pluginId', async c => {
    if (!options.catalogService) return c.json({ error: 'proxy not found' }, 404);
    const pluginId = decodeURIComponent(c.req.param('pluginId'));
    if (!isProxyPluginId(pluginId)) return c.json({ error: 'invalid pluginId' }, 400);
    const item = await options.catalogService.get(pluginId);
    if (!item) return c.json({ error: 'proxy not found' }, 404);
    return c.json({ proxy: item });
  });

  app.post('/api/proxies/:pluginId/runtime/discover', async c => {
    if (!options.runtimeControl) return c.json({ error: 'runtime control unavailable' }, 404);
    const pluginId = decodeURIComponent(c.req.param('pluginId'));
    try {
      parseProxyPluginId(pluginId);
      return c.json(await options.runtimeControl.discover(pluginId));
    } catch (error) {
      return c.json(errorResponse(error), runtimeApiStatus(error));
    }
  });

  app.post('/api/proxies/:pluginId/runtime/install', async c => {
    if (!options.runtimeDelivery) return c.json({ error: 'managed Runtime delivery unavailable' }, 404);
    const pluginId = decodeURIComponent(c.req.param('pluginId'));
    try {
      parseProxyPluginId(pluginId);
      const body = await readBoundedJson(c);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return c.json({ error: 'invalid JSON body' }, 400);
      }
      const agentId = (body as { agentId?: unknown }).agentId;
      if (agentId !== undefined && (typeof agentId !== 'string' || agentId.trim() === '')) {
        return c.json({ error: 'agentId must be a non-empty string' }, 400);
      }
      if (c.req.header('accept')?.includes('application/x-ndjson')) {
        return runtimeInstallProgressResponse(
          options.runtimeDelivery,
          pluginId,
          typeof agentId === 'string' ? agentId : undefined,
        );
      }
      const generation = await options.runtimeDelivery.install(
        pluginId,
        typeof agentId === 'string' ? agentId : undefined,
      );
      return c.json({ generation });
    } catch (error) {
      return c.json(errorResponse(error), runtimeDeliveryStatus(error));
    }
  });

  app.get('/api/proxies/:pluginId/runtime', async c => {
    const pluginId = decodeURIComponent(c.req.param('pluginId'));
    try {
      parseProxyPluginId(pluginId);
      return c.json(await options.agents.managedRuntimeStatus(pluginId));
    } catch (error) {
      return c.json(errorResponse(error), runtimeApiStatus(error));
    }
  });

  app.post('/api/proxies/:pluginId/runtime/probe', async c => {
    if (!options.runtimeControl) return c.json({ error: 'runtime control unavailable' }, 404);
    const pluginId = decodeURIComponent(c.req.param('pluginId'));
    try {
      parseProxyPluginId(pluginId);
      const body = await readBoundedJson(c);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return c.json({ error: 'invalid JSON body' }, 400);
      }
      const path = (body as { path?: unknown }).path;
      if (typeof path !== 'string' || !isCanonicalAbsolutePath(path)) {
        return c.json({ error: 'path must be a canonical absolute path' }, 400);
      }
      return c.json(await options.runtimeControl.probe(pluginId, path));
    } catch (error) {
      return c.json(errorResponse(error), runtimeApiStatus(error));
    }
  });

  app.post('/api/proxies/:pluginId/install', async c => {
    if (!options.catalogService) return c.json({ error: 'catalog unavailable' }, 404);
    const pluginId = decodeURIComponent(c.req.param('pluginId'));
    try {
      parseProxyPluginId(pluginId);
      const receipt = await options.catalogService.install(pluginId);
      return c.json({ receipt });
    } catch (error) {
      return c.json(errorResponse(error), installErrorStatus(error));
    }
  });

  app.post('/api/proxies/:pluginId/update', async c => {
    if (!options.catalogService) return c.json({ error: 'catalog unavailable' }, 404);
    const pluginId = decodeURIComponent(c.req.param('pluginId'));
    try {
      parseProxyPluginId(pluginId);
      const receipt = await options.catalogService.update(pluginId);
      return c.json({ receipt });
    } catch (error) {
      return c.json(errorResponse(error), installErrorStatus(error));
    }
  });

  app.post('/api/proxies/:pluginId/rollback', async c => {
    if (!options.catalogService) return c.json({ error: 'catalog unavailable' }, 404);
    const pluginId = decodeURIComponent(c.req.param('pluginId'));
    try {
      parseProxyPluginId(pluginId);
      let version: string | undefined;
      try {
        const body = await c.req.json<{ version?: unknown }>();
        if (body.version !== undefined && typeof body.version !== 'string') {
          return c.json({ error: 'version must be a string' }, 400);
        }
        if (typeof body.version === 'string') version = body.version;
      } catch {
        /* empty body selects previous SemVer generation */
      }
      const receipt = await options.catalogService.rollback(pluginId, version);
      return c.json({ receipt });
    } catch (error) {
      return c.json(errorResponse(error), installErrorStatus(error));
    }
  });

  // ------------------------------------------------------------------
  // User Agents (saved identities in agents.json).
  // ------------------------------------------------------------------
  app.get('/api/agents', async c => c.json({
    agents: (await options.agents.listAgentStatuses(c.req.query('refresh') === '1'))
      .map(status => publicAgentStatus(status, managesRuntimePaths(options.agents))),
  }));

  app.post('/api/agents', async c => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    try {
      if (body.pluginId !== undefined && typeof body.pluginId !== 'string') {
        return c.json({ error: 'pluginId must be a string' }, 400);
      }
      const pluginId = body.pluginId !== undefined ? resolvePluginIdInput(body.pluginId) : null;
      if (body.pluginId !== undefined && !pluginId) {
        return c.json({ error: 'pluginId must be a reserved official ID or reverse-domain ID' }, 400);
      }
      if (!pluginId && !isProductExecutor(body.proxy)) {
        return c.json({ error: 'pluginId or proxy is required' }, 400);
      }
      if (typeof body.name !== 'string') {
        return c.json({ error: 'name must be a string' }, 400);
      }
      const cliPath = body.cliPath;
      if (cliPath !== undefined && managesRuntimePaths(options.agents)) {
        return c.json({
          error: 'CLI path is managed globally by Gian and cannot be configured per Agent.',
          code: 'CLI_PATH_MANAGED',
        }, 400);
      }
      if (cliPath !== undefined && cliPath !== null && typeof cliPath !== 'string') {
        return c.json({ error: 'cliPath must be a string or null' }, 400);
      }
      const home = normalizeHome(body.home);
      if (home && 'error' in home) return c.json({ error: home.error }, 400);
      const defaultsPatch = body.defaults && typeof body.defaults === 'object'
        && !Array.isArray(body.defaults)
        ? normalizeDefaultsPatch(body.defaults as Record<string, unknown>)
        : {};
      if ('error' in defaultsPatch) return c.json({ error: defaultsPatch.error }, 400);
      const agent = await options.agents.createAgent({
        name: body.name,
        ...(pluginId ? { pluginId } : {}),
        ...(isProductExecutor(body.proxy) ? { proxy: body.proxy } : {}),
        ...(home ? { home } : {}),
        ...(cliPath !== undefined ? { cliPath } : {}),
        defaults: defaultsPatch,
      });
      return c.json({
        agent: publicAgentStatus(
          await options.agents.agentStatus(agent.id, true),
          managesRuntimePaths(options.agents),
        ),
      }, 201);
    } catch (error) {
      return c.json(errorResponse(error), agentErrorStatus(error));
    }
  });

  app.patch('/api/agents/:id', async c => {
    const id = c.req.param('id');
    if (executor(id)) return c.json({ error: 'unsupported agent' }, 404);
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    try {
      const current = options.agents.getAgent(id);
      const patch: Parameters<AgentManager['updateAgent']>[1] = {};
      if (body.name !== undefined) {
        if (typeof body.name !== 'string') return c.json({ error: 'name must be a string' }, 400);
        patch.name = body.name;
      }
      if (body.cliPath !== undefined && managesRuntimePaths(options.agents)) {
        return c.json({
          error: 'CLI path is managed globally by Gian and cannot be configured per Agent.',
          code: 'CLI_PATH_MANAGED',
        }, 400);
      }
      if (body.cliPath !== undefined) {
        if (body.cliPath !== null && typeof body.cliPath !== 'string') {
          return c.json({ error: 'cliPath must be a string or null' }, 400);
        }
        patch.cliPath = body.cliPath;
      }
      const home = normalizeHome(body.home);
      if (home && 'error' in home) return c.json({ error: home.error }, 400);
      if (home) patch.home = home;
      if (body.pluginId !== undefined) {
        if (typeof body.pluginId !== 'string') {
          return c.json({ error: 'pluginId must be a string' }, 400);
        }
        patch.pluginId = body.pluginId;
      }
      if (body.proxy !== undefined) {
        if (!isProductExecutor(body.proxy)) {
          return c.json({ error: 'proxy must be a catalog Proxy kind' }, 400);
        }
        patch.proxy = body.proxy;
      }
      let defaultsPatch: Partial<AgentProxyDefaults> | undefined;
      if (body.defaults !== undefined) {
        if (!body.defaults || typeof body.defaults !== 'object' || Array.isArray(body.defaults)) {
          return c.json({ error: 'defaults must be an object' }, 400);
        }
        const normalized = normalizeDefaultsPatch(body.defaults as Record<string, unknown>);
        if ('error' in normalized) return c.json({ error: normalized.error }, 400);
        defaultsPatch = normalized;
        // Defaults stay write-through (no restart), but they must remain
        // values the kind's Proxy actually advertises.
        const kind = patch.proxy ?? current.proxy;
        if (!kind) {
          return c.json({ error: 'defaults require an official Agent' }, 400);
        }
        const next = { ...current.defaults, ...defaultsPatch };
        const catalog = await options.capabilities(kind);
        const validationCatalog = options.resolveDefaultsCatalog && next.model
          ? await options.resolveDefaultsCatalog(kind, catalog, modelConfig(catalog, next.model))
          : catalog;
        validateProxyDefaults(kind, next, defaultsPatch, validationCatalog);
        patch.defaults = defaultsPatch;
      }
      const agent = await (async () => {
        try {
          return await options.agents.updateAgent(id, patch);
        } finally {
          if (patch.cliPath !== undefined || patch.proxy !== undefined) {
            // updateAgent can commit the new path and then fail while retiring
            // one of its coordination claims. Invalidate the old runtime
            // generation for every completed mutation attempt, including that
            // committed-error outcome, so a stale lease can never keep serving
            // the previous CLI.
            options.resolver?.invalidate(current.pluginId, current.cliPath);
          }
        }
      })();
      return c.json({
        agent: publicAgentStatus(
          await options.agents.agentStatus(agent.id, true),
          managesRuntimePaths(options.agents),
        ),
      });
    } catch (error) {
      return c.json(errorResponse(error), agentErrorStatus(error));
    }
  });

  app.delete('/api/agents/:id', async c => {
    const id = c.req.param('id');
    if (executor(id)) return c.json({ error: 'unsupported agent' }, 404);
    try {
      await options.agents.deleteAgent(id);
      return c.json({ ok: true });
    } catch (error) {
      return c.json(errorResponse(error), agentErrorStatus(error));
    }
  });

  // ------------------------------------------------------------------
  // Kind-level status + install/update (draft-safe: keyed by Proxy kind).
  // ------------------------------------------------------------------
  app.get('/api/agents/:id', async c => {
    const raw = c.req.param('id');
    const kind = executor(raw);
    if (kind) {
      return c.json(await options.agents.status(kind, c.req.query('refresh') === '1'));
    }
    try {
      return c.json(publicAgentStatus(
        await options.agents.agentStatus(raw, c.req.query('refresh') === '1'),
        managesRuntimePaths(options.agents),
      ));
    } catch (error) {
      return c.json(errorResponse(error), agentErrorStatus(error));
    }
  });

  app.post('/api/agents/:id/pick-cli-path', async c => {
    const id = executor(c.req.param('id'));
    if (!id) return c.json({ error: 'unsupported agent' }, 404);
    return c.json({
      error: 'CLI path is managed globally by Gian and has no file picker.',
      code: 'CLI_PATH_MANAGED',
    }, 410);
  });

  app.post('/api/agents/:id/pick-home', async c => {
    const id = c.req.param('id');
    try {
      options.agents.getAgent(id);
    } catch {
      return c.json({ error: `agent not found: ${id}` }, 404);
    }
    if (!options.pickHome && process.platform !== 'darwin') {
      return c.json({ error: 'file picker only available on macOS' }, 400);
    }
    const outcome = await (options.pickHome?.() ?? pickPath('folder', 'Select Agent HOME'));
    if (outcome.kind === 'ok') return c.json({ path: outcome.path });
    if (outcome.kind === 'canceled') return c.json({ canceled: true });
    return c.json({ error: outcome.error }, 500);
  });

  app.post('/api/agents/pick-home', async c => {
    if (!options.pickHome && process.platform !== 'darwin') {
      return c.json({ error: 'file picker only available on macOS' }, 400);
    }
    const outcome = await (options.pickHome?.() ?? pickPath('folder', 'Select Agent HOME'));
    if (outcome.kind === 'ok') return c.json({ path: outcome.path });
    if (outcome.kind === 'canceled') return c.json({ canceled: true });
    return c.json({ error: outcome.error }, 500);
  });

  app.post('/api/agents/:id/install-cli', async c => {
    const id = executor(c.req.param('id'));
    if (!id) return c.json({ error: 'unsupported agent' }, 404);
    return c.json({
      error: 'Runtime setup uses Proxy documentation and typed open/select actions; Host no longer executes installers.',
      code: 'HOST_RUNTIME_INSTALLER_REMOVED',
    }, 410);
  });

  app.post('/api/agents/:id/check-proxy-update', async c => {
    const id = executor(c.req.param('id'));
    if (!id) return c.json({ error: 'unsupported agent' }, 404);
    try {
      // Read-only availability probe: no update lock, no filesystem or
      // process side effects — the update itself stays on install-proxy.
      return c.json(await options.agents.checkProxyUpdate(id));
    } catch (error) {
      return c.json(errorResponse(error), 502);
    }
  });

  app.post('/api/agents/:id/install-proxy', async c => {
    const id = executor(c.req.param('id'));
    if (!id) return c.json({ error: 'unsupported agent' }, 404);
    try {
      const result = await options.agents.installProxy(id);
      // Current pointer changes affect future Sessions only. Existing exact
      // owners keep their retained generation and drain themselves.
      return c.json(result);
    } catch (error) {
      return c.json(errorResponse(error), installErrorStatus(error));
    }
  });

  // Kind default draft helpers: name/color/path the client can prefill a
  // draft card with before the Agent exists.
  app.get('/api/proxies/:id/draft-defaults', async c => {
    const raw = c.req.param('id');
    if (!isProductExecutor(raw)) return c.json({ error: 'unknown proxy' }, 404);
    const kind: ProductExecutor = raw;
    const existing = options.agents.listAgents().filter(agent => agent.proxy === kind);
    return c.json({
      name: options.agents.nextAgentName(kind),
      home: kind === 'zcode' ? null : { kind: 'managed', path: null },
      // Read-only active Runtime path. Never PATH-scan or accept it back on
      // Agent create/update.
      cliPath: existing.find(agent => agent.cliPath !== null)?.cliPath
        ?? await options.agents.scannedCliPath(kind),
    });
  });
}
