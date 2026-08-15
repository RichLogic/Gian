import type { Hono } from 'hono';
import type {
  AgentProxyDefaults,
  Executor,
  ProxyCapabilities,
} from '@gian/shared';
import type { AgentManager } from '../../agents/manager.js';
import type { CliRuntimeManager } from '../../runtime/manager.js';
import { pickPath } from '../pick-path.js';

const EXECUTORS = new Set<Executor>(['claude', 'codex', 'kimi', 'grok']);

function executor(raw: string): Executor | null {
  return EXECUTORS.has(raw as Executor) ? raw as Executor : null;
}

function errorResponse(error: unknown): { error: string } {
  return { error: error instanceof Error ? error.message : String(error) };
}

function installErrorStatus(error: unknown): 409 | 502 {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'AGENT_UPDATE_BUSY'
  ) ? 409 : 502;
}

function validateProxyDefaults(
  defaults: AgentProxyDefaults,
  capabilities: ProxyCapabilities,
): void {
  const visibleModels = capabilities.models.filter(model => !model.hidden);
  const selectedModel = defaults.model
    ? visibleModels.find(model => model.model === defaults.model)
    : visibleModels.find(model => model.isDefault) ?? visibleModels[0];
  if (defaults.model && !selectedModel) {
    throw new Error('model is not advertised by the Proxy');
  }
  if (defaults.thinking) {
    const supported = selectedModel
      ? ('supportedEfforts' in selectedModel
          ? selectedModel.supportedEfforts
          : selectedModel.supportedThinking)
      : [];
    if (!supported.includes(defaults.thinking)) {
      throw new Error('thinking/effort is not supported by the selected Proxy model');
    }
  }
  const modes = capabilities.modes ?? [];
  if (defaults.mode && !modes.some(mode => mode.id === defaults.mode)) {
    throw new Error('mode is not advertised by the Proxy');
  }
}

export function registerAgentRoutes(
  app: Hono,
  options: {
    agents: AgentManager;
    runtimes: CliRuntimeManager;
    closeProxy: (id: Executor) => Promise<void>;
    capabilities: (id: Executor) => Promise<ProxyCapabilities>;
  },
): void {
  app.get('/api/agents', async c => c.json({
    agents: await options.agents.list(c.req.query('refresh') === '1'),
  }));

  app.get('/api/agents/:id', async c => {
    const id = executor(c.req.param('id'));
    if (!id) return c.json({ error: 'unsupported agent' }, 404);
    return c.json(await options.agents.status(id, c.req.query('refresh') === '1'));
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

  app.put('/api/agents/:id/cli-path', async c => {
    const id = executor(c.req.param('id'));
    if (!id) return c.json({ error: 'unsupported agent' }, 404);
    try {
      const body = await c.req.json<{ path?: unknown }>();
      const path = body.path === null || body.path === ''
        ? null
        : typeof body.path === 'string'
          ? body.path
          : undefined;
      if (path === undefined) return c.json({ error: 'path must be a string or null' }, 400);
      let agent;
      let activated = false;
      try {
        agent = await options.agents.setCliPath(id, path);
      } finally {
        // setCliPath can commit the new path and then fail while retiring one
        // of its coordination claims. Invalidate the old runtime generation
        // for every completed mutation attempt, including that committed-error
        // outcome, so a stale lease can never keep serving the previous CLI.
        activated = options.runtimes.invalidate(id);
      }
      return c.json({ agent, activated });
    } catch (error) {
      return c.json(errorResponse(error), 400);
    }
  });

  app.put('/api/agents/:id/proxy-defaults', async c => {
    const id = executor(c.req.param('id'));
    if (!id) return c.json({ error: 'unsupported agent' }, 404);
    try {
      const body = await c.req.json<Partial<Record<keyof AgentProxyDefaults, unknown>>>();
      const patch: Partial<AgentProxyDefaults> = {};
      for (const key of ['model', 'thinking', 'mode'] as const) {
        const value = body[key];
        if (value !== undefined && typeof value !== 'string') {
          return c.json({ error: `${key} must be a string` }, 400);
        }
        if (typeof value === 'string') patch[key] = value;
      }
      const next = { ...options.agents.proxyDefaults(id), ...patch };
      validateProxyDefaults(next, await options.capabilities(id));
      return c.json({ agent: await options.agents.setProxyDefaults(id, patch) });
    } catch (error) {
      return c.json(errorResponse(error), 400);
    }
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
}
