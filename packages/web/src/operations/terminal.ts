/**
 * UI Operation Layer — Terminal-domain definitions (Phase 3b of
 * `docs/proposals/ui-operation-layer.md`): `term.spawn` and `term.close`,
 * both PENDING WS.
 *
 * BOUNDARY DECISION (task brief + inventory §3): `terminal-wire.ts` stays the
 * raw-stream exception — `term:input`, `term:resize`, and
 * `term:replay-request` are per-keystroke/byte traffic where request
 * correlation is meaningless, so they keep their direct `ws.send`. Spawn and
 * close are one-shot lifecycle commands, and they are routed through the
 * operation layer FROM THE CALLERS, keeping terminal-wire free of lifecycle
 * sends:
 * - spawn: `makeWorkbenchWire(ws, termId, options, dispatch)` receives the
 *   dispatcher from its caller (App's Sheet renderTab); `wire.spawn(cols,
 *   rows)` dispatches `term.spawn` with the fitted geometry. Terminal.tsx is
 *   untouched — the tab still appears immediately, which already matches the
 *   pending policy (no success claim; the PTY either streams or reports
 *   `term:exited`).
 * - close: the Sheet terminal-tab close in `use-workbench.ts` dispatches
 *   `term.close`; the tab itself is removed locally in the same task (tab
 *   selection/close is policy `local`, inventory §3).
 *
 * The duplicate pending guard blocks a double spawn of the same term id; the
 * `operation:result` settles the run.
 */
import { registry } from './registry.js';
import type { OperationDefinition } from './types.js';

/** Entity key for one terminal tab's lifecycle operations. */
export function termEntityKey(termId: string): string {
  return `term:${termId}`;
}

/** WS round-trips are normally well under this; expiry marks the outcome
 *  unknown (never failed) per proposal §4.3. */
const WS_TIMEOUT_MS = 10_000;

export interface TermSpawnInput {
  termId: string;
  cols: number;
  rows: number;
  cwd?: string;
  shell?: string;
}

const termSpawn: OperationDefinition<TermSpawnInput> = {
  policy: 'pending',
  entityKey: input => termEntityKey(input.termId),
  buildMessage: input => ({
    type: 'term:spawn',
    term_id: input.termId,
    cols: input.cols,
    rows: input.rows,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.shell ? { shell: input.shell } : {}),
  }),
  timeoutMs: WS_TIMEOUT_MS,
};

const termClose: OperationDefinition<{ termId: string }> = {
  policy: 'pending',
  entityKey: input => termEntityKey(input.termId),
  buildMessage: input => ({ type: 'term:close', term_id: input.termId }),
  timeoutMs: WS_TIMEOUT_MS,
};

registry.register('term.spawn', termSpawn);
registry.register('term.close', termClose);
