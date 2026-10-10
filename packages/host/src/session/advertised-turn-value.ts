import type { ConfigOption, ConfigValue } from '@gian/shared';

/**
 * Choose the turn value the Host may send. A persisted select that is no
 * longer in the live catalog is replaced by the advertised default so the
 * conformance check does not reject an old session. Null is a legal value
 * when the catalog lists it, including Codex's configured-default policy.
 * An empty persisted string stays absent and does not fall through.
 */
export function advertisedTurnValue(
  option: Pick<ConfigOption, 'choices' | 'defaultValue'>,
  persisted: ConfigValue | null | undefined,
  roleValue: ConfigValue | null | undefined,
): ConfigValue | undefined {
  if (persisted === '') return undefined;
  const allowed = (value: ConfigValue | null | undefined): value is ConfigValue => {
    if (value === undefined || value === '') return false;
    if (!option.choices || option.choices.length === 0) return true;
    return option.choices.some(choice => Object.is(choice.value, value));
  };
  if (allowed(persisted)) return persisted;
  if (allowed(roleValue)) return roleValue;
  return allowed(option.defaultValue) ? option.defaultValue : undefined;
}
