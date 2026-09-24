import type { RemoteIdentityMaterial } from '../../src/remote/identity.js';
import { authorizeSigningAccount, withControllerAccount } from '../../../remote-server/test/fixture.js';

export async function authenticatedRemoteFixture(
  fetch: (path: string, init?: RequestInit) => Promise<Response>,
  identity: RemoteIdentityMaterial,
  origin: string,
) {
  const publicIdentity = await identity.ensurePublic();
  const account = await authorizeSigningAccount(fetch, 'host', publicIdentity.public_key, bytes => identity.sign(bytes));
  await identity.setAccountSession!(origin, { ...account, role: 'host', serverOrigin: origin }, 'host');
  const controllerFetch = await withControllerAccount(fetch);
  return (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (path === '/api/v1/host-enrollments/claim') headers.set('x-gian-account-token', account.token);
    return controllerFetch(path, { ...init, headers });
  };
}
