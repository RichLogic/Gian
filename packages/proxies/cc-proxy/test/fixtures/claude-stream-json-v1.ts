/** Captured shape contract for Claude Code `--output-format stream-json` v1. */
export const CLAUDE_STREAM_JSON_V1 = {
  fixtureVersion: 'claude-stream-json/v1',
  assistant: {
    type: 'assistant',
    message: {
      model: 'claude-opus-4-8[1m]',
      usage: {
        input_tokens: 120,
        cache_read_input_tokens: 62_000,
        cache_creation_input_tokens: 880,
        output_tokens: 450,
      },
    },
  },
  result: {
    type: 'result',
    usage: {
      input_tokens: 200,
      cache_read_input_tokens: 90_000,
      cache_creation_input_tokens: 1_000,
      output_tokens: 2_000,
    },
    modelUsage: {
      'claude-opus-4-8[1m]': {
        contextWindow: 1_000_000,
      },
    },
  },
} as const;

/** A future/unknown shape must remain unknown instead of becoming zero usage. */
export const CLAUDE_STREAM_JSON_UNKNOWN = {
  fixtureVersion: 'claude-stream-json/future-unknown',
  assistant: {
    type: 'assistant',
    message: {
      model: 'claude-future',
      usage: { promptTokenCount: 1234 },
    },
  },
  result: {
    type: 'result',
    usage: { promptTokenCount: 1234, completionTokenCount: 56 },
  },
} as const;

export const CLAUDE_STREAM_JSON_MALFORMED_V1 = {
  fixtureVersion: 'claude-stream-json/v1-malformed-partial',
  assistant: {
    type: 'assistant',
    message: {
      model: 'claude-opus-4-8[1m]',
      usage: {
        input_tokens: 120,
        cache_read_input_tokens: '62000',
      },
    },
  },
  result: {
    type: 'result',
    usage: {
      input_tokens: 200,
      // output_tokens is required by the v1 aggregate shape.
    },
  },
} as const;

export const CLAUDE_STREAM_JSON_MALFORMED_MODEL_USAGE_V1 = {
  fixtureVersion: 'claude-stream-json/v1-malformed-model-usage',
  mixedCompleteAndPartial: {
    type: 'result',
    modelUsage: {
      'claude-opus-4-8': {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 50,
        cacheCreationInputTokens: 5,
      },
      'claude-haiku-4-5': {
        inputTokens: 30,
      },
    },
  },
  partialWithValidTopLevelFallback: {
    type: 'result',
    modelUsage: {
      'claude-opus-4-8': { inputTokens: 100 },
    },
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 5,
    },
  },
} as const;

/** Claude stream-json v1 compaction lifecycle captured at the runtime seam. */
export const CLAUDE_STREAM_JSON_V1_COMPACTION = {
  fixtureVersion: 'claude-stream-json/v1-compaction',
  preBoundary: {
    type: 'assistant',
    message: {
      model: 'claude-opus-4-8',
      usage: {
        input_tokens: 180_000,
        output_tokens: 20,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      content: [],
    },
  },
  boundary: { type: 'system', subtype: 'compact_boundary' },
  postBoundary: {
    type: 'result',
    subtype: 'success',
    result: '',
    usage: {
      input_tokens: 100,
      output_tokens: 25,
      cache_read_input_tokens: 1_000,
      cache_creation_input_tokens: 0,
    },
    modelUsage: {
      'claude-opus-4-8': {
        inputTokens: 100,
        outputTokens: 25,
        cacheReadInputTokens: 1_000,
        cacheCreationInputTokens: 0,
        contextWindow: 200_000,
      },
    },
  },
  futureBoundary: { type: 'system', subtype: 'future_compaction_boundary' },
} as const;
