import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  parseAcpUsageUpdate,
  parseTokenUsageUpdate,
} from '../src/session/token-usage.js';

test('Codex current context uses last.totalTokens, not last.inputTokens', () => {
  const parsed = parseTokenUsageUpdate({
    params: {
      tokenUsage: {
        total: {
          inputTokens: 1_000,
          outputTokens: 200,
          cachedInputTokens: 500,
          totalTokens: 1_200,
        },
        last: {
          inputTokens: 90,
          outputTokens: 30,
          cachedInputTokens: 50,
          totalTokens: 120,
        },
        modelContextWindow: 258_000,
      },
    },
  }, 'codex');

  assert.deepEqual(parsed, {
    hasContext: true,
    context: { used: 120, window: 258_000 },
    conversation: {
      mode: 'absolute',
      inputTokens: 1_000,
      outputTokens: 200,
      cachedInputTokens: 500,
      totalTokens: 1_200,
    },
  });
});

test('canonical compact update explicitly invalidates only current context', () => {
  assert.deepEqual(
    parseTokenUsageUpdate(
      { context: null, reason: 'compact_started' },
      'claude',
    ),
    { hasContext: true, context: null },
  );
});

test('ACP usage_update maps exact used and size values', () => {
  assert.deepEqual(parseAcpUsageUpdate({
    update: {
      sessionUpdate: 'usage_update',
      used: 86_397,
      size: 1_048_576,
    },
  }), {
    hasContext: true,
    context: { used: 86_397, window: 1_048_576 },
  });
});
