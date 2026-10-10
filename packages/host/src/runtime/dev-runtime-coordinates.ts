import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DevRuntimeCoordinate {
  pluginId: string;
  runtimeId: string;
  version: string;
  format: 'raw' | 'tar.gz';
  entryRelativePath: string;
  asset: { url?: string; sha256: string; size: number };
  build?: { kind: 'dsh-lock'; packageSha256: string; lockSha256: string };
}

/** Pinned GianDev CLI coordinates, matched by Runtime id and version.
 * The JSON sits beside this module. Host build copies it into dist because
 * tsc does not emit JSON. Regenerate it from the branch manifests and
 * current-combinations.json when a verified Runtime version changes. */
export const devRuntimeCoordinates = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'dev-runtime-coordinates.json'),
  'utf8',
)) as readonly DevRuntimeCoordinate[];
