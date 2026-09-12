/**
 * Development-only entry for the Remote Settings fixture.
 *
 * Production builds never include the fixture: `import.meta.env.DEV` is
 * statically `false` under `vite build`, so Rollup drops the dynamic import
 * (and with it `fixture.ts`) from the bundle. The real production adapter is
 * the Host remote subsystem wiring tracked by Issue #137; until then a
 * production build gets `null` and the section renders its unavailable state.
 */

import type { RemoteSettingsController } from './types.js';

export async function createDevRemoteSettingsController(): Promise<RemoteSettingsController | null> {
  if (!import.meta.env.DEV) return null;
  const { createRemoteSettingsFixture } = await import('./fixture.js');
  return createRemoteSettingsFixture();
}
