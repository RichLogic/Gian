import type { Hono } from 'hono';
import type { AgentManager } from '../../agents/manager.js';
import type { Db } from '../../storage/db.js';
import {
  buildOnboardingState,
  markOnboardingComplete,
  resetOnboarding,
  saveOnboardingWorkspace,
} from '../../onboarding/state.js';

function errorResponse(error: unknown): { error: string } {
  return { error: error instanceof Error ? error.message : String(error) };
}

export function registerOnboardingRoutes(
  app: Hono,
  options: { db: Db; agents: AgentManager },
): void {
  app.get('/api/onboarding', async c => c.json(
    await buildOnboardingState(options.db, await options.agents.list()),
  ));

  app.put('/api/onboarding/workspace', async c => {
    try {
      const body = await c.req.json<{ path?: unknown }>();
      if (typeof body.path !== 'string') {
        return c.json({ error: 'path must be a string' }, 400);
      }
      return c.json(await saveOnboardingWorkspace(options.db, body.path));
    } catch (error) {
      return c.json(errorResponse(error), 400);
    }
  });

  app.post('/api/onboarding/complete', async c => {
    try {
      const agents = await options.agents.list();
      const missing = agents.filter(agent => !agent.ready).map(agent => agent.name);
      if (missing.length > 0) {
        return c.json({ error: `Agents still require setup: ${missing.join(', ')}` }, 409);
      }
      const config = await saveOnboardingWorkspace(
        options.db,
        (await buildOnboardingState(options.db, agents)).workspaceRoot,
      );
      markOnboardingComplete(options.db);
      return c.json({
        ...(await buildOnboardingState(options.db, agents)),
        ...config,
        completed: true,
      });
    } catch (error) {
      return c.json(errorResponse(error), 400);
    }
  });

  app.post('/api/onboarding/reset', c => {
    resetOnboarding(options.db);
    return c.json({ ok: true });
  });
}
