import { useEffect, useRef, useState } from 'react';
import { loadFile } from '../api.js';
import type { DiffItem } from '../types.js';

export type PreviewTarget =
  | {
      kind: 'file';
      workingTreeId: string;
      /** Repo-relative path. */
      path: string;
      line?: number;
    }
  | {
      kind: 'diff';
      diff: DiffItem;
    };

/**
 * 4th-level Inspector island — sits as the rightmost column of `.view`
 * (alongside rail + main). Reuses the design's `.preview` shell + `.code-*`
 * grid for content rendering. Toggles visibility via the `open` class so
 * the layout slot is preserved (matches the mockup behavior).
 *
 * Two modes:
 *   - kind:'file' — fetches working-tree content and renders the full file
 *   - kind:'diff' — renders DiffItem hunks (add/del coloring, no fetch)
 */
export function FilePreviewDrawer({
  target,
  onClose,
}: {
  target: PreviewTarget | null;
  onClose: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // File-mode fetch.
  useEffect(() => {
    if (!target || target.kind !== 'file') {
      setContent(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent(null);
    void loadFile(target.workingTreeId, target.path).then(
      (file) => {
        if (cancelled) return;
        setLoading(false);
        if (!file) {
          setError('File not found in working tree.');
          return;
        }
        setContent(file.content);
      },
      (err: unknown) => {
        if (cancelled) return;
        setLoading(false);
        setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => { cancelled = true; };
  }, [target?.kind, (target?.kind === 'file' ? target.workingTreeId : ''), (target?.kind === 'file' ? target.path : '')]);

  // Scroll to requested line once content lands (file mode only).
  useEffect(() => {
    if (!target || target.kind !== 'file' || !target.line || !content || !bodyRef.current) return;
    const lineHeight = 19;
    const top = Math.max(0, (target.line - 1) * lineHeight - 80);
    bodyRef.current.scrollTop = top;
  }, [content, target]);

  // Close on Escape.
  useEffect(() => {
    if (!target) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [target, onClose]);

  // ─── Header ─────────────────────────────────────────────────────────────
  let header: React.ReactNode = null;
  if (target?.kind === 'file') {
    const lastSlash = target.path.lastIndexOf('/');
    const dirPrefix = lastSlash >= 0 ? target.path.slice(0, lastSlash + 1) : '';
    const filename = lastSlash >= 0 ? target.path.slice(lastSlash + 1) : target.path;
    header = (
      <div className="preview-path">
        {dirPrefix && <span>{dirPrefix}</span>}
        <span className="hi">{filename}</span>
      </div>
    );
  } else if (target?.kind === 'diff') {
    const totalAdd = target.diff.files.reduce((s, f) => s + f.add, 0);
    const totalDel = target.diff.files.reduce((s, f) => s + f.del, 0);
    const first = target.diff.files[0];
    const fileLabel = target.diff.files.length === 1 && first
      ? first.path
      : `${target.diff.files.length} files`;
    const lastSlash = typeof fileLabel === 'string' ? fileLabel.lastIndexOf('/') : -1;
    const dirPrefix = lastSlash >= 0 ? fileLabel.slice(0, lastSlash + 1) : '';
    const filename = lastSlash >= 0 ? fileLabel.slice(lastSlash + 1) : fileLabel;
    header = (
      <>
        <div className="preview-path">
          {dirPrefix && <span>{dirPrefix}</span>}
          <span className="hi">{filename}</span>
        </div>
        <div className="preview-hunks">
          <span className="add">+{totalAdd}</span>{' '}
          <span className="del">−{totalDel}</span>
        </div>
      </>
    );
  }

  // ─── Body ───────────────────────────────────────────────────────────────
  let body: React.ReactNode = null;
  if (target?.kind === 'file') {
    body = content !== null
      ? content.split('\n').map((line, i) => (
          <div key={i} className={`code-ln${target.line === i + 1 ? ' active' : ''}`}>
            <span className="code-num">{i + 1}</span>
            <span className="code-txt">{line || ' '}</span>
          </div>
        ))
      : null;
  } else if (target?.kind === 'diff') {
    const blocks: React.ReactNode[] = [];
    target.diff.files.forEach((f, fi) => {
      // File header (only when more than one file or as a hunk separator).
      if (target.diff.files.length > 1) {
        blocks.push(
          <div key={`f${fi}-head`} className="code-ln file-head">
            <span className="code-num" />
            <span className="code-txt">{f.path}</span>
          </div>,
        );
      }
      if (f.hunks.length === 0) {
        blocks.push(
          <div key={`f${fi}-empty`} className="code-ln">
            <span className="code-num" />
            <span className="code-txt" style={{ color: 'var(--text-3)', fontStyle: 'italic' }}>
              (no hunks — diff summary only)
            </span>
          </div>,
        );
        return;
      }
      f.hunks.forEach((h, hi) => {
        blocks.push(
          <div key={`f${fi}-h${hi}-head`} className="code-ln hunk-head">
            <span className="code-num" />
            <span className="code-txt">{h.header}</span>
          </div>,
        );
        h.lines.forEach((l, li) => {
          const cls = l.kind === 'add' ? 'add' : l.kind === 'del' ? 'del' : '';
          const sign = l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' ';
          blocks.push(
            <div key={`f${fi}-h${hi}-l${li}`} className={`code-ln ${cls}`}>
              <span className="code-num">{sign}</span>
              <span className="code-txt">{l.text}</span>
            </div>,
          );
        });
      });
    });
    body = blocks;
  }

  return (
    <aside className={`preview${target ? ' open' : ''}`} id="preview" aria-label="File preview">
      <div className="preview-head">
        <div style={{ minWidth: 0 }}>{header}</div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            type="button"
            className="btn ghost sm icon"
            onClick={onClose}
            aria-label="Close preview"
            title="Close (Esc)"
          >
            ×
          </button>
        </div>
      </div>
      <div className="preview-body" ref={bodyRef}>
        {loading && <div className="preview-status">Loading…</div>}
        {error && <div className="preview-status error">{error}</div>}
        {body}
      </div>
    </aside>
  );
}
