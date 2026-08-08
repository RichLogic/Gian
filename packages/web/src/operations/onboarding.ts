/**
 * UI Operation Layer — Onboarding-domain definitions (Phase 3b of
 * `docs/archive/proposals/ui-operation-layer.md`): `onboarding.saveProjectRoot` and
 * `onboarding.complete`, both PENDING REST. The OnboardingView finish chain
 * sequences them (save → complete) with `waitForRunSettle`; each result is
 * recorded on the run (`run.result`) — the saved root for the input's
 * normalization echo, the final OnboardingState for the App's gate.
 */
import type { OnboardingProjectRootResult, OnboardingState } from '@gian/shared';

import { completeOnboarding, saveOnboardingProjectRoot } from '../api.js';
import { registry } from './registry.js';
import type { OperationDefinition } from './types.js';

/** REST round-trips are normally well under this; expiry marks the outcome
 *  unknown (never failed) per proposal §4.3. */
const REST_TIMEOUT_MS = 15_000;

const onboardingSaveProjectRoot: OperationDefinition<{ path: string }, OnboardingProjectRootResult> = {
  policy: 'pending',
  entityKey: () => 'onboarding:project-root',
  execute: input => saveOnboardingProjectRoot(input.path),
  timeoutMs: REST_TIMEOUT_MS,
};

const onboardingComplete: OperationDefinition<Record<string, never>, OnboardingState> = {
  policy: 'pending',
  entityKey: () => 'onboarding:complete',
  execute: () => completeOnboarding(),
  timeoutMs: REST_TIMEOUT_MS,
};

registry.register('onboarding.saveProjectRoot', onboardingSaveProjectRoot);
registry.register('onboarding.complete', onboardingComplete);
