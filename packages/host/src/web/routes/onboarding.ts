import type { Hono } from 'hono';
import type { AgentManager } from '../../agents/manager.js';
import type { Db } from '../../storage/db.js';
import {
  buildOnboardingState,
  hasReadyAgent,
  markOnboardingComplete,
  resetOnboarding,
  saveOnboardingProjectRoot,
} from '../../onboarding/state.js';
import { syncAgentInstructionBlocks } from '../../onboarding/agent-instructions.js';
import { expandHome } from '../../workspace/index.js';

function errorResponse(error: unknown): { error: string } {
  return { error: error instanceof Error ? error.message : String(error) };
}

export function registerOnboardingRoutes(
  app: Hono,
  options: {
    db: Db;
    agents: AgentManager;
    /** Test seam for proving the completion route triggers the same managed
     * instruction sync used at host startup without writing into real homes. */
    syncAgentInstructions?: typeof syncAgentInstructionBlocks;
  },
): void {
  app.get('/api/onboarding', async c => c.json(
    await buildOnboardingState(options.db, await options.agents.listAgentStatuses()),
  ));

  app.put('/api/onboarding/project-root', async c => {
    try {
      const body = await c.req.json<{ path?: unknown }>();
      if (typeof body.path !== 'string') {
        return c.json({ error: 'path must be a string' }, 400);
      }
      return c.json(await saveOnboardingProjectRoot(options.db, body.path));
    } catch (error) {
      return c.json(errorResponse(error), 400);
    }
  });

  app.post('/api/onboarding/complete', async c => {
    try {
      const agents = await options.agents.listAgentStatuses();
      if (!hasReadyAgent(agents)) {
        return c.json({ error: 'Set up at least one Agent before continuing.' }, 409);
      }
      const config = await saveOnboardingProjectRoot(
        options.db,
        (await buildOnboardingState(options.db, agents)).projectRoot,
      );
      markOnboardingComplete(options.db);
      // The project root was just (re)confirmed — refresh the managed
      // block in every agent CLI's global instruction file. A failure here
      // must not fail onboarding.
      try {
        await (options.syncAgentInstructions ?? syncAgentInstructionBlocks)(
          expandHome(config.projectRoot),
        );
      } catch (error) {
        console.warn('[gian] agent instruction sync failed:', error);
      }
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
