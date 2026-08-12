/**
 * Diffs rail — panel 2: the singleton multi-file diff view (Sheet 'changes'
 * tab body). Same UX shape as HistoryCommitBody: every file of the current
 * scope is a collapsible diff block, patches load LAZILY per file
 * (IntersectionObserver), per-block error + retry, binary/truncation notes.
 *
 * - The scope itself lives in controllers/use-changes-diff.ts (owned by the
 *   panel-3 Changes inspector); this body is a read view over that store —
 *   switch the scope in the inspector and this view follows.
 * - The diffs group stays mounted in its slot, so loaded patches and scroll
 *   survive rail switches.
 * - An inspector row click lands here as a store anchor request: expand the
 *   file's block and scroll it into view (again once its patch settles).
 * - unified⇄split and word-wrap persist to the same localStorage keys as the
 *   History commit body.
 */
import { useEffect, useRef, useState } from 'react';
import type { ChangedEntry } from '../api.js';
import { useT } from '../i18n/index.js';
import {
  consumeChangesDiffAnchor,
  ensureChangesDiffLoaded,
  ensureChangesDiffPatch,
  refreshChangesDiff,
  retryChangesDiffPatch,
  setAllChangesDiffCollapsed,
  toggleChangesDiffCollapsed,
  useChangesDiffState,
  type ChangesDiffAnchor,
  type ChangesDiffPatch,
} from '../controllers/use-changes-diff.js';
import { DiffBody } from './Sheet.js';

function Icon({ d, size = 13, stroke = 1.5 }: { d: string; size?: number; stroke?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
         strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const I = {
  split: 'M8 3.5v17 M16 3.5v17 M3.5 3.5h17v17h-17z',
  wrap: 'M3.5 6h17 M3.5 10h17M3.5 14h10a3 3 0 1 1 0 6H11 M13.5 17.5L11 20l2.5 2.5 M3.5 18h4',
  fold: 'M8.5 3.5L12 7l3.5-3.5 M8.5 20.5L12 17l3.5 3.5',
  unfold: 'M8.5 7L12 3.5 15.5 7 M8.5 17l3.5 3.5 3.5-3.5',
  warnTri: 'M12 4l9.5 16.5h-19z M12 10v4.5 M12 17.8h.01',
  file: 'M6.5 3.5h6L17 8v12.5h-10.5z M12.5 3.5V8H17',
  caret: 'M7 10l5 5 5-5',
  diff: 'M8.5 4v13 M8.5 4l-3 3 M8.5 4l3 3 M15.5 20V7 M15.5 20l3-3 M15.5 20l-3-3',
};

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
 *  (never color alone). ChangedEntry kinds map onto the history badge set. */
function statusBadge(file: ChangedEntry): { cls: string; txt: string } {
  switch (file.kind) {
    case 'create': return { cls: 'add', txt: 'A' };
    case 'delete': return { cls: 'del', txt: 'D' };
    case 'rename': return { cls: 'ren', txt: 'R' };
    default: return { cls: 'mod', txt: 'M' };
  }
}

/** The changed-file list carries no binary flag (unlike the history read
 *  model), so binary is detected from the loaded patch text itself. */
function isBinaryPatch(diff: string): boolean {
  return /^Binary files .* differ$/m.test(diff) || /^GIT binary patch$/m.test(diff);
}

const IDLE_PATCH: ChangesDiffPatch = { status: 'idle', diff: null, truncated: false };

function ChangesFileDiffBlock({
  workingTreeId,
  file,
  patch,
  split,
  wrap,
  collapsed,
  onToggle,
}: {
  workingTreeId: string;
  file: ChangedEntry;
  patch: ChangesDiffPatch | undefined;
  split: boolean;
  wrap: boolean;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const anchorRef = useRef<HTMLDivElement>(null);
  const state = patch ?? IDLE_PATCH;

  /* Viewport trigger: load when the placeholder scrolls near the visible
   *  area. The store dedupes in-flight/loaded requests, so a re-fired
   *  observer or a re-expand is safe. */
  useEffect(() => {
    if (collapsed || state.status !== 'idle') return;
    const el = anchorRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      ensureChangesDiffPatch(workingTreeId, file.path);
      return;
    }
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) {
        io.disconnect();
        ensureChangesDiffPatch(workingTreeId, file.path);
      }
    }, { rootMargin: '240px' });
    io.observe(el);
    return () => io.disconnect();
  }, [collapsed, state.status, workingTreeId, file.path]);

  const badge = statusBadge(file);
  const binary = state.status === 'loaded' && state.diff !== null && isBinaryPatch(state.diff);
  const body: React.ReactNode = collapsed ? null : state.status === 'loading' || state.status === 'idle' ? (
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
        <button className="btn secondary sm"
                onClick={e => { e.stopPropagation(); retryChangesDiffPatch(workingTreeId, file.path); }}>
          {t('common.retry')}
        </button>
      </div>
    </div>
  ) : binary ? (
    <div className="cs-file-body">
      <div className="cs-file-note">
        <Icon d={I.file} size={12} stroke={1.6} />
        <span>{t('history.file.binary')}</span>
      </div>
    </div>
  ) : (
    <div className="cs-file-body">
      {state.truncated && (
        <div className="cs-file-note warn" role="status">
          <Icon d={I.warnTri} size={12} stroke={1.7} />
          <span>{t('history.file.truncated')}</span>
        </div>
      )}
      {state.diff !== null && <DiffBody diffText={state.diff} path={file.path} split={split} wrap={wrap} />}
    </div>
  );

  return (
    <div className={`cs-file${collapsed ? ' collapsed' : ''}`} data-path={file.path}>
      <div className="cs-file-head" role="button" tabIndex={0} aria-expanded={!collapsed}
           title={file.path}
           onClick={onToggle}
           onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}>
        <span className="caret"><Icon d={I.caret} size={11} stroke={2.2} /></span>
        <span className={`cs-badge ${badge.cls}`}>{badge.txt}</span>
        <span className="cs-file-path">{file.path}</span>
        <span className="stat">
          {file.added > 0 && <span className="add">+{file.added}</span>}
          {file.removed > 0 && <span className="del">−{file.removed}</span>}
        </span>
      </div>
      {body}
    </div>
  );
}

