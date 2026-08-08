/**
 * Git History — panel 2 commit change-set review (Sheet 'commit' tab body).
 * Visual + interaction baseline: design/git-history/index.html §3.
 *
 * - The commit detail loads once per tab (history group tabs stay mounted in
 *   their slots, so loaded content and scroll survive tab/rail switches).
 * - File patches load LAZILY per file — on expand or when the placeholder
 *   scrolls near the viewport (IntersectionObserver); never a prefetched N+1
 *   (git-history proposal §5).
 * - merge commits review against the first parent, root commits against the
 *   empty tree — both fixed by the host contract (`detail.base`), the base
 *   strip is display-only.
 * - unified⇄split and word-wrap mirror the existing diff-tab controls and
 *   persist to the same localStorage keys.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  loadGitHistoryCommit,
  loadGitHistoryFileDiff,
  type GitHistoryChangedFile,
  type GitHistoryCommitDetail,
  type GitHistoryFileDiff,
  type GitHistoryRef,
} from '../api.js';
import { useT } from '../i18n/index.js';
import { toast } from '../feedback.js';
import { relTime } from '../views/session-list-status.js';
import { DiffBody } from './Sheet.js';
import type { SheetTab } from './sheet-model.js';

function Icon({ d, size = 13, stroke = 1.5 }: { d: string; size?: number; stroke?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
         strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const I = {
  commit: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M3 12h6 M15 12h6',
  branch: 'M6 3v12 M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M18 9a9 9 0 0 1-9 9',
  tag: 'M3.5 3.5h7L20 13l-7 7L3.5 10.5z M8 8h.01',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M3 12h18 M12 3c2.6 2.5 4 5.6 4 9s-1.4 6.5-4 9c-2.6-2.5-4-5.6-4-9s1.4-6.5 4-9z',
  copy: 'M8 8h11v13H8z M5 16V3h11',
  kebab: 'M12 5.01v-.02 M12 12.01v-.02 M12 19.01v-.02',
  split: 'M8 3.5v17 M16 3.5v17 M3.5 3.5h17v17h-17z',
  wrap: 'M3.5 6h17 M3.5 10h17M3.5 14h10a3 3 0 1 1 0 6H11 M13.5 17.5L11 20l2.5 2.5 M3.5 18h4',
  warnTri: 'M12 4l9.5 16.5h-19z M12 10v4.5 M12 17.8h.01',
  file: 'M6.5 3.5h6L17 8v12.5h-10.5z M12.5 3.5V8H17',
  diff: 'M8.5 4v13 M8.5 4l-3 3 M8.5 4l3 3 M15.5 20V7 M15.5 20l3-3 M15.5 20l-3-3',
};

function refChipIcon(kind: GitHistoryRef['kind']): string {
  return kind === 'local' ? I.branch : kind === 'remote' ? I.globe : I.tag;
}

const WRAP_KEY = 'gian.sheet.wordwrap';
const SPLIT_KEY = 'gian.sheet.diffsplit';

function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return fallback;
    return v === 'on' || v === 'true';
  } catch {
    return fallback;
  }
}

/** Status badge for one changed file — letter + color double-code the kind
 *  (never color alone). */
function statusBadge(file: GitHistoryChangedFile): { cls: string; txt: string } {
  if (file.binary) return { cls: 'bin', txt: 'B' };
  switch (file.status) {
    case 'added': return { cls: 'add', txt: 'A' };
    case 'deleted': return { cls: 'del', txt: 'D' };
    case 'renamed': return { cls: 'ren', txt: 'R' };
    case 'copied': return { cls: 'ren', txt: 'C' };
    case 'type-changed': return { cls: 'sub', txt: 'T' };
    case 'modified': return { cls: 'mod', txt: 'M' };
    default: return { cls: 'sub', txt: '?' };
  }
}

interface FileState {
  status: 'idle' | 'loading' | 'loaded' | 'error';
  diff: GitHistoryFileDiff | null;
}

