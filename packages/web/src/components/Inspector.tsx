import { useEffect, useState } from 'react';
import { loadTree, loadChanged } from '../api.js';
import type { TreeEntry, ChangedEntry } from '../api.js';

export type InspectorTab = 'files' | 'changes';

function Icon({ d, size = 13, stroke = 1.6 }: { d: string; size?: number; stroke?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
         strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
      {Array.isArray(d) ? d.map((p, i) => <path key={i} d={p} />) : <path d={d} />}
    </svg>
  );
}

const I = {
  refresh: 'M3 12a9 9 0 0 1 15.5-6.3L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-15.5 6.3L3 16 M3 21v-5h5',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
};

interface Props {
  tab: InspectorTab;
  workingTreeId: string | null;
  /** Files tab: open file source in Sheet. permanent=true for double-click. */
  onOpenFile: (path: string, permanent: boolean) => void;
  /** Changes tab: open the file's diff in Sheet. */
  onOpenDiff: (path: string, permanent: boolean) => void;
}

export function Inspector({ tab, workingTreeId, onOpenFile, onOpenDiff }: Props) {
  if (tab === 'files') return <FilesInspector workingTreeId={workingTreeId} onOpenFile={onOpenFile} />;
  return <ChangesInspector workingTreeId={workingTreeId} onOpenDiff={onOpenDiff} />;
}

// ─── Files Inspector ────────────────────────────────────────────────────────
function FilesInspector({ workingTreeId, onOpenFile }: { workingTreeId: string | null; onOpenFile: (p: string, perm: boolean) => void }) {
  const [reloadKey, setReloadKey] = useState(0);
  return (
    <aside className="inspector">
      <div className="insp-head">
        <span className="insp-eyebrow">Panel</span>
        <span className="label">Files</span>
        <button className="iconbtn" title="Refresh" onClick={() => setReloadKey(k => k + 1)}>
          <Icon d={I.refresh} />
        </button>
        <button className="iconbtn" title="Search" disabled>
          <Icon d={I.search} />
        </button>
      </div>
      <div className="insp-scroll">
        <div className="tree">
          {workingTreeId
            ? <TreeFolder
                key={reloadKey}
                workingTreeId={workingTreeId}
                relPath=""
                name={workingTreeId.replace(/^[wt|ws]+:/, '')}
                depth={0}
                openInitial
                onOpenFile={onOpenFile}
              />
            : <div style={{ padding: '12px', color: 'var(--text-3)', fontSize: 12, fontStyle: 'italic' }}>
                No active working tree.
              </div>}
        </div>
      </div>
    </aside>
  );
}

