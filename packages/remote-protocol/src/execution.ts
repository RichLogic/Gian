import { z } from 'zod';
import { githubAccountIdSchema } from './account.js';
import { canonicalIdSchema, sha256HexSchema } from './validation.js';

export const remoteServerOriginSchema = z.string().max(2048).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value
      && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}, 'Expected a canonical HTTPS origin without credentials, path, query or fragment.');

// Task membership stays local. The current/viewed worktree is a remote
// resource, not part of the immutable execution identity.
export const remoteExecutionTargetSchema = z.strictObject({
  server_origin: remoteServerOriginSchema,
  server_identity_fingerprint: sha256HexSchema,
  account_id: githubAccountIdSchema,
  host_id: canonicalIdSchema,
  remote_session_id: canonicalIdSchema,
});

export const remoteExecutionBindingInputSchema = z.strictObject({
  local_session_id: canonicalIdSchema,
  target: remoteExecutionTargetSchema,
});

export type RemoteExecutionTarget = z.infer<typeof remoteExecutionTargetSchema>;
export type RemoteExecutionBindingInput = z.infer<typeof remoteExecutionBindingInputSchema>;
