import { ProxyProtocolError } from '@gian/proxy-protocol';
import type { Hono } from 'hono';
import type { Executor, ProductExecutor } from '@gian/shared';
import type { SessionManager } from '../../session/manager.js';
import type { Db } from '../../storage/db.js';

/** Resolves a saved Agent's runtime (kind, CLI path) for agent-scoped
 *  catalog queries. Wired from AgentManager.agentRuntimePath. */
export type AgentRuntimePathResolver = (agentId: string) => {
  proxy: ProductExecutor;
  cliPath: string | null;
};

const KNOWN_EXECUTORS = new Set(['codex', 'claude', 'kimi', 'grok', 'dsh']);

export function registerProxyRoutes(
  app: Hono,
  db: Db,
  sessions: SessionManager,
  agentPaths?: AgentRuntimePathResolver,
): void {
  /** Optional ?agent=<id> discriminator: the catalog of one Proxy kind can
   *  differ per Agent CLI path, so agent-scoped callers resolve their own
   *  (kind, path) instead of the kind default. */
  const agentCliPath = (c: { req: { query: (name: string) => string | undefined } }):
    | { cliPath: string | null | undefined }
    | { error: string } => {
    const agentId = c.req.query('agent');
    if (agentId === undefined) return { cliPath: undefined };
    if (!agentPaths) return { error: 'agent-scoped catalogs are not available' };
    try {
      return { cliPath: agentPaths(agentId).cliPath };
    } catch {
      return { error: `agent not found: ${agentId}` };
    }
  };

  app.get('/api/proxy/:executor/capabilities', async c => {
    const executor = c.req.param('executor');
    if (!KNOWN_EXECUTORS.has(executor)) {
      return c.json({ error: 'unknown executor' }, 400);
    }
    const target = agentCliPath(c);
    if ('error' in target) return c.json({ error: target.error }, 404);
    const cliPath = c.req.query('agent') !== undefined ? target.cliPath : undefined;
    try {
      const catalog = await sessions.warmCapabilities(executor as Executor, cliPath);
      return c.json({
        ...catalog,
        capabilities: sessions.getProtocolCapabilities(executor, cliPath) ?? {},
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.post('/api/proxy/:executor/catalog/resolve', async c => {
    const executor = c.req.param('executor');
    if (!KNOWN_EXECUTORS.has(executor)) {
      return c.json({ error: 'unknown executor' }, 400);
    }
    const target = agentCliPath(c);
    if ('error' in target) return c.json({ error: target.error }, 404);
    const cliPath = c.req.query('agent') !== undefined ? target.cliPath : undefined;
    try {
      await sessions.warmCapabilities(executor as Executor, cliPath);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
    const advertised = sessions.getProtocolCapabilities(executor, cliPath)?.['catalog.resolve'];
    if (advertised === undefined) {
      return c.json({ error: 'catalog.resolve is not advertised' }, 404);
    }
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
        executor as Executor,
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
    const executor = c.req.param('executor');
    if (executor !== 'codex' && executor !== 'claude') {
      return c.json({ error: 'unknown executor' }, 400);
    }
    const target = agentCliPath(c);
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
    const executor = c.req.param('executor');
    if (executor !== 'codex' && executor !== 'claude') {
      return c.json({ error: 'unknown executor' }, 400);
    }
    const target = agentCliPath(c);
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
