import type { Hono } from 'hono';
import { DEFAULT_TRANSLATION_PREFERENCES, normalizeComposerDocument } from '@gian/shared';
import type { Db } from '../../storage/db.js';
import { loadConfig } from '../../storage/config.js';
import type { TranslationService } from '../../translation/service.js';

export function registerTranslationRoutes(app: Hono, db: Db, service: TranslationService): void {
  app.use('/api/sessions/:sessionId/translation/*', async (c, next) => {
    if (!db.prepare('SELECT id FROM sessions WHERE id = ?').get(c.req.param('sessionId'))) {
      return c.json({ error: 'Session not found' }, 404);
    }
    await next();
  });
  app.get('/api/sessions/:sessionId/translation/state', c => c.json({
    enabled: service.enabled(c.req.param('sessionId')),
    results: service.list(c.req.param('sessionId')).filter(record => record.purpose === 'read' && !!record.sourceId),
    preferences: loadConfig(db).translation ?? DEFAULT_TRANSLATION_PREFERENCES,
    automatic: Object.fromEntries([...service.automatic].filter(([key]) => key.startsWith(`${c.req.param('sessionId')}:`))
      .map(([key, value]) => [key.slice(c.req.param('sessionId').length + 1), value])),
  }));
  app.patch('/api/sessions/:sessionId/translation/state', async c => {
    const body = await c.req.json();
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled must be boolean' }, 400);
    service.setEnabled(c.req.param('sessionId'), body.enabled);
    return c.json({ enabled: body.enabled });
  });
  app.post('/api/sessions/:sessionId/translation/requests', async c => {
    try {
      const body = await c.req.json();
      if (typeof body.requestId !== 'string' || body.requestId.length > 128 || !body.requestId
        || typeof body.text !== 'string' || (body.purpose !== 'send' && body.purpose !== 'read')
        || (body.sourceId !== undefined && (typeof body.sourceId !== 'string' || body.sourceId.length > 256))) {
        return c.json({ error: 'Invalid translation request' }, 400);
      }
      const document = body.document === undefined ? undefined : normalizeComposerDocument(body.document);
      if (document === null) return c.json({ error: 'Invalid translation document' }, 400);
      const result = await service.translate({
        sessionId: c.req.param('sessionId'), requestId: body.requestId,
        text: body.text, purpose: body.purpose, sourceId: body.sourceId, document,
      }, loadConfig(db).translation ?? { ...DEFAULT_TRANSLATION_PREFERENCES }, c.req.raw.signal);
      return c.json(result);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Translation failed' }, 400);
    }
  });
  app.delete('/api/sessions/:sessionId/translation/requests/:requestId', c => {
    service.cancel(c.req.param('sessionId'), c.req.param('requestId'));
    return c.json({ ok: true });
  });
}
