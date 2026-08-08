import type { Executor, TokenUsageUpdate } from '@gian/shared';

export interface ParsedTokenUsageUpdate {
  hasContext: boolean;
  context?: TokenUsageUpdate['context'];
  conversation?: TokenUsageUpdate['conversation'];
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function tokenBreakdown(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const inputTokens = nonNegativeInteger(source.inputTokens);
  const outputTokens = nonNegativeInteger(source.outputTokens);
  const cachedInputTokens = nonNegativeInteger(source.cachedInputTokens);
  const totalTokens = nonNegativeInteger(source.totalTokens);
  if (
    inputTokens === undefined
    && outputTokens === undefined
    && cachedInputTokens === undefined
    && totalTokens === undefined
  ) {
    return null;
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

/** Pinned codex app-server v2 TokenUsageBreakdown. This stays separate from
 * canonical proxy parsing because a partial raw absolute snapshot would
 * otherwise replace every missing stored counter with zero. */
function codexV2TokenBreakdown(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const inputTokens = nonNegativeInteger(source.inputTokens);
  const outputTokens = nonNegativeInteger(source.outputTokens);
  const cachedInputTokens = nonNegativeInteger(source.cachedInputTokens);
  const totalTokens = nonNegativeInteger(source.totalTokens);
  const reasoningOutputTokens = nonNegativeInteger(source.reasoningOutputTokens);
  const rawCacheWrite = source.cacheWriteInputTokens;
  const cacheWriteInputTokens = nonNegativeInteger(rawCacheWrite);
  if (
    inputTokens === undefined
    || outputTokens === undefined
    || cachedInputTokens === undefined
    || totalTokens === undefined
    || reasoningOutputTokens === undefined
    || (rawCacheWrite !== undefined && cacheWriteInputTokens === undefined)
  ) return null;
  // Gian currently has no separate reasoning/cache-write columns. Validate
  // those v2 fields above, then retain the four counters in its wire model.
  return { inputTokens, outputTokens, cachedInputTokens, totalTokens };
}

function parseCanonical(data: Record<string, unknown>): ParsedTokenUsageUpdate | null {
  const hasContext = Object.prototype.hasOwnProperty.call(data, 'context');
  let context: TokenUsageUpdate['context'] | undefined;
  if (hasContext) {
    if (data.context === null) {
      context = null;
    } else if (data.context && typeof data.context === 'object') {
      const raw = data.context as Record<string, unknown>;
      const used = nonNegativeInteger(raw.used);
      const window = nonNegativeInteger(raw.window);
      if (used === undefined) return null;
      context = {
        used,
        ...(window === undefined || window === 0 ? {} : { window }),
      };
    } else {
      return null;
    }
  }

  let conversation: TokenUsageUpdate['conversation'];
  if (data.conversation && typeof data.conversation === 'object') {
    const raw = data.conversation as Record<string, unknown>;
    const mode = raw.mode;
    if (mode === 'reset') {
      conversation = { mode };
    } else if (mode === 'absolute' || mode === 'delta') {
      const breakdown = tokenBreakdown(raw);
      if (breakdown) conversation = { mode, ...breakdown };
    }
  }

  return hasContext || conversation
    ? { hasContext, ...(hasContext ? { context } : {}), ...(conversation ? { conversation } : {}) }
    : null;
}

/**
 * Accepts the canonical proxy payload plus the Codex app-server shape retained
 * for wire compatibility. Claude's legacy result-only shape is treated as a
 * per-turn delta; new Claude proxies emit canonical current-context samples.
 */
export function parseTokenUsageUpdate(
  data: unknown,
  executor: Executor,
): ParsedTokenUsageUpdate | null {
  if (!data || typeof data !== 'object') return null;
  const root = data as Record<string, unknown>;
  const canonical = parseCanonical(root);
  if (canonical) return canonical;

  const params = (root.params ?? root) as Record<string, unknown>;
  const tokenUsage = params.tokenUsage;
  if (!tokenUsage || typeof tokenUsage !== 'object') return null;
  const raw = tokenUsage as Record<string, unknown>;
  const total = tokenBreakdown(raw.total);
  const codexTotal = codexV2TokenBreakdown(raw.total);
  const codexLast = codexV2TokenBreakdown(raw.last);
  const rawWindow = raw.modelContextWindow;
  const window = nonNegativeInteger(raw.modelContextWindow);

  if (executor === 'codex') {
    if (
      !codexLast
      || !codexTotal
      || (rawWindow !== undefined && rawWindow !== null && window === undefined)
    ) return null;
    const used = codexLast.totalTokens;
    return {
      hasContext: true,
      context: { used, ...(window && window > 0 ? { window } : {}) },
      conversation: { mode: 'absolute' as const, ...codexTotal },
    };
  }

  if (executor === 'claude' && total) {
    const input = total.inputTokens ?? 0;
    const cached = total.cachedInputTokens ?? 0;
    return {
      hasContext: true,
      context: {
        used: input + cached,
        ...(window && window > 0 ? { window } : {}),
      },
      conversation: { mode: 'delta', ...total },
    };
  }

  return null;
}

/** ACP 0.23 `usage_update` compatibility for agents that emit it directly. */
export function parseAcpUsageUpdate(data: unknown): ParsedTokenUsageUpdate | null {
  if (!data || typeof data !== 'object') return null;
  const payload = data as { update?: unknown };
  if (!payload.update || typeof payload.update !== 'object') return null;
  const update = payload.update as Record<string, unknown>;
  if (update.sessionUpdate !== 'usage_update') return null;
  const used = nonNegativeInteger(update.used);
  const window = nonNegativeInteger(update.size);
  if (used === undefined || window === undefined || window === 0) return null;
  return {
    hasContext: true,
    context: { used, window },
  };
}
