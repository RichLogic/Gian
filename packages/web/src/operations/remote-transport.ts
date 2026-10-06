/** Remote REST transport used by registered operations and read-only queries. */
export class RemoteRequestError extends Error {
  constructor(readonly status: number) {
    super('Remote request failed (' + status + ')');
  }
}

export async function remoteRequest<T>(path: string, body?: unknown, method?: 'DELETE'): Promise<T> {
  const response = await fetch('/api/remote' + path, { credentials: 'same-origin', cache: 'no-store',
    ...(method === 'DELETE' ? { method: 'DELETE' } : {}),
    ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  if (!response.ok) throw new RemoteRequestError(response.status);
  return response.json() as Promise<T>;
}

