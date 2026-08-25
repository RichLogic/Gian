import type { ModelCapabilities, ThinkingLevel } from './types.js';

type RuntimeEffortEntry =
  | string
  | {
    reasoningEffort?: string;
  };

type RuntimeServiceTierEntry =
  | string
  | {
    id?: string;
    name?: string;
    description?: string;
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
  /** Current app-server field. */
  serviceTiers?: RuntimeServiceTierEntry[];
  /** Compatibility field used by older app-server model catalogs. */
  additionalSpeedTiers?: string[];
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

function serviceTiers(record: RuntimeModelRecord) {
  const tiers = new Map<string, { id: string; displayName: string; description: string }>();
  for (const entry of record.serviceTiers ?? []) {
    const id = (typeof entry === 'string' ? entry : entry.id)?.trim();
    if (!id || tiers.has(id)) continue;
    tiers.set(id, {
      id,
      displayName: typeof entry === 'string' ? id : entry.name?.trim() || id,
      description: typeof entry === 'string' ? '' : entry.description?.trim() || '',
    });
  }
  for (const value of record.additionalSpeedTiers ?? []) {
    const id = value.trim();
    if (!id || tiers.has(id)) continue;
    tiers.set(id, { id, displayName: id, description: '' });
  }
  return [...tiers.values()];
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
      serviceTiers: serviceTiers(record),
    };
  });

  return {
    protocolVersion: '0.1.0',
    models: normalizedModels,
    modes: [
      { id: 'ask', label: 'Ask for approval', description: 'Ask before risky actions.', isDefault: true },
      { id: 'auto', label: 'Approve for me', description: 'Let Codex review actions automatically.', isDefault: false },
      { id: 'full-access', label: 'Full access', description: 'Run without sandbox or approval prompts.', isDefault: false },
      { id: 'custom', label: 'Custom (config.toml)', description: 'Use permissions from config.toml.', isDefault: false },
    ],
    slashCommands: [],
  };
}
