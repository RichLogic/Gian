import type { SessionConfigOption } from '@agentclientprotocol/sdk';

/** Kimi 2.0.2 appends the previous model's current thinking value to a new
 * model's choices (K3 high -> K2.7 on/high, K2.7 on -> K3 low/high/max/on).
 * That trailing compatibility value is not a choice supported by the new
 * model. Preserve native choices and future effort IDs, removing only this
 * observed cross-family trailing current value. No model-name table is used. */
export function normalizeThinkingOption(option: SessionConfigOption): SessionConfigOption {
  if (option.type !== 'select') return option;
  const choices = option.options.flatMap(entry => 'options' in entry ? entry.options : [entry]);
  if (choices.length < 2) return option;
  const first = choices[0]!;
  const last = choices[choices.length - 1]!;
  const toggle = (value: string) => value === 'on' || value === 'off';
  if (last.value !== option.currentValue || toggle(first.value) === toggle(last.value)) return option;
  // Only normalize homogeneous choices followed by one stale opposite-family
  // value. A different native shape must not be silently reinterpreted.
  const canonical = choices.slice(0, -1);
  if (!canonical.every(choice => toggle(choice.value) === toggle(first.value))) return option;
  return { ...option, currentValue: first.value, options: canonical };
}
