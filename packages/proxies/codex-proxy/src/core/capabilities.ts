import type { ModelCapabilities, ThinkingLevel } from './types.js';

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
  return typeof value === 'string' && value.trim() ? value.trim() : null;
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

  return [...values];
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
    modes: [
      { id: 'plan', label: 'Plan', description: 'Explore and plan without making changes.', isDefault: false },
      { id: 'ask', label: 'Ask', description: 'Ask before risky actions.', isDefault: true },
      { id: 'auto', label: 'Auto', description: 'Let Codex review actions automatically.', isDefault: false },
      { id: 'custom', label: 'Custom', description: 'Use permissions from config.toml.', isDefault: false },
      { id: 'full-access', label: 'Full access', description: 'Run without sandbox or approval prompts.', isDefault: false },
    ],
    slashCommands: [],
  };
}
