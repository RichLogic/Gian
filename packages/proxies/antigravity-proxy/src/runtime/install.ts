import { createRuntimeInstallPlanner } from '@gian/proxy-protocol';

import { ANTIGRAVITY_RUNTIME_ID, PAIRED_HARNESS_ENTRY, POSIX_SERVER_ENTRY } from './layout.js';

/**
 * Product archive at the tar root: the official POSIX server and the required
 * harness file. Entry names are a layout recipe, not a same-version
 * certificate. The caller supplies `artifactSha256`. The Host content
 * fingerprint and that managed artifact digest are the immutable byte
 * identity. The shared 0.6.7 planner accepts only `raw` and `tar.gz`, so
 * this recipe does not claim ZIP. URLs, sizes, and digests are not invented
 * here. The Dev source builder pins and repacks the original darwin-arm64
 * pair. Windows `agy_acp_server.exe` is a separate delivery recipe.
 */
export const PAIRED_PRODUCT_ARCHIVE_ENTRIES = [POSIX_SERVER_ENTRY, PAIRED_HARNESS_ENTRY] as const;

export const planRuntimeInstallation = createRuntimeInstallPlanner({
  runtimeId: ANTIGRAVITY_RUNTIME_ID,
  kind: 'managed',
  format: 'tar.gz',
  entryRelativePath: POSIX_SERVER_ENTRY,
});
