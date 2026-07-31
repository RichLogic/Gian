import type { Hono } from 'hono';
import { listAllBots } from '../../im/bots-api.js';
import type { MessagingPlatform } from '../../im/messaging/types.js';
import type { ProxyManager } from '../../proxy/manager.js';
import type { Db } from '../../storage/db.js';

export function registerReconnectRoutes(
  app: Hono,
  db: Db,
  proxy: ProxyManager,
  platforms: MessagingPlatform[],
): void {
  app.post('/api/reconnect/:component', async c => {
    const component = c.req.param('component');
    if (component === 'codex' || component === 'claude') {
      await proxy.closeByExecutor(component);
      return c.json({ ok: true });
    }
    if (component === 'discord' || component === 'slack') {
      const manager = platforms.find(platform => platform.platformId === component);
      if (!manager) return c.json({ error: `no ${component} platform registered` }, 500);
      const bots = await listAllBots(db);
      const errors: string[] = [];
      for (const bot of bots.filter(candidate => candidate.platform === component && candidate.enabled === 1)) {
        try {
          await manager.stopBot(bot.id);
          await manager.syncBot(bot.id);
        } catch (error) {
          errors.push(`${bot.label}: ${String(error)}`);
        }
      }
      if (errors.length > 0) return c.json({ ok: false, error: errors.join('; ') }, 500);
      return c.json({ ok: true });
    }
    return c.json({ error: 'unknown component' }, 400);
  });
}
