import { useEffect, useRef, useState } from 'react';
import type { Session, Workspace } from '@gian/shared';
import { loadArchivedSessions } from '../api.js';
import { confirm } from '../feedback.js';
import { useOperationDispatch, useOperationRun } from '../operations/use-operations.js';
import type { OperationName } from '../operations/types.js';

// Archived-conversations pane (Spaces view → Archived tab): lists this
// workspace's archived Gian sessions and offers Restore (unarchive → back to
// the session sidebar) and Delete (permanent) per row.
//
// Phase 3a: both actions dispatch the WS-backed session.archive /
// session.delete operations (the socket is available app-wide and this pane
// renders inside the App's operation providers) instead of the REST
// setSessionArchived/deleteSession helpers — one policy path per command,
// request-correlated results, and the duplicate pending destructive guard.
// The REST duplicates were dropped from api.ts with this migration (the git
// pane's inline DELETE fetch at spaces-git-pane.tsx is separate Phase 3b
// scope). The pane's own list is query state: it refreshes once the run
// confirms (the canonical session:updated/session:deleted broadcasts update
// the App-level lists independently).
export function ArchivedSessionsPane({
  workspace,
  onChange,
}: {
  workspace: Workspace;
  onChange: () => void;
}) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshGeneration = useRef(0);

  async function refresh() {
    const generation = ++refreshGeneration.current;
    setLoading(true);
    try {
      const list = await loadArchivedSessions();
      if (generation !== refreshGeneration.current) return;
      setSessions(list.filter(s => s.workspace_id === workspace.id));
      setError(null);
    } catch (thrown) {
      if (generation !== refreshGeneration.current) return;
      setError(thrown instanceof Error ? thrown.message : 'Failed to load archived sessions');
    } finally {
      if (generation === refreshGeneration.current) setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    return () => { refreshGeneration.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id]);

  return (
    <>
      <div style={{ font: 'var(--fz-12)/1.5 var(--font-sans)', color: 'var(--text-2)', marginTop: -4, marginBottom: 14 }}>
        Conversations archived from the session sidebar. <b>Restore</b> moves a conversation back to the sidebar; <b>Delete</b> removes it permanently.
      </div>

      {error && (
        <div className="spaces-error" role="alert">
          <span>{error}</span>{' '}
          <button className="btn xs" onClick={() => void refresh()}>Retry</button>
        </div>
      )}

      <div className="card">
        <div className="card-body compact">
          {loading && (
            <div style={{ padding: '12px 12px', color: 'var(--text-3)' }}>Loading…</div>
          )}
          {!loading && sessions.length === 0 && (
            <div style={{ padding: '12px 12px', color: 'var(--text-3)' }}>
              No archived conversations in this workspace.
            </div>
          )}
          {sessions.map(s => (
            <ArchivedRow
              key={s.id}
              session={s}
              onSettled={failure => {
                setError(failure);
                if (!failure) {
                  void refresh();
                  onChange();
                }
              }}
            />
          ))}
        </div>
      </div>
    </>
  );
}

/** One archived row + its Restore/Delete actions. Tracks the dispatched
 *  operation run so the buttons stay pending until the correlated result,
 *  then reports the outcome upward (`onSettled(errorMessage | null)`). */
function ArchivedRow({
  session: s,
  onSettled,
}: {
  session: Session;
  onSettled: (error: string | null) => void;
}) {
  const dispatch = useOperationDispatch();
  const [run, setRun] = useState<{ runId: string; name: OperationName } | null>(null);
  const opRun = useOperationRun(run?.runId);
  const busy = opRun?.phase === 'pending' || opRun?.phase === 'optimistic';

  useEffect(() => {
    if (!run || !opRun) return;
    if (opRun.phase === 'confirmed') {
      setRun(null);
      onSettled(null);
    } else if (opRun.phase === 'failed') {
      const name = run.name;
      setRun(null);
      onSettled(opRun.error ?? (name === 'session.delete' ? 'Delete failed' : 'Restore failed'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opRun?.phase]);

  async function handleRestore() {
    const dispatched = dispatch('session.archive', { sessionId: s.id, archived: false });
    setRun({ runId: dispatched.id, name: 'session.archive' });
  }

  async function handleDelete() {
    const label = s.name ?? s.id.slice(0, 8);
    if (!(await confirm({
      message: `Delete archived session "${label}"?\nThis removes the session and its history permanently and cannot be undone.`,
      danger: true,
      confirmLabel: 'Delete',
    }))) return;
    const dispatched = dispatch('session.delete', { sessionId: s.id });
    setRun({ runId: dispatched.id, name: 'session.delete' });
  }

  return (
    <div
      className="wt-row"
      data-testid={`archived-session-${s.id}`}
      style={{ gridTemplateColumns: '1fr auto auto', alignItems: 'center' }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ font: '500 var(--fz-13)/1.3 var(--font-sans)', color: 'var(--text)' }}>
            {s.name ?? <span style={{ color: 'var(--text-3)', fontStyle: 'italic' }}>unnamed session</span>}
          </span>
          <span className="mono" style={{ color: 'var(--text-3)', fontSize: 'var(--fz-11)' }}>
            {s.executor}{s.branch ? ` · ${s.branch}` : ''} · {relTime(s.updated_at)}
          </span>
        </div>
      </div>
      <button data-testid={`archived-restore-${s.id}`} className="btn sm" disabled={busy} onClick={() => void handleRestore()}>Restore</button>
      <button data-testid={`archived-delete-${s.id}`} className="btn sm danger" disabled={busy} onClick={() => void handleDelete()}>Delete</button>
    </div>
  );
}

function relTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
