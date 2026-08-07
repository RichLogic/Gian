export interface HealthPayload {
  ok: true;
  version: string;
  instanceId?: string;
  devRuntimeId?: string;
  devWorktree?: string;
}

export function buildHealthPayload(
  env: Readonly<Record<string, string | undefined>> = process.env,
): HealthPayload {
  const instanceId = env['GIAN_DESKTOP_INSTANCE_ID']?.trim();
  const devRuntimeId = env['GIAN_DEV_RUNTIME_ID']?.trim();
  const devWorktree = env['GIAN_DEV_WORKTREE']?.trim();
  return {
    ok: true,
    version: env['GIAN_RELEASE_VERSION']?.trim() || '0.1.0',
    ...(instanceId ? { instanceId } : {}),
    ...(devRuntimeId ? { devRuntimeId } : {}),
    ...(devWorktree ? { devWorktree } : {}),
  };
}
