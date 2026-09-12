import { ProxyProtocolError } from '@gian/proxy-protocol';
import type { Hono } from 'hono';
import { resolvePluginIdInput } from '@gian/shared';
import type { SessionManager } from '../../session/manager.js';
import type { Db } from '../../storage/db.js';

/** Resolves a saved Agent's runtime (kind, CLI path) for agent-scoped
 *  catalog queries. Wired from AgentManager.agentRuntimePath. */
export type AgentRuntimePathResolver = (agentId: string) => {
  pluginId: string;
  cliPath: string | null;
};

export function registerProxyRoutes(
  app: Hono,
  db: Db,
  sessions: SessionManager,
  agentPaths?: AgentRuntimePathResolver,
): void {
  /** Optional ?agent=<id> discriminator: the catalog of one Proxy kind can
   *  differ per Agent CLI path, so agent-scoped callers resolve their own
   *  (kind, path) instead of the kind default. */
  const agentCliPath = (
    c: { req: { query: (name: string) => string | undefined } },
    pluginId: string,
  ):
    | { cliPath: string | null | undefined }
    | { error: string } => {
    const agentId = c.req.query('agent');
    if (agentId === undefined) return { cliPath: undefined };
    if (!agentPaths) return { error: 'agent-scoped catalogs are not available' };
    try {
      const agent = agentPaths(agentId);
      if (resolvePluginIdInput(agent.pluginId) !== pluginId) {
        return { error: `agent ${agentId} does not use ${pluginId}` };
      }
      return { cliPath: agent.cliPath };
    } catch {
      return { error: `agent not found: ${agentId}` };
    }
  };

  app.get('/api/proxy/:executor/capabilities', async c => {
    const executor = resolvePluginIdInput(decodeURIComponent(c.req.param('executor')));
    if (!executor) return c.json({ error: 'invalid pluginId' }, 400);
    const target = agentCliPath(c, executor);
    if ('error' in target) return c.json({ error: target.error }, 404);
    const cliPath = c.req.query('agent') !== undefined ? target.cliPath : undefined;
    try {
      const catalog = await sessions.warmCapabilities(executor, cliPath);
      return c.json({
        ...catalog,
        capabilities: sessions.getProtocolCapabilities(executor, cliPath) ?? {},
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.post('/api/proxy/:executor/catalog/resolve', async c => {
    const executor = resolvePluginIdInput(decodeURIComponent(c.req.param('executor')));
    if (!executor) return c.json({ error: 'invalid pluginId' }, 400);
    let body: {
      catalogRevision?: unknown;
      sessionConfig?: unknown;
      turnConfig?: unknown;
      sessionId?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (typeof body.catalogRevision !== 'string' || body.catalogRevision.length === 0) {
      return c.json({ error: 'catalogRevision is required' }, 400);
    }
    let cliPath: string | null | undefined;
    if (typeof body.sessionId === 'string') {
      const session = db.prepare(
        'SELECT executor, proxy_plugin_id, agent_id FROM sessions WHERE id = ?',
      ).get(body.sessionId) as {
        executor: string;
        proxy_plugin_id: string | null;
        agent_id: string | null;
      } | undefined;
      if (!session) return c.json({ error: `session not found: ${body.sessionId}` }, 404);
      if (resolvePluginIdInput(session.proxy_plugin_id ?? session.executor) !== executor) {
        return c.json({ error: 'session executor does not match route executor' }, 400);
      }
      if (session.agent_id !== null) {
        if (!agentPaths) return c.json({ error: 'agent-scoped catalogs are not available' }, 404);
        try {
          const agent = agentPaths(session.agent_id);
          if (resolvePluginIdInput(agent.pluginId) !== executor) {
            return c.json({ error: 'session Agent does not match route pluginId' }, 400);
          }
          cliPath = agent.cliPath;
        } catch {
          return c.json({ error: `agent not found: ${session.agent_id}` }, 404);
        }
      }
    } else {
      const target = agentCliPath(c, executor);
      if ('error' in target) return c.json({ error: target.error }, 404);
      cliPath = c.req.query('agent') !== undefined ? target.cliPath : undefined;
    }
    try {
      await sessions.warmCapabilities(executor, cliPath);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
    const advertised = sessions.getProtocolCapabilities(executor, cliPath)?.['catalog.resolve'];
    if (advertised === undefined) {
      return c.json({ error: 'catalog.resolve is not advertised' }, 404);
    }
    const sessionConfig = body.sessionConfig && typeof body.sessionConfig === 'object'
      && !Array.isArray(body.sessionConfig)
      ? body.sessionConfig as Record<string, string | boolean | number | null>
      : {};
    const turnConfig = body.turnConfig && typeof body.turnConfig === 'object'
      && !Array.isArray(body.turnConfig)
      ? body.turnConfig as Record<string, string | boolean | number | null>
      : {};
    try {
      return c.json(await sessions.resolveCatalog(
        executor,
        {
          catalogRevision: body.catalogRevision,
          sessionConfig,
          turnConfig,
        },
        typeof body.sessionId === 'string' ? body.sessionId : undefined,
        cliPath,
      ));
    } catch (error) {
      if (error instanceof ProxyProtocolError && error.code === 'CONFIG_VALUE_INVALID') {
        return c.json({ error: error.message, domainCode: error.code }, 400);
      }
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.get('/api/proxy/:executor/models', async c => {
    const executor = resolvePluginIdInput(decodeURIComponent(c.req.param('executor')));
    if (!executor) return c.json({ error: 'invalid pluginId' }, 400);
    const target = agentCliPath(c, executor);
    if ('error' in target) return c.json({ error: target.error }, 404);
    const cliPath = c.req.query('agent') !== undefined ? target.cliPath : undefined;
    try {
      const catalog = await sessions.warmCapabilities(executor, cliPath);
      const modelOption = catalog.configOptions.find((option) => option.role === 'model');
      return c.json({
        models: (modelOption?.choices ?? []).map((choice) => ({
          id: String(choice.value),
          model: String(choice.value),
          displayName: choice.displayName,
          description: choice.description ?? '',
          hidden: false,
          isDefault: Object.is(choice.value, modelOption?.defaultValue),
        })),
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.get('/api/proxy/:executor/slash', async c => {
    const executor = resolvePluginIdInput(decodeURIComponent(c.req.param('executor')));
    if (!executor) return c.json({ error: 'invalid pluginId' }, 400);
    const target = agentCliPath(c, executor);
    if ('error' in target) return c.json({ error: target.error }, 404);
    const cliPath = c.req.query('agent') !== undefined ? target.cliPath : undefined;
    const workspaceId = c.req.query('workspace');
    const workspace = workspaceId
      ? db.prepare('SELECT path FROM workspaces WHERE id = ?').get(workspaceId) as
          | { path: string }
          | undefined
      : undefined;
    try {
      return c.json(await sessions.listSlashCommands(executor, workspace?.path, cliPath));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });
}
