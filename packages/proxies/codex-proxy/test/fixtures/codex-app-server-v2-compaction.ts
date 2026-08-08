const breakdown = (
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
  reasoningOutputTokens: number,
) => ({
  inputTokens,
  outputTokens,
  cachedInputTokens,
  reasoningOutputTokens,
  cacheWriteInputTokens: 0,
  totalTokens: inputTokens + outputTokens,
});

const usage = (
  last: ReturnType<typeof breakdown>,
  total: ReturnType<typeof breakdown>,
) => ({
  method: 'thread/tokenUsage/updated',
  params: {
    threadId: 'thread-fixture',
    turnId: 'turn-fixture',
    tokenUsage: { last, total, modelContextWindow: 200_000 },
  },
});

/** Codex app-server v2 automatic/manual compaction event sequence. */
export const CODEX_APP_SERVER_V2_COMPACTION = {
  fixtureVersion: 'codex-app-server/v2-compaction',
  preBoundaryUsage: usage(
    breakdown(160_000, 20_000, 80_000, 5_000),
    breakdown(800_000, 100_000, 400_000, 20_000),
  ),
  boundaryStarted: {
    method: 'item/started',
    params: {
      threadId: 'thread-fixture',
      turnId: 'turn-fixture',
      item: { id: 'compact-auto-1', type: 'contextCompaction' },
    },
  },
  summarizationUsage: usage(
    breakdown(170_000, 20_000, 90_000, 5_000),
    breakdown(1_000_000, 90_000, 500_000, 25_000),
  ),
  boundaryCompleted: {
    method: 'item/completed',
    params: {
      threadId: 'thread-fixture',
      turnId: 'turn-fixture',
      item: { id: 'compact-auto-1', type: 'contextCompaction' },
    },
  },
  postBoundaryUsage: usage(
    breakdown(28_000, 4_000, 12_000, 1_000),
    breakdown(1_050_000, 72_000, 520_000, 26_000),
  ),
  threadCompacted: {
    method: 'thread/compacted',
    params: { threadId: 'thread-fixture', turnId: 'turn-fixture' },
  },
  futureBoundary: {
    method: 'item/started',
    params: {
      threadId: 'thread-fixture',
      turnId: 'turn-fixture',
      item: { id: 'compact-future-1', type: 'futureContextCompaction' },
    },
  },
} as const;
