import type { Session } from '@gian/shared';
import type { TranscriptItem } from '../types.js';

interface JobProgressProps {
  session: Session;
  items: TranscriptItem[];
}

/**
 * Progress bar shown only when approval_mode === 'auto' and turns > 1.
 * Derives completed-turn count from the items array by counting turn-end items
 * since the last user message. No new WS message type needed.
 */
export function JobProgress({ session, items }: JobProgressProps) {
  if (session.approval_mode !== 'auto' || session.turns <= 1) return null;

  const totalTurns = session.turns;

  // Find the last user message index — that's where the job started.
  let jobStartIdx = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]?.kind === 'user') {
      jobStartIdx = i;
      break;
    }
  }

  // Count turn-end items from that point forward.
  const completedTurns =
    jobStartIdx >= 0
      ? items.slice(jobStartIdx).filter(it => it.kind === 'turn-end').length
      : 0;

  // Only render when there's meaningful job activity.
  if (completedTurns === 0 && session.status !== 'running') return null;

  const pct = Math.min(completedTurns / totalTurns, 1);
  const isDone = completedTurns >= totalTurns || session.status === 'done' || session.status === 'error';

  return (
    <div className="job-progress" data-done={isDone ? '' : undefined}>
      <span className="job-progress-label">
        Turn {Math.min(completedTurns + (session.status === 'running' ? 1 : 0), totalTurns)} / {totalTurns}
      </span>
      <div className="job-progress-track">
        <div
          className={`job-progress-fill${isDone ? ' done' : ''}`}
          style={{ width: `${pct * 100}%` }}
        />
      </div>
      {isDone && (
        <span className="job-progress-status">
          {session.status === 'error' ? 'stopped · error' : 'complete'}
        </span>
      )}
    </div>
  );
}
