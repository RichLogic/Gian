/**
 * Fully code-generated synthetic ZCode CLI config for throwaway probe/test
 * HOMEs. Validated against the REAL ZCode 0.16.5 app-server
 * (session/create + session/read, no provider call — see
 * test/real-app-server-lifecycle.canary.ts — explicit canary entry).
 *
 * Schema facts (static: zcode.cjs 0.16.5 config schema, empirically confirmed):
 *  - `model.main` MUST be a `providerId/modelId` reference
 *    (`Yhr`: a "/" at a non-leading, non-trailing position) — a bare model id
 *    fails the ref refine and the whole model section parses to undefined,
 *    which surfaces as `model_config_missing`.
 *  - `provider` is `record(string, entry)`; arbitrary keys are allowed.
 *  - entry.kind ∈ anthropic | openai | openai-compatible (openai-compatible
 *    is the honest choice for a synthetic endpoint).
 *  - entry.options: {apiKey?, baseURL?, apiKeyRequired?} (min length 1 when
 *    present).
 *
 * Every value is a marked dummy; the baseURL points at an unreachable
 * loopback port so no real endpoint is ever contacted. Nothing here is
 * derived from any user configuration.
 */

export const SYNTHETIC_PROVIDER_ID = 'wp0-synthetic';
export const SYNTHETIC_MODEL_ID = 'wp0-dummy-model';
export const SYNTHETIC_MODEL_REF = `${SYNTHETIC_PROVIDER_ID}/${SYNTHETIC_MODEL_ID}`;

export function buildSyntheticZcodeConfig() {
  return {
    model: {
      main: SYNTHETIC_MODEL_REF,
    },
    provider: {
      [SYNTHETIC_PROVIDER_ID]: {
        kind: 'openai-compatible',
        name: 'WP0 Synthetic Provider (not a real endpoint)',
        options: {
          apiKeyRequired: false,
          baseURL: 'http://127.0.0.1:9/unreachable',
          apiKey: 'DUMMY-NOT-A-SECRET',
        },
        models: {
          [SYNTHETIC_MODEL_ID]: {
            name: 'WP0 Dummy Model',
            contextWindow: 128000,
            maxOutputTokens: 8192,
            reasoning: false,
            tool_call: false,
          },
        },
      },
    },
  };
}
