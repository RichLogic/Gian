import type { ModelCapabilities, ThinkingLevel } from './types.js';

const THINKING_ORDER: ThinkingLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const THINKING_RANK = new Map(THINKING_ORDER.map((entry, index) => [entry, index]));

type RuntimeEffortEntry =
  | string
  | {
    reasoningEffort?: string;
  };

type RuntimeModelRecord = {
  id?: string;
  model?: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
  defaultReasoningEffort?: string | null;
  supportedReasoningEfforts?: RuntimeEffortEntry[];
};

function normalizeThinking(value: unknown): ThinkingLevel | null {
  if (value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh') {
    return value;
  }
  return null;
}

function supportedThinking(entries: RuntimeEffortEntry[] | undefined) {
  const values = new Set<ThinkingLevel>();
  for (const entry of entries ?? []) {
    const raw = typeof entry === 'string' ? entry : entry.reasoningEffort;
    const normalized = normalizeThinking(raw);
    if (normalized) {
      values.add(normalized);
    }
  }

  return [...values].sort((left, right) => (THINKING_RANK.get(left) ?? 99) - (THINKING_RANK.get(right) ?? 99));
}

function defaultThinking(record: RuntimeModelRecord, supported: ThinkingLevel[]) {
  const normalizedDefault = normalizeThinking(record.defaultReasoningEffort);
  if (normalizedDefault) {
    return normalizedDefault;
  }
  return supported[0] ?? null;
}

export function buildCapabilitiesPayload(models: unknown[]) {
  const normalizedModels: ModelCapabilities[] = (models as RuntimeModelRecord[]).map((record) => {
    const supported = supportedThinking(record.supportedReasoningEfforts);
    return {
      id: record.id ?? record.model ?? 'unknown-model',
      model: record.model ?? record.id ?? 'unknown-model',
      displayName: record.displayName ?? record.model ?? record.id ?? 'Unknown model',
      description: record.description ?? '',
      hidden: Boolean(record.hidden),
      isDefault: Boolean(record.isDefault),
      defaultThinking: defaultThinking(record, supported),
      supportedThinking: supported,
    };
  });

  return {
    protocolVersion: '0.1.0',
    models: normalizedModels,
    slashCommands: [],
  };
}
