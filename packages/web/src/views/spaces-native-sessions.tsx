import { useEffect, useRef, useState } from 'react';
import type { ApprovalMode, Executor, NativeSession, Workspace } from '@gian/shared';
import { adoptNativeSession, deleteNativeSession, loadNativeSessions } from '../api.js';
import { confirm } from '../feedback.js';

const I = {
  check: 'M5 12l5 5L20 7',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 8v.01 M11 12h1v5h1',
  kebabV: 'M12 5.01v-.02 M12 12.01v-.02 M12 19.01v-.02',
};

function Icon({ d, size = 16, stroke = 1.6 }: { d: string; size?: number; stroke?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  );
}

function HelpHint({ children }: { children: React.ReactNode }) {
  return (
    <span className="help-hint" tabIndex={0}>
      <span className="help-hint-trigger" aria-label="More info">
        <Icon d={I.info} size={12} stroke={1.8} />
      </span>
      <span className="help-hint-pop" role="tooltip">{children}</span>
    </span>
  );
}

export function NativeSessionsPane({
  workspace,
  onChange,
}: {
  workspace: Workspace;
  onChange: () => void;
}) {
  const [sessions, setSessions] = useState<NativeSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [executor, setExecutor] = useState<'all' | Executor>('all');
  const [status, setStatus] = useState<'all' | 'adopted' | 'available'>('all');
  const [adoptingFor, setAdoptingFor] = useState<NativeSession | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    const list = await loadNativeSessions(workspace.id);
    setSessions(list);
    setLoading(false);
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id]);

  const filtered = sessions.filter(s => {
    if (executor !== 'all' && s.executor !== executor) return false;
    if (status === 'adopted' && !s.adoptedBy) return false;
    if (status === 'available' && s.adoptedBy) return false;
    return true;
  });

  async function handleDelete(s: NativeSession) {
    if (!(await confirm({
      message: `Delete native ${s.executor} session ${s.id.slice(0, 8)}…?\nThis removes the .jsonl file from disk and cannot be undone.`,
      danger: true,
    }))) return;
    const r = await deleteNativeSession(workspace.id, s.executor, s.id);
    if (!r.ok) {
      setError(r.error ?? 'Delete failed');
      return;
    }
    setError(null);
    void refresh();
  }

  return (
    <>
      <div style={{ font: 'var(--fz-12)/1.5 var(--font-sans)', color: 'var(--text-2)', marginTop: -4, marginBottom: 14, display: 'inline-flex', alignItems: 'flex-start', gap: 4, flexWrap: 'wrap' }}>
        <span>
          Sessions discovered through Claude, Codex, and Kimi Code. <b>Adopt</b> a session to manage it from Gian.
        </span>
        <HelpHint>
          Claude and Codex keep JSONL history; Kimi exposes history through
          ACP. Gian can <b>adopt</b> either form without changing the
          executor-owned source.
        </HelpHint>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div className="segm">
          <button className={`segm-item${executor === 'all' ? ' active' : ''}`} onClick={() => setExecutor('all')}>All</button>
          <button className={`segm-item${executor === 'claude' ? ' active' : ''}`} onClick={() => setExecutor('claude')}>Claude</button>
          <button className={`segm-item${executor === 'codex' ? ' active' : ''}`} onClick={() => setExecutor('codex')}>Codex</button>
          <button className={`segm-item${executor === 'kimi' ? ' active' : ''}`} onClick={() => setExecutor('kimi')}>Kimi</button>
        </div>
        <div className="segm">
          <button className={`segm-item${status === 'all' ? ' active' : ''}`} onClick={() => setStatus('all')}>All</button>
          <button className={`segm-item${status === 'adopted' ? ' active' : ''}`} onClick={() => setStatus('adopted')}>Adopted</button>
          <button className={`segm-item${status === 'available' ? ' active' : ''}`} onClick={() => setStatus('available')}>Available</button>
        </div>
        <span style={{ marginLeft: 'auto', font: '500 var(--fz-10)/1 var(--font-mono)', textTransform: 'none', letterSpacing: '0.06em', color: 'var(--text-3)' }}>
          {filtered.length} sessions
        </span>
      </div>

      {error && <p className="spaces-error">{error}</p>}

      <div className="card">
        <div className="card-body compact">
          {loading && (
            <div className="wt-row" style={{ color: 'var(--text-3)' }}>
              <span className="spinner" aria-hidden="true" />
              <span>Loading…</span>
            </div>
          )}
          {!loading && filtered.length === 0 && (
            <div className="wt-row" style={{ color: 'var(--text-3)' }}>
              No native sessions in this workspace.
            </div>
          )}
          {filtered.map(s => (
            <NativeSessionRow
              key={`${s.executor}:${s.id}`}
              session={s}
              onAdopt={() => setAdoptingFor(s)}
              onDelete={() => void handleDelete(s)}
            />
          ))}
        </div>
      </div>

      {adoptingFor && (
        <AdoptDialog
          source={adoptingFor}
          onCancel={() => setAdoptingFor(null)}
          onAdopted={() => {
            setAdoptingFor(null);
            void refresh();
            onChange();
          }}
          workspaceId={workspace.id}
        />
      )}
    </>
  );
}

