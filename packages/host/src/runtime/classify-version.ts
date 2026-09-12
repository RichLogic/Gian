import { parse as parseSemver, compare as compareSemverLib } from 'semver';

import type { OpenRuntimeProfile } from '@gian/shared';

export type RuntimeVersionClass = OpenRuntimeProfile['verification'];

/**
 * Host Runtime version policy:
 * 1. Unparseable versions are incompatible.
 * 2. An exact verifiedVersions string match is verified.
 * 3. No parseable verified list means unverified.
 * 4. A parseable version strictly less than every parseable verified
 *    version is incompatible.
 * 5. Newer or other prerelease lines stay unverified.
 */
export function classifyRuntimeVersion(
  version: string | null,
  verifiedVersions: readonly string[],
): RuntimeVersionClass {
  if (version === null) return 'verified';
  if (verifiedVersions.includes(version)) return 'verified';
  const parsed = parseSemver(version);
  if (!parsed) return 'incompatible';
  const parsedVerified = verifiedVersions
    .map((item) => parseSemver(item))
    .filter((item): item is NonNullable<typeof item> => item !== null);
  if (parsedVerified.length === 0) return 'unverified';
  if (parsedVerified.every((item) => compareSemverLib(parsed, item) < 0)) {
    return 'incompatible';
  }
  return 'unverified';
}
