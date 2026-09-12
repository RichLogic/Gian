import { compare as compareSemverLib, parse as parseSemver } from 'semver';

export function compareSemver(left: string, right: string): number {
  const leftParsed = parseSemver(left);
  const rightParsed = parseSemver(right);
  if (!leftParsed || !rightParsed) return left.localeCompare(right);
  return compareSemverLib(leftParsed, rightParsed);
}

export function sortSemverDescending(versions: readonly string[]): string[] {
  return [...versions].sort((left, right) => compareSemver(right, left));
}
