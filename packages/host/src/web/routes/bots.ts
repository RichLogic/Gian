import type { BotExtra, BotMode, IMPlatform } from '@gian/shared';
import type { Hono } from 'hono';
import {
  createNewBot,
  deleteBotRow,
  getBotById,
  listAllBots,
  setBotEnabled,
  updateBotFields,
} from '../../im/bots-api.js';
import type { MessagingPlatform } from '../../im/messaging/types.js';
import type { Db } from '../../storage/db.js';

export function registerBotRoutes(
  app: Hono,
  db: Db,
  platforms: MessagingPlatform[],
): void {
  app.get('/api/bots', async c => c.json(await listAllBots(db)));

  app.post('/api/bots', async c => {
    const body = await c.req.json<{
      label?: string;
      platform?: IMPlatform;
      workspace_id?: string | null;
      mode?: BotMode;
      allowed_user_id?: string | null;
      extra?: BotExtra;
    }>();
    if (!body.label || !body.platform) {
      return c.json({ error: 'label and platform required' }, 400);
    }
    if (body.platform !== 'discord' && body.platform !== 'slack') {
      return c.json({ error: 'platform must be discord or slack' }, 400);
    }
    if (!body.extra) {
      return c.json({ error: 'extra (token / channel) required' }, 400);
    }
    try {
      const bot = await createNewBot(db, {
        label: body.label,
        platform: body.platform,
        workspace_id: body.workspace_id ?? null,
        allowed_user_id: body.allowed_user_id ?? null,
        extra: body.extra,
      });
      return c.json(bot, 201);
    } catch (error) {
      return c.json({ error: String(error) }, 400);
    }
  });

  app.patch('/api/bots/:id', async c => {
    const id = c.req.param('id');
    if (!await getBotById(db, id)) return c.json({ error: 'bot not found' }, 404);
    const body = await c.req.json<{
      label?: string;
      workspace_id?: string | null;
      mode?: BotMode;
      allowed_user_id?: string | null;
      extra?: BotExtra;
    }>();
    const updated = await updateBotFields(db, id, {
      ...(body.label !== undefined ? { label: body.label } : {}),
      ...('workspace_id' in body ? { workspace_id: body.workspace_id ?? null } : {}),
      ...('allowed_user_id' in body ? { allowed_user_id: body.allowed_user_id ?? null } : {}),
      ...(body.extra !== undefined ? { extra: body.extra } : {}),
    });
    return c.json(updated);
  });

  app.delete('/api/bots/:id', async c => {
    const id = c.req.param('id');
    const existing = await getBotById(db, id);
    if (!existing) return c.json({ error: 'bot not found' }, 404);
    if (existing.enabled === 1) {
      const manager = platforms.find(platform => platform.platformId === existing.platform);
      if (manager) {
        try {
          await manager.stopBot(id);
        } catch (error) {
          console.warn(`[im] stopBot failed during delete: ${String(error)}`);
        }
      }
    }
    return c.json({ ok: deleteBotRow(db, id, existing.platform) });
  });

  app.post('/api/bots/:id/toggle', async c => {
    const id = c.req.param('id');
    const existing = await getBotById(db, id);
    if (!existing) return c.json({ error: 'bot not found' }, 404);
    await setBotEnabled(db, id, existing.enabled !== 1);
    const manager = platforms.find(platform => platform.platformId === existing.platform);
    if (manager) {
      try {
        await manager.syncBot(id);
      } catch (error) {
        console.warn(`[im] syncBot failed: ${String(error)}`);
      }
    }
    return c.json(await getBotById(db, id));
  });
}
