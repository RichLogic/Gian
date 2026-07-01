// Loop engine (proposal §4.5) — pure. Given the active loop and the engineer's
// submit_step outcome, decide how the loop advances. The three exits:
//   ① reviewer verdict = pass            → done (stop, report to user)
//   ② round cap reached without passing  → ask-continue (pause, ask "one more?")
//   ③ engineer hit a real blocker        → pause (hand back to user)
// Otherwise the step completed needing another round → continue (PM picks next).
//
// This computes the DECISION only; persisting the new loop row is the caller's
// job (updateLoop). No IO here.

import type { SubmitStepStatus, SubmitStepVerdict, TaskLoop } from '@gian/shared';

export type LoopOutcome = 'continue' | 'ask-continue' | 'done' | 'pause';

export interface LoopDecision {
  outcome: LoopOutcome;
  /** Loop status to persist next. */
  nextStatus: TaskLoop['status'];
  /** Round counter to persist next. */
  nextRound: number;
  reason: string;
}

export interface SubmitOutcome {
  status: SubmitStepStatus;
  verdict?: SubmitStepVerdict;
}

export function advanceLoop(loop: TaskLoop, submit: SubmitOutcome): LoopDecision {
  // ③ Real blocker → pause, round unchanged.
  if (submit.status === 'blocked') {
    return { outcome: 'pause', nextStatus: 'paused', nextRound: loop.round, reason: 'engineer blocked' };
  }
  // ① Passed → done, round unchanged.
  if (submit.verdict === 'pass') {
    return { outcome: 'done', nextStatus: 'done', nextRound: loop.round, reason: 'reviewer passed' };
  }
  // A step completed but needs changes (or gave no verdict) → next round.
  const nextRound = loop.round + 1;
  // ② Round cap reached → ask the user, don't auto-abandon.
  if (loop.max_rounds > 0 && nextRound >= loop.max_rounds) {
    return { outcome: 'ask-continue', nextStatus: 'paused', nextRound, reason: 'round budget reached' };
  }
  return { outcome: 'continue', nextStatus: 'active', nextRound, reason: 'changes requested' };
}
