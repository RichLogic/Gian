import type { Hono } from 'hono';
import type {
  AgentProxyDefaults,
  ConfigValue,
  Executor,
  ProductExecutor,
  ProxyCatalog,
} from '@gian/shared';
import { EXECUTOR_IDS, isApprovalMode, isProductExecutor, usesNativeExecutorConfig } from '@gian/shared';
import type { AgentManager } from '../../agents/manager.js';
import { AgentNameTakenError } from '../../agents/manager.js';
import type { CliRuntimeManager } from '../../runtime/manager.js';
import { pickPath } from '../pick-path.js';

const EXECUTORS = new Set<Executor>(EXECUTOR_IDS);

function executor(raw: string): Executor | null {
  return EXECUTORS.has(raw as Executor) ? raw as Executor : null;
}

function errorResponse(error: unknown): { error: string; code?: string } {
  return {
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof AgentNameTakenError ? { code: error.code } : {}),
  };
}

/** Agent mutations map onto HTTP statuses: name collisions 409, missing
 *  Agents 404, everything else is a bad request. */
function agentErrorStatus(error: unknown): 400 | 404 | 409 {
  if (error instanceof AgentNameTakenError) return 409;
  if (error instanceof Error && error.message.startsWith('agent not found:')) return 404;
  return 400;
}

function installErrorStatus(error: unknown): 409 | 502 {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'AGENT_UPDATE_BUSY'
  ) ? 409 : 502;
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

export function registerAgentRoutes(
  app: Hono,
  options: {
    agents: AgentManager;
    runtimes: CliRuntimeManager;
    closeProxy: (id: Executor) => Promise<void>;
    capabilities: (id: Executor) => Promise<ProxyCatalog>;
    resolveDefaultsCatalog?: (
      id: Executor,
      catalog: ProxyCatalog,
      config: { sessionConfig: Record<string, ConfigValue>; turnConfig: Record<string, ConfigValue> },
    ) => Promise<ProxyCatalog>;
  },
): void {
  // ------------------------------------------------------------------
  // Proxy-kind catalog (static metadata; drafts may call it — no Agent id
  // required, nothing is spawned or probed).
  // ------------------------------------------------------------------
  app.get('/api/proxies', c => c.json({ proxies: options.agents.proxiesCatalog() }));

  app.get('/api/proxies/:id/logo/:variant', async c => {
    const id = executor(c.req.param('id'));
    const variant = c.req.param('variant');
    if (!id || !isProductExecutor(id) || (variant !== 'light' && variant !== 'dark')) {
      return c.json({ error: 'logo not found' }, 404);
    }
    const logo = await options.agents.proxyLogo(id, variant);
    if (!logo) return c.json({ error: 'logo not found' }, 404);
    c.header('content-type', logo.mediaType);
    c.header('cache-control', 'private, max-age=300');
    c.header('etag', `"${logo.sha256}"`);
    c.header('x-content-type-options', 'nosniff');
    return c.body(Uint8Array.from(logo.bytes).buffer);
  });

  // ------------------------------------------------------------------
  // User Agents (saved identities in agents.json).
  // ------------------------------------------------------------------
  app.get('/api/agents', async c => c.json({
    agents: await options.agents.listAgentStatuses(c.req.query('refresh') === '1'),
  }));

  app.post('/api/agents', async c => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    try {
      if (!isProductExecutor(body.proxy)) {
        return c.json({ error: 'proxy must be a catalog Proxy kind' }, 400);
      }
      if (typeof body.name !== 'string') {
        return c.json({ error: 'name must be a string' }, 400);
      }
      const cliPath = body.cliPath;
      if (cliPath !== undefined && cliPath !== null && typeof cliPath !== 'string') {
        return c.json({ error: 'cliPath must be a string or null' }, 400);
      }
      const defaultsPatch = body.defaults && typeof body.defaults === 'object'
        && !Array.isArray(body.defaults)
        ? normalizeDefaultsPatch(body.defaults as Record<string, unknown>)
        : {};
      if ('error' in defaultsPatch) return c.json({ error: defaultsPatch.error }, 400);
      const agent = await options.agents.createAgent({
        name: body.name,
        proxy: body.proxy,
        ...(cliPath !== undefined ? { cliPath } : {}),
        defaults: defaultsPatch,
      });
      return c.json({ agent: await options.agents.agentStatus(agent.id, true) }, 201);
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
      if (body.cliPath !== undefined) {
        if (body.cliPath !== null && typeof body.cliPath !== 'string') {
          return c.json({ error: 'cliPath must be a string or null' }, 400);
        }
        patch.cliPath = body.cliPath;
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
            options.runtimes.invalidate(current.proxy);
            if (patch.proxy !== undefined && patch.proxy !== current.proxy) {
              options.runtimes.invalidate(patch.proxy);
            }
          }
        }
      })();
      return c.json({ agent: await options.agents.agentStatus(agent.id, true) });
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
      return c.json(await options.agents.agentStatus(raw, c.req.query('refresh') === '1'));
    } catch (error) {
      return c.json(errorResponse(error), agentErrorStatus(error));
    }
  });

  app.post('/api/agents/:id/pick-cli-path', async c => {
    const id = executor(c.req.param('id'));
    if (!id) return c.json({ error: 'unsupported agent' }, 404);
    if (process.platform !== 'darwin') {
      return c.json({ error: 'file picker only available on macOS' }, 400);
    }
    const outcome = await pickPath('file', 'Select CLI executable');
    if (outcome.kind === 'ok') return c.json({ path: outcome.path });
    if (outcome.kind === 'canceled') return c.json({ canceled: true });
    return c.json({ error: outcome.error }, 500);
  });

  app.post('/api/agents/:id/install-cli', async c => {
    const id = executor(c.req.param('id'));
    if (!id) return c.json({ error: 'unsupported agent' }, 404);
    try {
      // Drain this Host's shared runtime claim before requesting the exclusive
      // installer claim. A concurrent session or another Host can still win
      // the claim race, in which case installation fails closed with 409.
      await options.closeProxy(id);
      await options.runtimes.drain(id);
      const result = await options.agents.installOfficialCli(id);
      const activated = options.runtimes.invalidate(id);
      return c.json({ ...result, activated });
    } catch (error) {
      return c.json(errorResponse(error), installErrorStatus(error));
    }
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
      // The active Proxy version is an immutable directory selected at child
      // spawn, so existing children may drain only after atomic activation.
      // The scoped Proxy updater claim serializes updater work without
      // blocking another Host's read-only vendor CLI runtime claim.
      await options.closeProxy(id);
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
      // A second Agent of the same kind starts from the kind's existing path;
      // otherwise prefill the first locally detected CLI (PATH, then official
      // install locations). The user can still change it before saving.
      cliPath: existing.find(agent => agent.cliPath !== null)?.cliPath
        ?? await options.agents.scannedCliPath(kind),
    });
  });
}
