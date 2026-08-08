/** ACP SDK 0.23 PromptResponse usage shape consumed by Gian's Kimi adapter. */
export const ACP_V0_23_PROMPT_USAGE = {
  fixtureVersion: 'acp/0.23',
  usage: {
    inputTokens: 1_100_000,
    outputTokens: 14_000,
    cachedReadTokens: 900_000,
    cachedWriteTokens: 10_000,
    thoughtTokens: null,
    totalTokens: 1_114_000,
  },
} as const;

export const ACP_UNKNOWN_PROMPT_USAGE = {
  fixtureVersion: 'acp/future-unknown',
  usage: {
    promptTokenCount: 1_100_000,
    completionTokenCount: 14_000,
  },
} as const;

export const ACP_MALFORMED_V0_23_PROMPT_USAGE = {
  fixtureVersion: 'acp/0.23-malformed-partial',
  usage: {
    inputTokens: 1_100_000,
    outputTokens: 14_000,
    // totalTokens is required by ACP 0.23; omitting it must not create an
    // absolute snapshot whose missing counters get replaced with zero.
  },
} as const;

/** ACP 0.23 command-driven compaction samples used by Kimi. */
export const ACP_V0_23_COMPACTION = {
  fixtureVersion: 'acp/0.23-compaction',
  compactCommand: '/compact',
  futureCommand: '/future-compact',
  summarizationUsageUpdate: {
    sessionUpdate: 'usage_update',
    used: 999_999,
    size: 1_048_576,
  },
  summarizationMessage: {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Compacted.' },
  },
  postBoundaryStatusChunks: [
    {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Context: 86,397 / ' },
    },
    {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '1,048,576 (8.2%)' },
    },
  ],
  promptUsage: ACP_V0_23_PROMPT_USAGE.usage,
} as const;