function TreeFolder({
  workingTreeId,
  relPath,
  name,
  depth,
  openInitial = false,
  onOpenFile,
}: {
  workingTreeId: string;
  relPath: string;
  name: string;
  depth: number;
  openInitial?: boolean;
  onOpenFile: (path: string, permanent: boolean) => void;
}) {
  const [open, setOpen] = useState(openInitial);
  const [entries, setEntries] = useState<TreeEntry[] | null>(null);

  useEffect(() => {
    if (!open || entries !== null) return;
    let cancelled = false;
    void loadTree(workingTreeId, relPath).then(list => {
      if (!cancelled) {
        const sorted = list.slice().sort((a, b) => {
          if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        setEntries(sorted);
      }
    });
    return () => { cancelled = true; };
  }, [open, entries, workingTreeId, relPath]);

  return (
    <>
      <div className={`tree-item folder ${open ? 'open' : ''}`}
           style={{ paddingLeft: 6 + depth * 12 }}
           onClick={() => setOpen(o => !o)}>
        <span className="tree-caret">▶</span>
        <Icon d={I.folder} size={13} />
        <span className="tree-name">{name}</span>
      </div>
      {open && entries && (
        <div className="tree-children">
          {entries.map(e => e.type === 'dir' ? (
            <TreeFolder
              key={e.path}
              workingTreeId={workingTreeId}
              relPath={e.path}
              name={e.name}
              depth={depth + 1}
              onOpenFile={onOpenFile}
            />
          ) : (
            <TreeFile
              key={e.path}
              name={e.name}
              path={e.path}
              depth={depth + 1}
              onOpenFile={onOpenFile}
            />
          ))}
        </div>
      )}
    </>
  );
}

function TreeFile({ name, path, depth, onOpenFile }: { name: string; path: string; depth: number; onOpenFile: (p: string, perm: boolean) => void }) {
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] || 'txt').toLowerCase();
  const colors: Record<string, string> = {
    md: 'oklch(0.55 0.04 250)',
    ts: 'oklch(0.55 0.13 260)',
    tsx: 'oklch(0.55 0.13 260)',
    json: 'oklch(0.55 0.11 80)',
    css: 'oklch(0.55 0.13 320)',
  };
  return (
    <div className="tree-item"
         style={{ paddingLeft: 6 + depth * 12 }}
         onClick={() => onOpenFile(path, false)}
         onDoubleClick={() => onOpenFile(path, true)}
         title={path}>
      <span className="tree-caret" />
      <span className="tree-ico" style={{
        width: 14, height: 14, borderRadius: 2,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: colors[ext] || 'oklch(0.55 0.01 280)',
        color: 'white', font: '700 7.5px/1 var(--font-mono)',
      }}>{ext.toUpperCase().slice(0, 2)}</span>
      <span className="tree-name">{name}</span>
    </div>
  );
}

// ─── Changes Inspector ──────────────────────────────────────────────────────
// Click a changed file → its diff opens in the Sheet workbench (V1 behavior).
function ChangesInspector({
  workingTreeId,
  onOpenDiff,
}: {
  workingTreeId: string | null;
  onOpenDiff: (path: string, permanent: boolean) => void;
}) {
  const [changes, setChanges] = useState<ChangedEntry[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!workingTreeId) {
      setChanges([]);
      return;
    }
    let cancelled = false;
    void loadChanged(workingTreeId).then(list => {
      if (!cancelled) setChanges(list);
    });
    return () => { cancelled = true; };
  }, [workingTreeId, reloadKey]);

  const total = changes.reduce((acc, c) => ({ add: acc.add + c.added, del: acc.del + c.removed }), { add: 0, del: 0 });

  function sigBadge(kind: ChangedEntry['kind']) {
    if (kind === 'create') return { cls: 'add', txt: 'A' };
    if (kind === 'delete') return { cls: 'del', txt: 'D' };
    return { cls: 'mod', txt: 'M' };
  }

  return (
    <aside className="inspector">
      <div className="insp-head">
        <span className="insp-eyebrow">Panel</span>
        <span className="label">Changes</span>
        <button className="iconbtn" title="Refresh" onClick={() => setReloadKey(k => k + 1)}>
          <Icon d={I.refresh} />
        </button>
      </div>
      <div className="insp-scroll">
        <div className="changes-summary">
          <span className="count">{changes.length} files</span>
          <span className="add">+{total.add}</span>
          <span className="del">−{total.del}</span>
        </div>
        {changes.map((c, i) => {
          const { cls, txt } = sigBadge(c.kind);
          const slash = c.path.lastIndexOf('/');
          const dir = slash >= 0 ? c.path.slice(0, slash + 1) : '';
          const name = slash >= 0 ? c.path.slice(slash + 1) : c.path;
          return (
            <button
              key={i}
              className="changes-row"
              type="button"
              title={c.path}
              onClick={() => onOpenDiff(c.path, false)}
              onDoubleClick={() => onOpenDiff(c.path, true)}
            >
              <span className={`files-badge ${cls}`}>{txt}</span>
              <span className="path"><span className="dir">{dir}</span>{name}</span>
              <span className="stat">
                {c.added > 0 && <span className="add">+{c.added}</span>}
                {c.removed > 0 && <span className="del">−{c.removed}</span>}
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
