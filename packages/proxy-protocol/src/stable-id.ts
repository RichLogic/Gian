import { createHash } from 'node:crypto';

import {
  CUSTOMIZATION_KINDS,
  CUSTOMIZATION_STABLE_ID_HEX_CHARS,
  CUSTOMIZATION_STABLE_ID_PREFIX,
} from './constants.js';

type CustomizationKind = typeof CUSTOMIZATION_KINDS[number];

/**
 * Stable Customization item identity helper (Contract §4.6, Issue #50).
 *
 * The generated id is a 128-bit SHA-256 prefix over the *non-sensitive*
 * provenance of an item, so the same Provider definition in the same scope
 * yields the same id across refreshes while a reordered configuration or an
 * unrelated earlier handler never shifts unrelated ids.
 *
 * Adapters MUST exclude every sensitive input from `nativeIdentity` and
 * `canonicalSourceLocator` (secrets, env/header values, tokens, OAuth data,
 * URL query/fragment, credential-bearing arguments) — a hash does not make
 * them safe, and such values must never reach the wire, logs, or the id.
 */
export interface StableCustomizationIdInput {
  /** Proxy plugin id, e.g. `claude`, `codex`, `kimi`, `ai.deepseek.harness`. */
  provider: string;
  kind: CustomizationKind;
  /** Canonical scope key: `system`, `user`, or
   *  `workspace:<canonical-root>` / `directory:<canonical-relative-dir>`. */
  scopeKey: string;
  /** Canonicalized, Provider-rule-allowed source locator (e.g. the
   *  normalized entry path, or the config locator + server key). */
  canonicalSourceLocator: string;
  /** Provider-native stable identity for the definition itself. */
  nativeIdentity: string;
}

export function stableCustomizationId(input: StableCustomizationIdInput): string {
  const payload = [
    input.provider,
    input.kind,
    input.scopeKey,
    input.canonicalSourceLocator,
    input.nativeIdentity,
  ].join('\u0000');
  return CUSTOMIZATION_STABLE_ID_PREFIX
    + createHash('sha256').update(payload).digest('hex').slice(0, CUSTOMIZATION_STABLE_ID_HEX_CHARS);
}

export function isCustomizationStableId(value: string): boolean {
  if (!value.startsWith(CUSTOMIZATION_STABLE_ID_PREFIX)) return false;
  const hex = value.slice(CUSTOMIZATION_STABLE_ID_PREFIX.length);
  return hex.length === CUSTOMIZATION_STABLE_ID_HEX_CHARS && /^[a-f0-9]+$/.test(hex);
}