function FileDiffBlock({
  workingTreeId,
  sha,
  file,
  split,
  wrap,
  collapsed,
  onToggle,
}: {
  workingTreeId: string;
  sha: string;
  file: GitHistoryChangedFile;
  split: boolean;
  wrap: boolean;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const [state, setState] = useState<FileState>({ status: 'idle', diff: null });
  const anchorRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<FileState['status']>('idle');
  const requestSeq = useRef(0);

  const startLoad = useCallback(() => {
    if (statusRef.current === 'loading' || statusRef.current === 'loaded') return;
    statusRef.current = 'loading';
    const seq = ++requestSeq.current;
    setState({ status: 'loading', diff: null });
    loadGitHistoryFileDiff(workingTreeId, sha, file.path)
      .then(diff => {
        if (requestSeq.current !== seq) return;
        statusRef.current = 'loaded';
        setState({ status: 'loaded', diff });
      })
      .catch(() => {
        if (requestSeq.current !== seq) return;
        statusRef.current = 'error';
        setState({ status: 'error', diff: null });
      });
  }, [workingTreeId, sha, file.path]);

  useEffect(() => () => {
    requestSeq.current += 1;
  }, []);

  /* Viewport trigger: load when the placeholder scrolls near the visible
   *  area. Binary files never fetch — there is no textual diff to show. */
  useEffect(() => {
    if (collapsed || file.binary || state.status !== 'idle') return;
    const el = anchorRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      startLoad();
      return;
    }
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) {
        io.disconnect();
        startLoad();
      }
    }, { rootMargin: '240px' });
    io.observe(el);
    return () => io.disconnect();
  }, [collapsed, file.binary, state.status, startLoad]);

  const badge = statusBadge(file);
  const body: React.ReactNode = collapsed ? null : file.binary ? (
    <div className="cs-file-body">
      <div className="cs-file-note">
        <Icon d={I.file} size={12} stroke={1.6} />
        <span>{t('history.file.binary')}</span>
      </div>
    </div>
  ) : state.status === 'loading' || state.status === 'idle' ? (
    <div className="cs-file-body" ref={anchorRef}>
      <div className="sk" aria-label={t('history.file.loading')}>
        <span className="sk-line hunk" />
        <span className="sk-line" style={{ width: '88%' }} />
        <span className="sk-line" style={{ width: '72%' }} />
        <span className="sk-line" style={{ width: '81%' }} />
      </div>
    </div>
  ) : state.status === 'error' ? (
    <div className="cs-file-body">
      <div className="cs-file-note err" role="alert">
        <Icon d={I.warnTri} size={12} stroke={1.7} />
        <span style={{ flex: 1, minWidth: 0 }}>{t('history.file.failed')}</span>
        <button className="btn secondary sm" onClick={e => { e.stopPropagation(); startLoad(); }}>
          {t('common.retry')}
        </button>
      </div>
    </div>
  ) : (
    <div className="cs-file-body">
      {state.diff?.truncated && (
        <div className="cs-file-note warn" role="status">
          <Icon d={I.warnTri} size={12} stroke={1.7} />
          <span>{t('history.file.truncated')}</span>
        </div>
      )}
      {state.diff && <DiffBody diffText={state.diff.diff} path={file.path} split={split} wrap={wrap} />}
    </div>
  );

  return (
    <div className={`cs-file${collapsed ? ' collapsed' : ''}`} data-path={file.path}>
      <div className="cs-file-head" role="button" tabIndex={0} aria-expanded={!collapsed}
           title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
           onClick={onToggle}
           onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}>
        <span className="caret">▾</span>
        <span className={`cs-badge ${badge.cls}`}>{badge.txt}</span>
        <span className="cs-file-path">
          {file.oldPath
            ? <><span className="old">{file.oldPath}</span><span className="arrow">→</span>{file.path}</>
            : file.path}
        </span>
        {file.binary
          ? <span className="tag-note">{t('history.file.binaryTag')}</span>
          : (
            <span className="stat">
              {file.added > 0 && <span className="add">+{file.added}</span>}
              {file.removed > 0 && <span className="del">−{file.removed}</span>}
            </span>
          )}
      </div>
      {body}
    </div>
  );
}

