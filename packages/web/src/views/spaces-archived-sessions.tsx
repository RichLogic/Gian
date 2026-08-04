import { useEffect, useState } from 'react';
import type { Session, Workspace } from '@gian/shared';
import { deleteSession, loadArchivedSessions, setSessionArchived } from '../api.js';
import { confirm } from '../feedback.js';

// Archived-conversations pane (Spaces view → Archived tab): lists this
// workspace's archived Gian sessions and offers Restore (unarchive → back to
// the session sidebar) and Delete (permanent) per row.
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

  async function refresh() {
    setLoading(true);
    const list = await loadArchivedSessions();
    setSessions(list.filter(s => s.workspace_id === workspace.id));
    setLoading(false);
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id]);

  async function handleRestore(s: Session) {
    const ok = await setSessionArchived(s.id, false);
    if (!ok) {
      setError('Restore failed');
      return;
    }
    setError(null);
    void refresh();
    onChange();
  }

  async function handleDelete(s: Session) {
    const label = s.name ?? s.id.slice(0, 8);
    if (!(await confirm({
      message: `Delete archived session "${label}"?\nThis removes the session and its history permanently and cannot be undone.`,
      danger: true,
      confirmLabel: 'Delete',
    }))) return;
    const r = await deleteSession(s.id);
    if (!r.ok) {
      setError(r.error ?? 'Delete failed');
      return;
    }
    setError(null);
    void refresh();
    onChange();
  }

  return (
    <>
      <div style={{ font: 'var(--fz-12)/1.5 var(--font-sans)', color: 'var(--text-2)', marginTop: -4, marginBottom: 14 }}>
        Conversations archived from the session sidebar. <b>Restore</b> moves a conversation back to the sidebar; <b>Delete</b> removes it permanently.
      </div>

      {error && <p className="spaces-error">{error}</p>}

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
            <div
              key={s.id}
              className="wt-row"
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
              <button className="btn sm" onClick={() => void handleRestore(s)}>Restore</button>
              <button className="btn sm danger" onClick={() => void handleDelete(s)}>Delete</button>
            </div>
          ))}
        </div>
      </div>
    </>
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
