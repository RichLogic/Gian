import type { Hono } from 'hono';
import type { SystemConfig } from '@gian/shared';
import { loadConfig, saveConfig } from '../../storage/config.js';
import type { Db } from '../../storage/db.js';

export function registerSettingsRoutes(app: Hono, db: Db): void {
  app.get('/api/settings', c => c.json(loadConfig(db)));
  app.patch('/api/settings', async c => {
    saveConfig(db, await c.req.json<Partial<SystemConfig>>());
    return c.json(loadConfig(db));
  });
}
