import type { Context, Hono } from 'hono';
import type { RemoteRuntime } from './runtime.js';

/** Settings is local-Host authenticated. No Remote Server admin token enters the renderer. */
export function registerRemoteSettingsRoutes(app: Hono, remote: RemoteRuntime): void {
  app.use('/api/remote/*', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    await next();
  });
  app.get('/api/remote/settings', context => context.json(remote.settingsState()));
  const mutate = <T>(action: (context: Context) => T | Promise<T>, fields?: (result: T) => object) => async (context: Context) => {
    try {
      const result = await action(context);
      return context.json({ ok: true, ...fields?.(result), ...remote.settingsState() });
    } catch (error) {
      // Never echo tokens, credential-bearing URLs, or remote response bodies.
      const safe = ['invalid_url', 'already_enrolled', 'not_enrolled', 'identity_changed',
        'pairing_busy', 'connection_cancelled', 'pairing_not_found', 'invalid_host_name'];
      const message = error instanceof Error && safe.includes(error.message)
        ? error.message : 'remote_action_failed';
      return context.json({ error: message }, 400);
    }
  };
  const body = (context: Context) => context.req.json<Record<string, unknown>>()
    .catch(() => ({} as Record<string, unknown>));

  app.post('/api/remote/enroll', mutate(async context => {
    const input = await body(context);
    if (typeof input.server_url !== 'string' || typeof input.enrollment_token !== 'string'
        || !input.enrollment_token.trim() || input.enrollment_token.length > 4096
        || (input.public_url !== undefined && typeof input.public_url !== 'string')) {
      throw new Error('invalid_enrollment');
    }
    await remote.enroll({
      serverUrl: input.server_url, enrollmentToken: input.enrollment_token,
      ...(typeof input.public_url === 'string' && input.public_url ? { publicUrl: input.public_url } : {}),
    });
  }));
  app.post('/api/remote/disconnect', mutate(() => remote.disconnect()));
  app.post('/api/remote/reconnect', mutate(() => remote.reconnect()));
  app.post('/api/remote/disable', mutate(() => remote.disableRemote()));
  app.post('/api/remote/host-name', mutate(async context => {
    const input = await body(context);
    if (typeof input.host_name !== 'string') throw new Error('invalid_host_name');
    await remote.setHostName(input.host_name);
  }));
  app.post('/api/remote/public-url', mutate(async context => {
    const input = await body(context);
    if (typeof input.public_url !== 'string') throw new Error('invalid_url');
    remote.setPublicUrl(input.public_url);
  }));

  app.post('/api/remote/pairings', async context => {
    try { return context.json(await remote.createPairingGrant()); }
    catch { return context.json({ error: 'remote_action_failed' }, 400); }
  });
  app.post('/api/remote/pairings/:id/confirm', mutate(context =>
    remote.confirmPairing(context.req.param('id')!, 'confirm'), result => result));
  app.post('/api/remote/pairings/:id/reject', mutate(context =>
    remote.confirmPairing(context.req.param('id')!, 'reject'), result => result));
  app.post('/api/remote/pairings/:id/cancel', mutate(context =>
    remote.cancelPairing(context.req.param('id')!)));
  app.post('/api/remote/devices/:id/revoke', mutate(context =>
    remote.revokeDevice(context.req.param('id')!), device => ({
      id: device.id, revoked_at: device.revokedAt, revision: device.revision,
    })));
  app.get('/api/remote/devices/:id/audit', context =>
    context.json({ entries: remote.audit.list(context.req.param('id')) }));
  app.post('/api/remote/enrollment/confirm-identity', mutate(async context => {
    const input = await body(context);
    if (typeof input.expected_fingerprint !== 'string') throw new Error('identity_changed');
    await remote.confirmServerIdentityChange(input.expected_fingerprint);
  }));
  app.post('/api/remote/enrollment/reject-identity', mutate(() => remote.rejectServerIdentityChange()));
}