export function ChangesDiffBody({
  workingTreeId,
}: {
  workingTreeId: string | null;
}) {
  const t = useT();
  const state = useChangesDiffState(workingTreeId);
  const [wrap, setWrap] = useState(() => readBool(WRAP_KEY, true));
  const [split, setSplit] = useState(() => readBool(SPLIT_KEY, false));
  const rootRef = useRef<HTMLDivElement>(null);
  const [pendingAnchor, setPendingAnchor] = useState<ChangesDiffAnchor | null>(null);

  useEffect(() => {
    if (workingTreeId) ensureChangesDiffLoaded(workingTreeId);
  }, [workingTreeId]);

  // Anchor intake: take the store's one-shot request, then scroll — once now
  // (the block may still be a skeleton) and again when the target patch
  // settles (loaded/error), because the block's height changes then.
  const anchor = state.anchor;
  useEffect(() => {
    if (!anchor || !workingTreeId) return;
    consumeChangesDiffAnchor(workingTreeId, anchor.requestId);
    setPendingAnchor(anchor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor?.requestId, workingTreeId]);

  useEffect(() => {
    if (!pendingAnchor) return;
    const el = rootRef.current?.querySelector(`.cs-file[data-path="${CSS.escape(pendingAnchor.path)}"]`);
    if (!el) {
      setPendingAnchor(null);
      return;
    }
    el.scrollIntoView({ block: 'start' });
    const patch = state.patches[pendingAnchor.path];
    if (patch && (patch.status === 'loaded' || patch.status === 'error')) setPendingAnchor(null);
  }, [pendingAnchor, state.patches, state.files]);

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

  if (!workingTreeId) {
    return (
      <div className="cs-root">
        <div className="sheet-empty history-empty" data-testid="changes-diff-empty">
          <svg className="fpe-icon" viewBox="0 0 24 24" width="34" height="34" fill="none"
               stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            <path d={I.diff} />
          </svg>
          <span className="fpe-title">{t('changes.diff.noTree')}</span>
        </div>
      </div>
    );
  }

  const totals = state.files.reduce(
    (acc, f) => ({ add: acc.add + f.added, del: acc.del + f.removed }),
    { add: 0, del: 0 },
  );
  const allCollapsed = state.files.length > 0
    && state.files.every(f => state.collapsed[f.path] === true);

  return (
    <div className={`cs-root${wrap ? '' : ' cs-nowrap'}`} ref={rootRef}>
      {state.status !== 'ready' && state.status !== 'error' && state.files.length === 0 ? (
        <div className="sheet-empty">
          <span className="spinner" aria-hidden="true" /> {t('common.loading')}
        </div>
      ) : state.status === 'error' ? (
        <div className="sheet-empty">
          {state.error ?? t('changes.diff.loadFailed')}
          <button className="btn sm secondary" type="button"
                  onClick={() => refreshChangesDiff(workingTreeId)}>
            {t('sheet.retry')}
          </button>
        </div>
      ) : (
        <>
          <div className="cs-toolbar">
            <span className="cs-stats">
              <span className="files">{state.files.length} {t('changes.files')}</span>
              <span className="add">+{totals.add}</span>
              <span className="del">−{totals.del}</span>
            </span>
            <span className="cs-actions">
              <button className="sheet-tabs-act"
                      title={allCollapsed ? t('history.expandAll') : t('history.collapseAll')}
                      aria-label={allCollapsed ? t('history.expandAll') : t('history.collapseAll')}
                      onClick={() => setAllChangesDiffCollapsed(workingTreeId, !allCollapsed)}>
                <Icon d={allCollapsed ? I.unfold : I.fold} size={12} stroke={1.6} />
              </button>
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
            </span>
          </div>
          {state.files.length === 0 ? (
            <div className="sheet-empty">{t('changes.empty')}</div>
          ) : (
            <div className="cs-files">
              {state.files.map(f => (
                <ChangesFileDiffBlock
                  key={f.path}
                  workingTreeId={workingTreeId}
                  file={f}
                  patch={state.patches[f.path]}
                  split={split}
                  wrap={wrap}
                  collapsed={state.collapsed[f.path] ?? false}
                  onToggle={() => toggleChangesDiffCollapsed(workingTreeId, f.path)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