export function HistoryCommitBody({
  tab,
  onOpenCommit,
}: {
  tab: SheetTab;
  onOpenCommit: (commit: { sha: string; subject?: string }, permanent: boolean) => void;
}) {
  const t = useT();
  const workingTreeId = tab.workingTreeId ?? null;
  const sha = tab.commitSha ?? '';
  const [detail, setDetail] = useState<GitHistoryCommitDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});
  const [menuOpen, setMenuOpen] = useState(false);
  const [wrap, setWrap] = useState(() => readBool(WRAP_KEY, true));
  const [split, setSplit] = useState(() => readBool(SPLIT_KEY, false));
  const detailRequestSeq = useRef(0);

  const load = useCallback(() => {
    const seq = ++detailRequestSeq.current;
    if (!workingTreeId || !sha) {
      setLoading(false);
      setLoadError(t('history.loadFailed'));
      return;
    }
    setLoading(true);
    setLoadError(null);
    setDetail(null);
    setCollapsed({});
    loadGitHistoryCommit(workingTreeId, sha)
      .then(d => {
        if (detailRequestSeq.current !== seq) return;
        setDetail(d);
        setLoading(false);
      })
      .catch(err => {
        if (detailRequestSeq.current !== seq) return;
        setLoadError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, [workingTreeId, sha, t]);

  useEffect(() => {
    load();
    return () => { detailRequestSeq.current += 1; };
  }, [load]);

  function togglePref(kind: 'wrap' | 'split'): void {
    if (kind === 'wrap') {
      setWrap(w => {
        try { localStorage.setItem(WRAP_KEY, w ? 'off' : 'on'); } catch { /* storage disabled */ }
        return !w;
      });
    } else {
      setSplit(s => {
        try { localStorage.setItem(SPLIT_KEY, s ? 'off' : 'on'); } catch { /* storage disabled */ }
        return !s;
      });
    }
  }

  function copy(text: string, key: string): void {
    try { void navigator.clipboard?.writeText(text).catch(() => undefined); } catch { /* clipboard blocked */ }
    toast({ kind: 'success', message: t(key) });
    setMenuOpen(false);
  }

  const short = sha.slice(0, 7);
  const totals = detail
    ? detail.files.reduce((acc, f) => ({ add: acc.add + f.added, del: acc.del + f.removed }), { add: 0, del: 0 })
    : { add: 0, del: 0 };

  return (
    <div className={`cs-root${wrap ? '' : ' cs-nowrap'}`}>
      <div className="cs-bar">
        <span className="ext-ico commit"><Icon d={I.commit} size={12} stroke={1.6} /></span>
        <span className="cs-bar-title">
          <span className="cs-bar-sha">{short}</span>
          <span className="cs-bar-subject">{detail?.subject ?? tab.name}</span>
        </span>
        <button className={`sheet-tabs-act${split ? ' active' : ''}`} aria-pressed={split}
                title={split ? t('sheet.diffview.toUnified') : t('sheet.diffview.toSplit')}
                aria-label={split ? t('sheet.diffview.toUnified') : t('sheet.diffview.toSplit')}
                onClick={() => togglePref('split')}>
          <Icon d={I.split} size={12} stroke={1.6} />
        </button>
        <button className={`sheet-tabs-act${wrap ? ' active' : ''}`} aria-pressed={wrap}
                title={wrap ? t('sheet.wordwrap.disable') : t('sheet.wordwrap.enable')}
                aria-label={wrap ? t('sheet.wordwrap.disable') : t('sheet.wordwrap.enable')}
                onClick={() => togglePref('wrap')}>
          <Icon d={I.wrap} size={12} stroke={1.6} />
        </button>
        <span className="h-menu-anchor">
          <button className={`sheet-tabs-act${menuOpen ? ' active' : ''}`} title={t('sheet.more')}
                  aria-label={t('sheet.more')} aria-haspopup="menu" aria-expanded={menuOpen}
                  onClick={() => setMenuOpen(o => !o)}>
            <Icon d={I.kebab} size={14} stroke={2.4} />
          </button>
          {menuOpen && (
            <>
              <div className="h-menu-backdrop" onClick={() => setMenuOpen(false)} />
              <div className="h-menu cs-menu" role="menu">
                <button role="menuitem" onClick={() => copy(sha, 'history.copied.sha')}>
                  <Icon d={I.copy} size={12} stroke={1.6} /> {t('history.copySha')}
                </button>
                <button role="menuitem" onClick={() => copy(detail?.subject ?? tab.name, 'history.copied.subject')}>
                  <Icon d={I.copy} size={12} stroke={1.6} /> {t('history.copySubject')}
                </button>
                <div className="h-menu-sep" />
                <button role="menuitem" onClick={() => {
                  const next: Record<number, boolean> = {};
                  detail?.files.forEach((_, i) => { next[i] = true; });
                  setCollapsed(next);
                  setMenuOpen(false);
                }}>{t('history.collapseAll')}</button>
                <button role="menuitem" onClick={() => { setCollapsed({}); setMenuOpen(false); }}>
                  {t('history.expandAll')}
                </button>
              </div>
            </>
          )}
        </span>
      </div>

      {tab.orphaned && (
        <div className="cs-banner" role="alert">
          <Icon d={I.warnTri} stroke={1.7} />
          <span><b>{t('history.orphaned.title')}</b> {t('history.orphaned.sub')}</span>
        </div>
      )}

      {loading ? (
        <div className="cs-head-skeleton">
          <span className="sk-line" style={{ width: '46%', height: 16 }} />
          <span className="sk-line" style={{ width: '64%' }} />
          <span className="sk-line" style={{ width: '38%' }} />
        </div>
      ) : loadError ? (
        <div className="sheet-empty">
          {loadError}
          <button className="btn sm secondary" type="button" onClick={load}>{t('sheet.retry')}</button>
        </div>
      ) : detail ? (
        <>
          <div className="cs-head">
            <div className="cs-subject">{detail.subject}</div>
            <div className="cs-meta">
              <span className="cs-author">
                <span className="cs-avatar">{(detail.author.name || '?').slice(0, 1)}</span>
                {detail.author.name}
              </span>
              <span className="cs-date" title={detail.committedAt}>
                {t('history.committed')} {new Date(detail.committedAt).toLocaleString()} · {relTime(detail.committedAt)}
              </span>
              <button className="cs-sha-btn" title={t('history.copySha')} onClick={() => copy(sha, 'history.copied.sha')}>
                {short}<Icon d={I.copy} size={11} stroke={1.6} />
              </button>
            </div>
            {detail.refs.length > 0 && (
              <div className="cs-row">
                <span className="lbl">{t('history.refs')}</span>
                {detail.refs.map(r => (
                  <span key={r.name} className={`h-ref ${r.kind}`} title={r.name}>
                    <Icon d={refChipIcon(r.kind)} size={9} stroke={1.8} />
                    <span className="n">{r.shortName}</span>
                  </span>
                ))}
              </div>
            )}
            <div className="cs-row">
              <span className="lbl">{t('history.parents')}</span>
              {detail.parents.length === 0
                ? <span className="cs-date">{t('history.parents.root')}</span>
                : detail.parents.map((p, i) => (
                  <button key={p} className="cs-parent"
                          title={detail.isMerge && i === 0 ? t('history.parents.first') : p}
                          onClick={() => onOpenCommit({ sha: p }, false)}>
                    <Icon d={I.commit} size={10} stroke={1.6} />{p.slice(0, 7)}
                  </button>
                ))}
            </div>
            {detail.isMerge && (
              <div>
                <span className="cs-base" title={t('history.base.mergeTitle')}>
                  <Icon d={I.diff} size={11} stroke={1.6} />
                  {t('history.base.merge')} <b>&nbsp;{detail.base.slice(0, 7)}</b>
                </span>
              </div>
            )}
            {detail.isRoot && (
              <div>
                <span className="cs-base" title={t('history.base.rootTitle')}>
                  <Icon d={I.diff} size={11} stroke={1.6} />
                  {t('history.base.root')}
                </span>
              </div>
            )}
            <div className="cs-stats">
              <span className="files">{detail.files.length} {t('changes.files')}</span>
              <span className="add">+{totals.add}</span>
              <span className="del">−{totals.del}</span>
            </div>
          </div>
          <div className="cs-files">
            {detail.files.map((f, i) => (
              <FileDiffBlock
                key={`${sha}:${f.oldPath ?? ''}->${f.path}`}
                workingTreeId={workingTreeId!}
                sha={sha}
                file={f}
                split={split}
                wrap={wrap}
                collapsed={collapsed[i] ?? false}
                onToggle={() => setCollapsed(c => ({ ...c, [i]: !(c[i] ?? false) }))}
              />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
