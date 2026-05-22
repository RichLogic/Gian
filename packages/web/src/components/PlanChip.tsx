import { useContext, useMemo } from 'react';
import type { ApprovalItem, TranscriptItem } from '../types.js';
import { PlanOpenContext } from '../transcript/items.js';

/**
 * "Plan" pill that sits directly above the composer. Two source paths:
 *
 *   - cc: surfaces the latest `exit_plan_mode` approval. Dot color tracks the
 *     approval status (pending / accepted / declined).
 *   - codex: surfaces the live `plan_update` markdown for the current session.
 *     No approval ceremony — the chip is just a "view the plan" affordance.
 *
 * Click → fires the `PlanOpenContext` callback with `{ id, title, markdown }`,
 * which the host routes into the 4th-level Sheet tab.
 */
export function PlanChip({
  items,
  codexPlanText,
  sessionId,
}: {
  items: TranscriptItem[];
  /** Latest plan markdown from codex's plan_update stream, if any. */
  codexPlanText?: string;
  /** Used to derive a stable Sheet tab id for the codex plan. */
  sessionId: string;
}) {
  const openPlan = useContext(PlanOpenContext);

  // Walk items from the end so we land on the most recent plan first. Plans
  // are rare (one per planning round) — the linear scan is cheap.
  const latestPlan = useMemo<ApprovalItem | null>(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it && it.kind === 'approval' && it.category === 'exit_plan_mode') {
        return it;
      }
    }
    return null;
  }, [items]);

  if (latestPlan) {
    // Map approval status → chip status dot. `approved-once` / `approved-session`
    // both mean "user accepted" from the proxy's perspective. `declined` covers
    // both literal Decline and "keep_planning" — both come back as decline on
    // the wire.
    const dotClass =
      latestPlan.status === 'pending' ? 'plan-chip-dot--pending' :
      latestPlan.status === 'declined' ? 'plan-chip-dot--declined' :
      'plan-chip-dot--accepted';
    return (
      <button
        type="button"
        className="plan-chip"
        onClick={() => openPlan?.({
          id: latestPlan.approvalId,
          title: 'Plan',
          markdown: latestPlan.cmd,
        })}
        title="View the latest plan"
      >
        <span className="plan-chip-label">Plan</span>
        <span className={`plan-chip-dot ${dotClass}`} aria-hidden />
      </button>
    );
  }

  // Codex plan: no approval ceremony, just live markdown. Show the chip once
  // there's any content; dot stays neutral (accepted-style) since codex's
  // plan is an in-progress artifact, not a yes/no gate.
  if (codexPlanText && codexPlanText.trim()) {
    return (
      <button
        type="button"
        className="plan-chip"
        onClick={() => openPlan?.({
          id: `codex-plan-${sessionId}`,
          title: 'Plan',
          markdown: codexPlanText,
        })}
        title="View the latest plan"
      >
        <span className="plan-chip-label">Plan</span>
        <span className="plan-chip-dot plan-chip-dot--accepted" aria-hidden />
      </button>
    );
  }

  return null;
}
