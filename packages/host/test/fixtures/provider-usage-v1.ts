export const CODEX_APP_SERVER_V2_USAGE = {
  fixtureVersion: 'codex-app-server/v2',
  data: {
    params: {
      tokenUsage: {
        total: {
          inputTokens: 1_000,
          outputTokens: 200,
          cachedInputTokens: 500,
          reasoningOutputTokens: 50,
          cacheWriteInputTokens: 0,
          totalTokens: 1_200,
        },
        last: {
          inputTokens: 90,
          outputTokens: 30,
          cachedInputTokens: 50,
          reasoningOutputTokens: 10,
          cacheWriteInputTokens: 0,
          totalTokens: 120,
        },
        modelContextWindow: 258_000,
      },
    },
  },
} as const;

export const ACP_V0_23_USAGE_UPDATE = {
  fixtureVersion: 'acp/0.23',
  data: {
    update: {
      sessionUpdate: 'usage_update',
      used: 86_397,
      size: 1_048_576,
    },
  },
} as const;

export const UNKNOWN_PROVIDER_USAGE = {
  codex: {
    fixtureVersion: 'codex-app-server/future-unknown',
    data: {
      params: {
        tokenUsage: {
          recent: { promptTokenCount: 120 },
          aggregate: { promptTokenCount: 1_200 },
        },
      },
    },
  },
  acp: {
    fixtureVersion: 'acp/future-unknown',
    data: {
      update: {
        sessionUpdate: 'usage_update',
        consumedTokens: 86_397,
        maximumTokens: 1_048_576,
      },
    },
  },
} as const;

export const MALFORMED_PROVIDER_USAGE = {
  codexPartialV2: {
    fixtureVersion: 'codex-app-server/v2-malformed-partial',
    data: {
      params: {
        tokenUsage: {
          total: { totalTokens: 1_200 },
          last: { totalTokens: 120 },
          modelContextWindow: 258_000,
        },
      },
    },
  },
  acpPartialV0_23: {
    fixtureVersion: 'acp/0.23-malformed-partial',
    data: {
      update: { sessionUpdate: 'usage_update', used: 86_397 },
    },
  },
} as const;
