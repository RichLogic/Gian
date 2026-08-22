/**
 * Session Fork standard controls (gian.proxy/2.0 proposal §10.6,
 * `docs/proposals/gian-proxy-v2-ui-bridge.md`).
 *
 * Exports:
 *
 * - `useForkRun` — shared pending/failure wiring behind EVERY fork dispatch:
 *   the head-fork entry in the session dropdown menu (PathBreadcrumb via
 *   use-topbar-model) and the per-turn transcript control below.
 * - `ForkFromTurnControl` — the per-turn affordance rendered on a Terminal
 *   Turn's transcript boundary. Gated on `session.fork.atTurn` (which itself
 *   requires `session.fork` at both layers) AND on the Host-flowed exact
 *   `{turn_id, source_turn_id}` of that boundary: both ids are sent VERBATIM
 *   — never derived from rendered text, never an adjacent turn, never a
 *   silent fallback to `head` (§10.6). When the ids are absent the control
 *   greys with the generic unavailable reason.
 * - `ForkOriginBanner` — the lineage line at the top of a forked session's
 *   view (parent session + boundary).
 *
 * After a successful fork the Host-created session arrives via
 * `session:created` / `state_sync`; these controls never auto-switch the
 * current session and never touch the source session (§10.6).
 */
import { useEffect, useRef, useState } from 'react';
import type { SessionOrigin } from '@gian/shared';

import { useT } from '../i18n/index.js';
import { toast } from '../feedback.js';
import type { OperationDispatcher } from '../operations/dispatcher.js';
import {
  useOperationDispatch,
  useOperationRun,
  usePendingOperations,
} from '../operations/use-operations.js';
import type { OperationRun } from '../operations/types.js';
import { forkOriginText } from '../presentation/fork.js';
import type { ActionControlState } from './action-gating.js';

/**
 * The single head-fork wire path (§10.6: anchor at the newest Terminal Turn
 * at accept time). Shared by the session dropdown menu entry (wired in the
 * App root) — per-turn forks build their own verbatim `{turn, sourceTurnId}`
 * anchor in ForkFromTurnControl and must NOT route through here.
 */
export function dispatchHeadFork(
  dispatch: OperationDispatcher['dispatch'],
  sourceSessionId: string,
): OperationRun {
  return dispatch('session.forkSession', {
    sourceSessionId,
    anchor: { type: 'head' },
  });
}

// ─── Inline icons (same 24-grid / 1.5px stroke idiom as CodingView) ───────
function SvgIcon({ d, size = 16, stroke = 1.5 }: { d: string; size?: number; stroke?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
         strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {d.split(' M').map((seg, i) => (
        <path key={i} d={i === 0 ? seg : `M${seg}`} />
      ))}
    </svg>
  );
}

const ICON = {
  // Same glyph constant as CodingView's ICON.branch.
  fork: 'M5 3v10M11 6v7M5 6h6M11 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4ZM5 15a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
};

/**
 * Toast a fork run's settled failure exactly once (§15): a confirmed fork
 * arrives via session:created, so a failed/timed-out run is the ONLY signal
 * that nothing may appear. Success shows nothing and NEVER auto-switches to
 * the new session (§10.6). `t` is injected so callers mounted ABOVE the
 * LocaleProvider (the App root) can pass their own translator.
 */
export function useForkRunSettledToast(
  run: OperationRun | undefined,
  t: (key: string) => string,
): void {
  const signaledRunRef = useRef<string | null>(null);
  useEffect(() => {
    if (!run || signaledRunRef.current === run.id) return;
    if (run.phase === 'failed') {
      signaledRunRef.current = run.id;
      toast({ kind: 'error', message: run.error ?? t('fork.createFailed') });
    } else if (run.phase === 'timed-out') {
      signaledRunRef.current = run.id;
      // Unknown outcome (§4.3) — never a silent success, never an error.
      toast({ kind: 'warning', message: t('fork.createUnknown') });
    }
  }, [run, t]);
}

/**
 * Shared pending/failure wiring for every fork dispatch. `session.forkSession`
 * mints a fresh entity key per run (the forked session does not exist yet),
 * so the dispatcher's duplicate guard does not apply — the local in-flight
 * check is the double-submit protection, and one fork at a time is enough.
 * Context-based: only for components under the operation providers (the App
 * root wires the session-menu fork with the store-explicit hooks instead).
 */
export function useForkRun() {
  const t = useT();
  const dispatch = useOperationDispatch();
  const inFlight = usePendingOperations();
  const [runId, setRunId] = useState<string>();
  const run = useOperationRun(runId);

  const forking = inFlight.some(entry => entry.name === 'session.forkSession')
    || run?.phase === 'pending';

  useForkRunSettledToast(run, t);

  return { dispatch, forking, setRunId };
}

// ─── Per-turn fork (transcript boundary) ───────────────────────────────────

export function ForkFromTurnControl({
  sourceSessionId,
  turn,
  turnId,
  sourceTurnId,
  state,
}: {
  sourceSessionId: string;
  /** Display-stream turn number of the boundary — label/testid only, never
   *  sent on the wire. */
  turn: number;
  /** Exact Host-flowed boundary ids of THIS Terminal Turn (§10.6). */
  turnId?: string;
  sourceTurnId?: string;
  state: ActionControlState;
}) {
  const t = useT();
  const { dispatch, forking, setRunId } = useForkRun();

  // Never fabricate the boundary: without BOTH Host-flowed ids the control
  // stays greyed with the generic reason (it lights up automatically once
  // the Host flows them on turn-end items).
  const hasBoundary = turnId !== undefined && sourceTurnId !== undefined;
  const enabled = state.enabled && hasBoundary && !forking;
  const title = !state.enabled
    ? (state.reason ?? t('fork.fromTurnUnavailable'))
    : !hasBoundary
      ? t('fork.fromTurnUnavailable')
      : forking
        ? t('fork.forking')
        : t('fork.fromTurnTitle');

  return (
    <div className="turn-fork">
      <button
        type="button"
        className="fork-turn-btn"
        data-testid={`fork-turn-${turn}`}
        disabled={!enabled}
        title={title}
        onClick={() => {
          if (!enabled) return;
          const run = dispatch('session.forkSession', {
            sourceSessionId,
            // Verbatim — no derivation, no fallback (§10.6).
            anchor: { type: 'turn', turnId: turnId!, sourceTurnId: sourceTurnId! },
          });
          setRunId(run.id);
        }}
      >
        <SvgIcon d={ICON.fork} size={12} />
        <span>{t('fork.fromTurn')}</span>
      </button>
    </div>
  );
}

// ─── Origin banner (forked session view) ───────────────────────────────────

export function ForkOriginBanner({
  origin,
  parentName,
}: {
  origin: SessionOrigin;
  /** Parent session's current name, resolved by the caller from the sessions
   *  list; undefined falls back to a short id. */
  parentName?: string;
}) {
  const t = useT();
  return (
    <div className="session-banner origin" data-testid="fork-origin-banner">
      <SvgIcon d={ICON.fork} size={12} />
      <span>{forkOriginText(t, origin, parentName)}</span>
    </div>
  );
}
