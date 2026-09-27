import { executorIdForPluginId, legacyExecutorFeatures, pluginIdForExecutorId, resolvePluginIdInput, catalogModeSemantics, usesCliCapabilitySurface, type ApprovalMode, type Executor, type NativeSession } from '@gian/shared';
import type { Hono } from 'hono';
import { unlink } from 'node:fs/promises';
import { clearNativeSessionsCache, scanNativeSessions } from '../../native/scanner.js';
import { existingNativeSessionSql } from '../../session/compatibility-executor.js';
import type { SessionManager } from '../../session/manager.js';
import type { Db } from '../../storage/db.js';
import type { WsBroadcaster } from '../ws-broadcast.js';

interface NativeSessionRouteDependencies {
  db: Db;
  sessions: SessionManager;
  broadcaster: WsBroadcaster;
  /** Signed-Catalog plugin enumeration: native-session surfaces gate on the
   *  per-plugin `session.native.*` capability probes below, never on this
   *  list — it only decides which installed plugins to probe. */
  catalogPluginIds?: () => Promise<string[]>;
}

export function registerNativeSessionRoutes(
  app: Hono,
  { db, sessions, catalogPluginIds }: NativeSessionRouteDependencies,
): void {
  const nativeMutations = new Map<string, Promise<void>>();
  const serializeNativeMutation = async <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const previous = nativeMutations.get(key) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => turn, () => turn);
    nativeMutations.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (nativeMutations.get(key) === tail) nativeMutations.delete(key);
    }
  };

  app.post('/api/workspaces/:id/native-sessions/adopt', async c => {
    const workspace = db.prepare('SELECT id, path FROM workspaces WHERE id = ?')
      .get(c.req.param('id')) as { id: string; path: string } | undefined;
    if (!workspace) return c.json({ error: 'workspace not found' }, 404);

    const body = await c.req.json<{
      executor?: Executor;
      native_session_id?: string;
      name?: string;
      approval_mode?: ApprovalMode;
      agent_id?: string;
    }>();
    const executor = typeof body.executor === 'string'
      ? executorIdForPluginId(body.executor)
      : null;
    const nativeId = body.native_session_id;
    // Capability-driven: the adopt service itself requires the plugin's
    // advertised `session.native.list`; no provider allowlist here. A null
    // legacy proxy alias is a pure-plugin Agent, not an unsupported one.
    if (!executor) {
      return c.json({ error: 'executor does not support native session adoption' }, 400);
    }
    if (!nativeId) return c.json({ error: 'native_session_id required' }, 400);

    const approvalMode = body.approval_mode ?? 'ask';
    if ((approvalMode === 'custom' || approvalMode === 'full-access') && executor !== 'codex') {
      return c.json({ error: `${approvalMode} approval mode is codex-only` }, 400);
    }
    // `catalog.modeSemantics`-gated (allowlist fallback for Proxies below the
    // gate): provider-native modes live in the Proxy's own catalog, so the
    // Gian approval_mode preset must be omitted.
    if (
      catalogModeSemantics(executor, null) === 'provider-native'
      && body.approval_mode !== undefined
    ) {
      return c.json({
        error: `${executor} resolves approval through its proxy catalog; approval_mode must be omitted`,
      }, 400);
    }
    return serializeNativeMutation(`${executor}:${nativeId}`, async () => {
      const pluginId = pluginIdForExecutorId(executor);
      const existing = db.prepare(existingNativeSessionSql()).get(nativeId, pluginId, executor) as
        { id: string; name: string | null } | undefined;
      if (existing) {
        return c.json({
          error: `Already adopted as session ${existing.name ?? existing.id}`,
          gian_session_id: existing.id,
        }, 409);
      }

      try {
        const pluginSessions = await sessions.listPluginNativeSessions(executor, workspace.path);
        if (pluginSessions !== null) {
          if (!pluginSessions.some(session => session.id === nativeId)) {
            return c.json({ error: 'native session not found in this workspace' }, 404);
          }
          return c.json(await sessions.adoptPluginNativeSession({
            workspaceId: workspace.id,
            cwd: workspace.path,
            executor,
            nativeSessionId: nativeId,
            approvalMode,
            ...(body.name ? { name: body.name } : {}),
            ...(body.agent_id ? { agentId: body.agent_id } : {}),
          }));
        }
      } catch (error) {
        const value = error as { code?: unknown; sessionId?: unknown; message?: unknown; agents?: unknown };
        const message = typeof value.message === 'string' ? value.message : String(error);
        if (value.code === 'SESSION_ALREADY_EXISTS') {
          return c.json({
            error: message,
            ...(typeof value.sessionId === 'string' ? { gian_session_id: value.sessionId } : {}),
          }, 409);
        }
        if (value.code === 'AGENT_REQUIRED') {
          return c.json({ error: message, code: 'AGENT_REQUIRED', agents: value.agents ?? [] }, 400);
        }
        return c.json({ error: message }, value.code === 'AUTH_REQUIRED' ? 401 : 400);
      }

      if (executor === 'kimi') {
        try {
          return c.json(await sessions.adoptKimiNativeSession({
            workspaceId: workspace.id,
            cwd: workspace.path,
            nativeSessionId: nativeId,
            ...(body.name ? { name: body.name } : {}),
            ...(body.agent_id ? { agentId: body.agent_id } : {}),
          }));
        } catch (error) {
          const value = error as { code?: unknown; sessionId?: unknown; message?: unknown; agents?: unknown };
          const message = typeof value.message === 'string' ? value.message : String(error);
          if (value.code === 'SESSION_ALREADY_EXISTS') {
            return c.json({
              error: message,
              ...(typeof value.sessionId === 'string' ? { gian_session_id: value.sessionId } : {}),
            }, 409);
          }
          if (value.code === 'AGENT_REQUIRED') {
            return c.json({ error: message, code: 'AGENT_REQUIRED', agents: value.agents ?? [] }, 400);
          }
          return c.json({ error: message }, value.code === 'AUTH_REQUIRED' ? 401 : 400);
        }
      }

      const candidates = await scanNativeSessions(workspace.path);
      const native = candidates.find(
        session => session.executor === executor && session.id === nativeId,
      );
      if (!native) return c.json({ error: 'native session not found in this workspace' }, 404);
      if (executor !== 'claude' && executor !== 'codex') {
        return c.json({ error: 'native session not found in this workspace' }, 404);
      }

      try {
        const adopted = await sessions.adoptPluginNativeSession({
          workspaceId: workspace.id,
          cwd: workspace.path,
          executor,
          nativeSessionId: nativeId,
          approvalMode,
          ...(body.name ? { name: body.name } : {}),
          ...(body.agent_id ? { agentId: body.agent_id } : {}),
        });
        clearNativeSessionsCache();
        return c.json(adopted);
      } catch (error) {
        const value = error as {
          code?: unknown;
          sessionId?: unknown;
          message?: unknown;
          agents?: unknown;
        };
        const message = typeof value.message === 'string' ? value.message : String(error);
        if (value.code === 'SESSION_ALREADY_EXISTS') {
          return c.json({
            error: message,
            ...(typeof value.sessionId === 'string' ? { gian_session_id: value.sessionId } : {}),
          }, 409);
        }
        if (value.code === 'AGENT_REQUIRED') {
          return c.json({
            error: message,
            code: 'AGENT_REQUIRED',
            agents: value.agents ?? [],
          }, 400);
        }
        return c.json({ error: message }, value.code === 'AUTH_REQUIRED' ? 401 : 400);
      }
    });
  });

  app.delete('/api/workspaces/:id/native-sessions/:nativeId', async c => {
    const nativeId = c.req.param('nativeId');
    const rawExecutor = c.req.query('executor');
    const executor = rawExecutor ? executorIdForPluginId(rawExecutor) : null;
    // Capability-driven: `deletePluginNativeSession` enforces the plugin's
    // advertised `session.native.delete`; plugins without it fall through to
    // the legacy CLI scan only when the CLI itself owns a Gian-readable
    // history surface (`usesCliCapabilitySurface`).
    if (!executor) {
      return c.json({ error: 'executor does not support native session surfaces' }, 400);
    }
    const workspace = db.prepare('SELECT path FROM workspaces WHERE id = ?')
      .get(c.req.param('id')) as { path: string } | undefined;
    if (!workspace) return c.json({ error: 'workspace not found' }, 404);

    return serializeNativeMutation(`${executor}:${nativeId}`, async () => {
      const adopted = db.prepare(
        `SELECT id, name FROM sessions
         WHERE executor = ? AND native_session_id = ?`,
      ).get(executor, nativeId) as { id: string; name: string | null } | undefined;
      if (adopted) {
        return c.json({
          error: `Native session is currently adopted as ${adopted.name ?? adopted.id}. Delete the Gian session first.`,
          gian_session_id: adopted.id,
        }, 409);
      }

      // Capability-first deletion: the service enforces the plugin's
      // advertised `session.native.delete`. When the plugin has no protocol
      // listing at all and its CLI owns a Gian-readable history surface,
      // fall back to the legacy scan-and-delete path.
      const pluginListed = await sessions
        .listPluginNativeSessions(executor, workspace.path)
        .catch(() => null);
      if (pluginListed !== null || !usesCliCapabilitySurface(executor)) {
        try {
          await sessions.deletePluginNativeSession(executor, nativeId, workspace.path);
          clearNativeSessionsCache();
          return c.json({ ok: true });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return c.json({ error: message }, 400);
        }
      }

      const candidates = await scanNativeSessions(workspace.path);
      const target = candidates.find(
        session => session.executor === executor && session.id === nativeId,
      );
      if (!target) return c.json({ error: 'native session not found in this workspace' }, 404);
      try {
        await unlink(target.filePath);
      } catch (error) {
        return c.json({ error: `Failed to delete: ${String(error)}` }, 500);
      }
      clearNativeSessionsCache();
      return c.json({ ok: true });
    });
  });

  app.get('/api/workspaces/:id/native-sessions', async c => {
    const id = c.req.param('id');
    const workspace = db.prepare('SELECT path FROM workspaces WHERE id = ?')
      .get(id) as { path: string } | undefined;
    if (!workspace) return c.json({ error: 'workspace not found' }, 404);

    const pluginSessions: NativeSession[] = [];
    const legacyExecutors: Array<'claude' | 'codex'> = [];
    // Probe whomever is actually installed: signed-Catalog plugins plus the
    // legacy CLI-surface kinds. The per-plugin `session.native.list`
    // capability decides whether a surface exists — a null probe means "no
    // protocol listing", which routes to the kimi store shim (declared
    // legacy surface) or the legacy disk scan (CLI-surface kinds).
    const catalogIds = catalogPluginIds ? await catalogPluginIds().catch(() => []) : [];
    const candidates = new Set<string>([
      ...catalogIds.map(id => executorIdForPluginId(id) ?? id),
      ...(['claude', 'codex'] as const).filter(kind => usesCliCapabilitySurface(kind)),
    ]);
    for (const candidate of candidates) {
      const executor = executorIdForPluginId(candidate);
      if (!executor) continue;
      try {
        const discovered = await sessions.listPluginNativeSessions(executor, workspace.path);
        if (discovered !== null) {
          pluginSessions.push(...discovered);
          continue;
        }
        // A null probe means the plugin does not advertise
        // `session.native.list`. Kimi's proprietary store stays reachable via
        // its declared legacy surface; CLI-surface kinds fall to the disk scan.
        if (legacyExecutorFeatures(executor)?.nativeSessions === true
          && legacyExecutorFeatures(executor)?.cliCapabilitySurface === false) {
          pluginSessions.push(...await sessions.listKimiNativeSessions(workspace.path));
          continue;
        }
        if (usesCliCapabilitySurface(executor)) legacyExecutors.push(executor);
      } catch (error) {
        console.warn(`[native-sessions] ${candidate} discovery unavailable: ${String(error)}`);
        if (usesCliCapabilitySurface(candidate)) legacyExecutors.push(candidate);
      }
    }
    const diskSessions = legacyExecutors.length > 0
      ? await scanNativeSessions(workspace.path, { executors: legacyExecutors })
      : [];
    const adoptedRows = db.prepare(
      `SELECT id AS gianSessionId, name AS gianSessionName, executor, native_session_id
         FROM sessions
        WHERE workspace_id = ? AND native_session_id IS NOT NULL`,
    ).all(id) as Array<{
      gianSessionId: string;
      gianSessionName: string | null;
      executor: Executor;
      native_session_id: string;
    }>;
    const adopted = new Map(adoptedRows.map(row => [
      `${resolvePluginIdInput(row.executor) ?? row.executor}:${row.native_session_id}`,
      { gianSessionId: row.gianSessionId, gianSessionName: row.gianSessionName },
    ]));

    return c.json({
      sessions: [...diskSessions, ...pluginSessions].map(session => {
        const binding = adopted.get(`${session.executor}:${session.id}`);
        return binding ? { ...session, adoptedBy: binding } : session;
      }),
    });
  });
}
