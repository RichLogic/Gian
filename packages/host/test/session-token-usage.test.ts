import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  parseAcpUsageUpdate,
  parseTokenUsageUpdate,
} from '../src/session/token-usage.js';
import {
  ACP_V0_23_USAGE_UPDATE,
  CODEX_APP_SERVER_V2_USAGE,
  MALFORMED_PROVIDER_USAGE,
  UNKNOWN_PROVIDER_USAGE,
} from './fixtures/provider-usage-v1.js';

test('Codex current context uses last.totalTokens, not last.inputTokens', () => {
  const parsed = parseTokenUsageUpdate(CODEX_APP_SERVER_V2_USAGE.data, 'codex');

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

test('Codex current v2 usage accepts an explicit null model context window', () => {
  const tokenUsage = CODEX_APP_SERVER_V2_USAGE.data.params.tokenUsage;
  const parsed = parseTokenUsageUpdate({
    params: { tokenUsage: { ...tokenUsage, modelContextWindow: null } },
  }, 'codex');

  assert.deepEqual(parsed, {
    hasContext: true,
    context: { used: 120 },
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
  assert.deepEqual(parseAcpUsageUpdate(ACP_V0_23_USAGE_UPDATE.data), {
    hasContext: true,
    context: { used: 86_397, window: 1_048_576 },
  });
});

test('unknown versioned provider usage stays unknown instead of clearing values to zero', () => {
  assert.equal(parseTokenUsageUpdate(UNKNOWN_PROVIDER_USAGE.codex.data, 'codex'), null);
  assert.equal(parseAcpUsageUpdate(UNKNOWN_PROVIDER_USAGE.acp.data), null);
  assert.equal(parseTokenUsageUpdate(MALFORMED_PROVIDER_USAGE.codexPartialV2.data, 'codex'), null);
  assert.equal(parseAcpUsageUpdate(MALFORMED_PROVIDER_USAGE.acpPartialV0_23.data), null);
  assert.equal(parseTokenUsageUpdate({
    params: {
      tokenUsage: {
        total: {
          inputTokens: 0.5,
          outputTokens: 0,
          cachedInputTokens: 0,
          totalTokens: 0,
          reasoningOutputTokens: 0,
        },
        last: {
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          totalTokens: 0,
          reasoningOutputTokens: 0,
        },
      },
    },
  }, 'codex'), null);
  assert.equal(parseAcpUsageUpdate({
    update: { sessionUpdate: 'usage_update', used: 0.5, size: 1_000 },
  }), null);
});
