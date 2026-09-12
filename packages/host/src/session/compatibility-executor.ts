import {
  isExecutorId,
  pluginIdForExecutorId,
  type Executor,
  type LegacyExecutorId,
} from '@gian/shared';

function officialExecutor(value: string | null | undefined): LegacyExecutorId | null {
  return value && isExecutorId(value) ? value : null;
}

/** Compatibility-only `sessions.executor` value. Live Session execution
 *  must not branch on this column; use `proxy_plugin_id` / binding. */
export function compatibilityExecutorColumn(input: {
  pluginId: string;
  proxy?: string | null;
}): Executor {
  return officialExecutor(input.proxy) ?? (input.pluginId as Executor);
}

export function pluginIdForSessionIdentity(input: {
  pluginId?: string | null;
  executor: string;
}): string {
  if (input.pluginId) return input.pluginId;
  const official = officialExecutor(input.executor);
  return official ? pluginIdForExecutorId(official) : input.executor;
}

export function officialKindForSession(input: {
  proxy?: string | null;
  executor: string;
}): Executor | null {
  return officialExecutor(input.proxy) ?? officialExecutor(input.executor);
}

export function agentMatchesSessionKind(
  agent: { proxy?: string | null; pluginId: string },
  executor: string,
): boolean {
  if (agent.proxy === executor || agent.pluginId === executor) return true;
  const official = officialExecutor(executor);
  return official !== null && agent.pluginId === pluginIdForExecutorId(official);
}

export function existingNativeSessionSql(): string {
  return `SELECT id, name FROM sessions
          WHERE native_session_id = ?
            AND (
              proxy_plugin_id = ?
              OR (proxy_plugin_id IS NULL AND executor = ?)
            )`;
}

export function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}
