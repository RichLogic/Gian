/**
 * UI Operation Layer — Settings-domain definitions (Phase 3b of
 * `docs/archive/proposals/ui-operation-layer.md`).
 *
 * - `settings.save` (OPTIMISTIC, REST `saveSettings`): every SettingsBody
 *   toggle/select and the debounced editor-list autosave render the expected
 *   value immediately as field overlays on the `settings:system` entity
 *   (proposal §4.3). The 500 ms editor-list debounce stays in the view — the
 *   operation only ever sees the final write. The host does NOT broadcast
 *   settings PATCHes (inventory §4 note 7), so `reconcile` pushes the
 *   response entity into canonical state through the injected sink
 *   (`wireSettingsSink`, wired by App); the overlay absorbs on result
 *   arrival. An explicit failure rolls the overlay back (the prior value is
 *   restored) and toasts — a visible save failure, never a silent wait.
 * - `settings.resetOnboarding` (PENDING, REST `resetOnboarding`): the
 *   account-section "reconfigure" action. `reconcile` preserves the
 *   pre-migration completion behavior: `window.location.reload()`.
 *
 * Rendering merges `canonical + overlays` via `applySettingsOverlays` (hook
 * `useStoreSettingsWithOverlays` in use-operations.ts); App feeds the merged
 * config to SettingsBody and the theme/density side-effect so optimistic
 * writes apply in the same task they dispatch.
 */
import type { SystemConfig } from '@gian/shared';

import { resetOnboarding, saveSettings } from '../api.js';
import { toast } from '../feedback.js';
import { registry } from './registry.js';
import type { OperationDefinition, OptimisticOverlay } from './types.js';

/** Entity key of the single system-config entity. */
export const SETTINGS_ENTITY_KEY = 'settings:system';
/** Distinct key for the onboarding reset — never collides with a save. */
export const SETTINGS_ONBOARDING_ENTITY_KEY = 'settings:onboarding';

/** REST round-trips are normally well under this; expiry marks the outcome
 *  unknown (never failed) per proposal §4.3. */
const REST_TIMEOUT_MS = 10_000;

/**
 * Canonical settings sink (see header) — wired by App with the canonical
 * `setSystemConfig`; tests substitute a fake.
 */
export interface SettingsCanonicalSink {
  /** The host returned the full post-patch config — replace canonical state. */
  saved(config: SystemConfig): void;
}

let settingsCanonicalSink: SettingsCanonicalSink | null = null;

export function wireSettingsSink(sink: SettingsCanonicalSink | null): void {
  settingsCanonicalSink = sink;
}

const settingsSave: OperationDefinition<{ patch: Partial<SystemConfig> }, SystemConfig> = {
  policy: 'optimistic',
  entityKey: () => SETTINGS_ENTITY_KEY,
  // One overlay per patched field; a repeated write to the same field
  // supersedes in place (proposal §4.3).
  optimisticWrites: input =>
    Object.entries(input.patch).map(([field, value]) => ({ field, value })),
  execute: async input => {
    const saved = await saveSettings(input.patch);
    if (!saved) throw new Error('Settings save failed');
    return saved;
  },
  reconcile: saved => settingsCanonicalSink?.saved(saved),
  // The overlay rollback is the store's job; surface the failure here.
  rollback: error => toast({ kind: 'error', message: error.message }),
  timeoutMs: REST_TIMEOUT_MS,
};

const settingsResetOnboarding: OperationDefinition<Record<string, never>> = {
  policy: 'pending',
  entityKey: () => SETTINGS_ONBOARDING_ENTITY_KEY,
  execute: async () => {
    await resetOnboarding();
  },
  // Pre-migration completion behavior: a full reload re-enters the app
  // through the onboarding gate.
  reconcile: () => { window.location.reload(); },
  rollback: error => toast({ kind: 'error', message: error.message }),
  timeoutMs: REST_TIMEOUT_MS,
};

registry.register('settings.save', settingsSave);
registry.register('settings.resetOnboarding', settingsResetOnboarding);

/**
 * Render merge (proposal §4.3): `canonical + overlays`, the overlay always
 * winning. Returns the canonical object untouched when no overlay applies,
 * so unchanged configs keep referential identity.
 */
export function applySettingsOverlays(
  config: SystemConfig | null,
  overlays: readonly OptimisticOverlay[],
): SystemConfig | null {
  if (!config) return config;
  let merged: SystemConfig | null = null;
  for (const overlay of overlays) {
    const field = overlay.entityFieldKey.slice(SETTINGS_ENTITY_KEY.length + 1);
    if (!field) continue;
    if (merged === null) merged = { ...config };
    (merged as unknown as Record<string, unknown>)[field] = overlay.value;
  }
  return merged ?? config;
}
