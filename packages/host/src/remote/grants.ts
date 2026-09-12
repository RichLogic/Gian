import type { GianToolMethod } from '@gian/shared';

/** Exact V1 Remote device Tool grants from the Remote Web proposal §5.4. */
export const DEFAULT_REMOTE_DEVICE_GRANTS = [
  'catalog.get_create_options',
  'session.read',
  'session.create',
  'session.update',
  'session.send',
  'session.stop',
  'queue.update',
  'queue.remove',
  'queue.clear',
  'queue.send_now',
  'interaction.respond',
] as const satisfies readonly GianToolMethod[];

export const FORBIDDEN_REMOTE_DEVICE_GRANTS = [
  'task.create',
  'task.update',
  'session.assign_task',
  'session.set_subtask_state',
  'session.archive',
  'worktree.create_and_bind',
] as const satisfies readonly GianToolMethod[];

export function defaultRemoteDeviceGrants(): GianToolMethod[] {
  return [...DEFAULT_REMOTE_DEVICE_GRANTS];
}

export function assertExactRemoteGrants(grants: readonly string[]): GianToolMethod[] {
  const unique = [...new Set(grants)];
  if (unique.length !== DEFAULT_REMOTE_DEVICE_GRANTS.length) {
    throw new Error('Remote device grants must match the V1 default set exactly');
  }
  for (const method of DEFAULT_REMOTE_DEVICE_GRANTS) {
    if (!unique.includes(method)) {
      throw new Error(`Remote device grants missing ${method}`);
    }
  }
  for (const method of unique) {
    if ((FORBIDDEN_REMOTE_DEVICE_GRANTS as readonly string[]).includes(method)) {
      throw new Error(`Remote devices cannot receive ${method}`);
    }
    if (!(DEFAULT_REMOTE_DEVICE_GRANTS as readonly string[]).includes(method)) {
      throw new Error(`unknown Remote device grant: ${method}`);
    }
  }
  return unique as GianToolMethod[];
}