function NativeSessionRow({
  session,
  onAdopt,
  onDelete,
}: {
  session: NativeSession;
  onAdopt: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) {
      setCopied(false);
      return;
    }
    const close = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menuOpen]);
  async function copyId() {
    try {
      await navigator.clipboard.writeText(session.id);
      setCopied(true);
      setTimeout(() => { setCopied(false); setMenuOpen(false); }, 900);
    } catch {
      setMenuOpen(false);
    }
  }
  const adopted = !!session.adoptedBy;
  const adoptedName = session.adoptedBy?.gianSessionName ?? session.adoptedBy?.gianSessionId.slice(0, 8);
  const meta = [
    session.gitBranch,
    relTime(session.updatedAt),
    `${session.turnCount} turns`,
    fmtBytes(session.fileSize),
  ].filter(Boolean).join(' · ');
  return (
    <div
      className="wt-row"
      style={{ gridTemplateColumns: '18px 1fr 110px 22px' }}
    >
      <span className="wt-ico" title={session.executor}>
        <span
          style={{
            display: 'inline-block',
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: session.executor === 'claude'
              ? 'var(--claude)'
              : session.executor === 'codex'
                ? 'var(--codex)'
                : 'var(--kimi, #29a86b)',
          }}
        />
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ font: '500 var(--fz-13)/1.3 var(--font-sans)', color: 'var(--text)' }}>
            {adopted ? adoptedName : (
              <span style={{ color: 'var(--text-3)', fontStyle: 'italic' }}>unadopted session</span>
            )}
          </span>
          <span className="main-tag">{session.executor}</span>
          <span className="mono" style={{ color: 'var(--text-3)', fontSize: 'var(--fz-11)' }}>
            {meta}
          </span>
        </div>
        <div style={{ color: 'var(--text-2)', fontSize: 'var(--fz-12)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {session.firstUserMessage || '(no user message)'}
        </div>
      </div>
      {adopted ? (
        <span style={{ font: '500 var(--fz-12)/1.4 var(--font-sans)', color: 'var(--ok)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Icon d={I.check} size={12} stroke={2.4} /> Adopted
        </span>
      ) : (
        <button className="btn primary sm" onClick={onAdopt}>Adopt</button>
      )}
      <div className="ws-kebab-anchor" ref={ref}>
        <button
          className="wt-kebab"
          onClick={() => setMenuOpen(o => !o)}
          title="More"
          aria-label="More actions"
        >
          <Icon d={I.kebabV} size={14} />
        </button>
        {menuOpen && (
          <div className="ws-kebab-pop">
            <button
              className="ws-kebab-item"
              onClick={() => void copyId()}
            >
              {copied ? 'Copied!' : 'Copy native session ID'}
            </button>
            {session.executor !== 'kimi' && (
              <button
                className="ws-kebab-item danger"
                disabled={adopted}
                title={adopted ? 'Unbind the Gian session before deleting the underlying native session' : ''}
                onClick={() => { setMenuOpen(false); onDelete(); }}
              >
                Delete native session
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AdoptDialog({
  source, onCancel, onAdopted, workspaceId,
}: {
  source: NativeSession;
  workspaceId: string;
  onCancel: () => void;
  onAdopted: () => void;
}) {
  const [name, setName] = useState('');
  const [mode, setMode] = useState<ApprovalMode>('ask');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    const result = await adoptNativeSession(workspaceId, {
      executor: source.executor,
      native_session_id: source.id,
      ...(source.executor === 'kimi' ? {} : { approval_mode: mode }),
      ...(name.trim() ? { name: name.trim() } : {}),
    });
    setSubmitting(false);
    if (!result.session) {
      setError(result.error ?? 'Adopt failed');
      return;
    }
    onAdopted();
  }

  return (
    <div className="adopt-dialog-backdrop" onClick={onCancel}>
      <div className="adopt-dialog" onClick={e => e.stopPropagation()}>
        <header className="adopt-dialog-head">
          <h2 className="adopt-dialog-title">Adopt as Gian session</h2>
          <p className="adopt-dialog-sub">
            Continue this conversation in Gian using the same executor-owned native session. You can switch back to the CLI at any time.
          </p>
        </header>
        <div className="adopt-dialog-body">
          <div className="adopt-source">
            <span className={`ns-exec-dot ${source.executor}`} />
            <div className="adopt-source-info">
              <div className="adopt-source-meta">
                <span className="adopt-source-exec">{source.executor}</span>
                <span style={{ color: 'var(--text-3)' }}>·</span>
                <span className="adopt-source-id">{source.id}</span>
              </div>
              <div className="adopt-source-msg" title={source.firstUserMessage}>
                {source.firstUserMessage || '(no user message)'}
              </div>
            </div>
          </div>

          <div className="adopt-field">
            <label className="adopt-label">Session name</label>
            <input
              className="input"
              placeholder="auto-generated"
              value={name}
              onChange={e => setName(e.target.value)}
            />
          </div>

          {source.executor !== 'kimi' && <div className="adopt-field">
            <label className="adopt-label">Approval mode</label>
            <div className="segm" style={{ width: 'fit-content' }}>
              {(source.executor === 'codex'
                ? ['custom', 'ask', 'auto', 'full-access']
                : ['plan', 'ask', 'auto']
              ).map(m => (
                <button
                  key={m}
                  type="button"
                  className={`segm-item${mode === m ? ' active' : ''}`}
                  onClick={() => setMode(m as ApprovalMode)}
                >
                  {m === 'custom'
                    ? 'Custom'
                    : m === 'full-access'
                      ? 'Full access'
                      : m === 'auto' && source.executor === 'codex'
                        ? 'Approve for me'
                        : m === 'plan'
                          ? 'Plan'
                          : m === 'ask'
                            ? 'Ask'
                            : 'Auto'}
                </button>
              ))}
            </div>
          </div>}

          {error && <p className="spaces-error">{error}</p>}
        </div>
        <footer className="adopt-dialog-foot">
          <button className="btn ghost" onClick={onCancel} disabled={submitting}>Cancel</button>
          <button
            className="btn primary"
            onClick={() => void submit()}
            disabled={submitting}
          >
            {submitting ? 'Adopting…' : 'Adopt'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
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

