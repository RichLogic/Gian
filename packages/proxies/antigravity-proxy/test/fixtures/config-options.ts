import type { SessionConfigOption } from '@agentclientprotocol/sdk';

import type { ConfigValues } from '../../src/contracts.js';
import { coldModeOption, resolveConfigValues, toGianConfigOptions } from '../../src/core/catalog.js';

export const modelChoices = [
  { value: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
  { value: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)' },
  { value: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
  { value: 'gemini-future-pro-max', name: 'Gemini Future Pro (Max)' },
  { value: 'gemini-fixed', name: 'Gemini Fixed' },
  { value: 'gemini-unknown-turbo', name: 'Gemini Unknown (Turbo)' },
  { value: 'gemini-unmatched-high', name: 'Gemini Unmatched' },
];

export function configOptions(current = 'gemini-3.8-flash-high', mode = 'default'): SessionConfigOption[] {
  return [{
    id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: current,
    options: structuredClone(modelChoices),
  }, { ...coldModeOption(), currentValue: mode } as SessionConfigOption];
}

/** Real Proxy projection in the modern wire shape, consumed by generic Web
 * tests rather than a hand-written catalog that could mask missing controls. */
export function projectedCatalog(values: ConfigValues = {}, current = 'gemini-3.8-flash-high') {
  const native = configOptions(current);
  const options = toGianConfigOptions(native, values);
  const specialCatalogs: Record<string, string> = {};
  for (const option of options) {
    if (option.role === 'model') specialCatalogs.model = option.id;
    else if (option.role === 'effort') specialCatalogs.thinking = option.id;
    else if (option.role === 'approval_mode') specialCatalogs.approvalMode = option.id;
  }
  return {
    catalogRevision: 'antigravity-fixture', input: [{ type: 'text' as const }], slashCommands: [],
    configOptions: options.map(({ role: _role, ...option }) => option),
    specialCatalogs,
    capabilities: { 'catalog.resolve': 1, 'catalog.modeSemantics': 1 },
    resolvedDefaults: { sessionConfig: {}, turnConfig: resolveConfigValues(native, values) },
  };
}
