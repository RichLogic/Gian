/**
 * UI Operation Layer — external file-open definition (Phase 3b of
 * `docs/archive/proposals/ui-operation-layer.md`): `files.openExternal` (PENDING
 * REST) backs every "open this file outside Gian" action — the Sheet "Open
 * with…" menu (registered editor / named app / system default / Finder /
 * Terminal) and the git pane's "Reveal in Finder" (the reveal helper moved
 * into api.ts with this migration, inventory §4.1).
 *
 * These are fire-and-forget external opens: the OS owns the success UX, so
 * the run is a lightweight pending run whose ONLY user-visible job is to
 * surface a launch failure (`rollback` toasts the host's error) and to block
 * an exact duplicate click while one is in flight (the entity key includes
 * the target, so opening the same file in two different apps concurrently is
 * allowed). No spinner UX is added — none existed.
 *
 * Browser raw-URL opens stay `window.open` local exceptions (inventory §3):
 * no Host transport, the browser owns feedback. Unregistered attachments
 * use the same operation through `openAbsoluteFile`.
 */
import {
  openAbsoluteFile,
  openFileBuiltin,
  openFileWith,
  openFileWithApp,
  revealWorkingTree,
} from '../api.js';
import { toast } from '../feedback.js';
import { registry } from './registry.js';
import type { OperationDefinition } from './types.js';

export type OpenExternalTarget =
  | { kind: 'editor'; editorId: string }
  | { kind: 'app'; app: string }
  | { kind: 'builtin'; builtin: 'default' | 'finder' | 'terminal' }
  | { kind: 'reveal' };

export type OpenExternalInput =
  | {
      workingTreeId: string;
      /** Repo-relative path; empty for a whole-tree reveal. */
      path: string;
      target: OpenExternalTarget;
    }
  | {
      absolutePath: string;
      target: Exclude<OpenExternalTarget, { kind: 'reveal' }>;
    };

/** Entity key for one (tree, path, target) open — blocks an exact duplicate
 *  click while in flight, nothing more. */
export function openExternalEntityKey(input: OpenExternalInput): string {
  const tag =
    input.target.kind === 'editor' ? `editor:${input.target.editorId}`
    : input.target.kind === 'app' ? `app:${input.target.app}`
    : input.target.kind === 'builtin' ? `builtin:${input.target.builtin}`
    : 'reveal';
  if ('absolutePath' in input) {
    return `files:open:abs:${input.absolutePath}:${tag}`;
  }
  return `files:open:${input.workingTreeId}:${input.path}:${tag}`;
}

/** Launching an external app is a quick local spawn. */
const REST_TIMEOUT_MS = 15_000;

const filesOpenExternal: OperationDefinition<OpenExternalInput> = {
  policy: 'pending',
  entityKey: openExternalEntityKey,
  execute: async input => {
    if ('absolutePath' in input) {
      const { absolutePath, target } = input;
      const result =
        target.kind === 'editor' ? await openAbsoluteFile(absolutePath, { editor_id: target.editorId })
        : target.kind === 'app' ? await openAbsoluteFile(absolutePath, { app: target.app })
        : await openAbsoluteFile(absolutePath, { builtin: target.builtin });
      if ('error' in result) throw new Error(result.error);
      return;
    }
    const { workingTreeId, path, target } = input;
    const result =
      target.kind === 'editor' ? await openFileWith(workingTreeId, path, target.editorId)
      : target.kind === 'app' ? await openFileWithApp(workingTreeId, path, target.app)
      : target.kind === 'reveal' ? await revealWorkingTree(workingTreeId)
      : await openFileBuiltin(workingTreeId, path, target.builtin);
    if ('error' in result) throw new Error(result.error);
  },
  // The result matters only for surfacing launch errors (see header).
  rollback: error => toast({ kind: 'error', message: error.message }),
  timeoutMs: REST_TIMEOUT_MS,
};

registry.register('files.openExternal', filesOpenExternal);
