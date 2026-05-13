import { useContext, useMemo } from 'react';
import type { ApprovalItem, TranscriptItem } from '../types.js';
import { PlanOpenContext } from '../transcript/items.js';

/**
 * "Plan" pill that sits directly above the composer. Surfaces the latest
 * `exit_plan_mode` approval for the current session so the user can always
 * jump back to the plan markdown — once approved/declined, the inline card
 * scrolls away as the conversation continues; this chip keeps it one click
 * away.
 *
 * Lifecycle (per session):
 *   - Hidden when the session has no plan yet.
 *   - Yellow dot while the plan is still awaiting the user.
 *   - Green dot once accepted (auto/ask flip already happened).
 *   - Red dot when the user picked "keep planning" (declined).
 *
 * Click → fires the `PlanOpenContext` callback, which routes the plan into
 * the 4th-level FilePreviewDrawer (same drawer Files/Diff use).
 */
export function PlanChip({ items }: { items: TranscriptItem[] }) {
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

  if (!latestPlan) return null;

  // Map approval status → chip status dot. `approved-once` / `approved-session`
  // both mean "user accepted" from the proxy's perspective; the host's
  // plan-mode-exit ceremony already flipped approval_mode. `declined` covers
  // both literal Decline and the new "keep_planning" variant — both come
  // back as decline on the wire.
  const dotClass =
    latestPlan.status === 'pending' ? 'plan-chip-dot--pending' :
    latestPlan.status === 'declined' ? 'plan-chip-dot--declined' :
    'plan-chip-dot--accepted';

  return (
    <button
      type="button"
      className="plan-chip"
      onClick={() => openPlan?.(latestPlan)}
      title="View the latest plan"
    >
      <span className="plan-chip-label">Plan</span>
      <span className={`plan-chip-dot ${dotClass}`} aria-hidden />
    </button>
  );
}
