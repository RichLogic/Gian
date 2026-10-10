import { connectRemoteEnvironment, removeRemoteEnvironment } from '../api.js';
import type { OperationDispatcher } from './dispatcher.js';
import { registry } from './registry.js';
import type { OperationDefinition } from './types.js';

interface RemoteEnvironmentOperation {
  id?: string;
  connection?: { server_url: string; code: string; name: string };
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

for (const name of ['remote.connectEnvironment', 'remote.removeEnvironment'] as const) {
  const operation: OperationDefinition<RemoteEnvironmentOperation, unknown> = {
    policy: 'pending', entityKey: input => `remote-environment:${input.id ?? input.connection?.server_url ?? ''}`,
    execute: async input => {
      try {
        const result = name === 'remote.connectEnvironment'
          ? await connectRemoteEnvironment(input.connection!)
          : await removeRemoteEnvironment(input.id!);
        input.resolve(result);
        return result;
      } catch (error) { input.reject(error); throw error; }
    },
    timeoutMs: 30_000,
  };
  registry.register(name, operation);
}

export function dispatchRemoteEnvironment(
  dispatch: OperationDispatcher['dispatch'] | null,
  input: Pick<RemoteEnvironmentOperation, 'id' | 'connection'>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!dispatch) { reject(new Error('Remote environment controls are unavailable.')); return; }
    try { dispatch(input.connection ? 'remote.connectEnvironment' : 'remote.removeEnvironment', { ...input, resolve, reject }); }
    catch (error) { reject(error); }
  });
}
