import { connect } from 'node:net';
import { join } from 'node:path';

export type DevEnvironment = 'dev' | 'prod';

export function environmentSettings(environment: DevEnvironment, home: string) {
  if (environment !== 'dev' && environment !== 'prod') throw new Error('Unknown GianDev environment');
  return {
    dataDir: join(home, environment === 'prod' ? '.gian' : '.gian-dev'),
    title: `GianDev · ${environment === 'prod' ? 'Prod' : 'Dev'}`,
  };
}

// Only an explicit refusal proves the port is unused; timeouts/errors fail closed.
export function portIsOccupied(port: number, hostname = '127.0.0.1'): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: hostname, port });
    const finish = (occupied: boolean) => { socket.destroy(); resolve(occupied); };
    socket.setTimeout(1000, () => finish(true));
    socket.once('connect', () => finish(true));
    socket.once('error', (error: NodeJS.ErrnoException) => finish(error.code !== 'ECONNREFUSED'));
  });
}

export async function productionHostIsOccupied(probe = portIsOccupied) {
  return await probe(8990) || await probe(8990, '::1');
}
