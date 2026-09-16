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

/** ACP 0.23 command-driven compaction samples used by Kimi CLI 0.41. */
export const ACP_V0_23_COMPACTION = {
  fixtureVersion: 'acp/0.23-compaction-kimi-0.41',
  compactCommand: '/compact',
  futureCommand: '/future-compact',
  usageCommand: '/usage',
  statusCommand: '/status',
  summarizationUsageUpdate: {
    sessionUpdate: 'usage_update',
    used: 999_999,
    size: 1_048_576,
  },
  summarizationMessage: {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Compacted.' },
  },
  // Kimi CLI 0.41 /status prints only identity lines; the Context line moved
  // to /usage (usageText(), e.g. "Context: 86397 / 1048576 tokens (8%)").
  statusChunks: [
    {
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'text',
        text: 'Session: native-usage\nModel: kimi-for-coding\nMode: agent\nWorking directory: /workspace/usage',
      },
    },
  ],
  usageChunks: [
    {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Context: 86,397 / ' },
    },
    {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '1,048,576 tokens (8.2%)' },
    },
  ],
  // 0.41 also emits a fire-and-forget structured usage_update after every
  // turn; it races with the hidden post-turn /usage capture window.
  postTurnUsageUpdate: {
    sessionUpdate: 'usage_update',
    used: 86_397,
    size: 1_048_576,
  },
  promptUsage: ACP_V0_23_PROMPT_USAGE.usage,
} as const;

/** Pre-0.41 Kimi CLI: /status itself printed the Context line. */
export const ACP_PRE_041_STATUS_CONTEXT_CHUNKS = [
  {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Context: 86,397 / ' },
  },
  {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: '1,048,576 (8.2%)' },
  },
] as const;
