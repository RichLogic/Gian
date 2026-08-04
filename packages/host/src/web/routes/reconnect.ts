import type { Hono } from 'hono';
import type { ProxyManager } from '../../proxy/manager.js';

export function registerReconnectRoutes(
  app: Hono,
  proxy: ProxyManager,
): void {
  app.post('/api/reconnect/:component', async c => {
    const component = c.req.param('component');
    if (component === 'codex' || component === 'claude') {
      await proxy.closeByExecutor(component);
      return c.json({ ok: true });
    }
    return c.json({ error: 'unknown component' }, 400);
  });
}
