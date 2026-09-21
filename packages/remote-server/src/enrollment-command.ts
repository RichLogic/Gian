import { AUTH_PROTOCOL, MAX_NAME_CHARS, adminCreateEnrollmentResultSchema, parseClosed } from '@gian/remote-protocol';

/** Issue through the running server, never by opening its database or printing admin credentials. */
export async function createEnrollmentFromEnv(
  env: NodeJS.ProcessEnv,
  label?: string,
  fetchFn: typeof fetch = fetch,
) {
  const admin = env.GIAN_REMOTE_ADMIN_TOKEN?.trim();
  if (!admin) throw new Error('GIAN_REMOTE_ADMIN_TOKEN is required in the server environment');
  const publicUrl = new URL(env.GIAN_REMOTE_PUBLIC_ORIGIN ?? '');
  if (!['https:', 'http:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password
      || publicUrl.search || publicUrl.hash || publicUrl.pathname !== '/') {
    throw new Error('GIAN_REMOTE_PUBLIC_ORIGIN must be an HTTP(S) origin');
  }
  const port = Number(env.GIAN_REMOTE_PORT?.trim() || '8787');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid GIAN_REMOTE_PORT');
  if (label !== undefined && (!label.trim() || label.trim().length > MAX_NAME_CHARS)) throw new Error('Invalid enrollment label');
  // The admin endpoint is deliberately blocked by the public reverse proxy.
  const host = env.GIAN_REMOTE_HOST?.trim();
  const loopback = host === '::' || host === '::1' ? '[::1]' : '127.0.0.1';
  let response: Response;
  try {
    response = await fetchFn(`http://${loopback}:${port}/api/v1/admin/host-enrollments`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: AUTH_PROTOCOL, ...(label ? { label: label.trim() } : {}) }),
    });
  } catch {
    throw new Error('Cannot reach the local Remote Server. Run this command in its container or service environment.');
  }
  if (!response.ok) throw new Error(`Enrollment creation failed (HTTP ${response.status}). Check the server admin configuration.`);
  let issued;
  try { issued = parseClosed(adminCreateEnrollmentResultSchema, await response.json()); }
  catch { throw new Error('Remote Server returned an invalid enrollment response'); }
  return {
    server_url: publicUrl.origin,
    enrollment_token: issued.enrollment_token,
    expires_at: new Date(issued.expires_at).toISOString(),
  };
}
