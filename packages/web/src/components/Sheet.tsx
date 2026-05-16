import { Fragment, useEffect, useRef } from 'react';
import { parseUnifiedDiff } from '../transcript/apply.js';
import { Splitter } from './Splitter.js';

export type SheetTabKind = 'file' | 'term' | 'settings' | 'plan' | 'diff';
export type FileViewMode = 'source' | 'preview';

export interface SheetTab {
  id: string;
  pane: 0 | 1;
  name: string;
  kind: SheetTabKind;
  icoKind: 'md' | 'ts' | 'tsx' | 'json' | 'css' | 'term' | 'gear' | 'plan' | 'diff';
  ico: string;
  /** When true, this tab is a "preview" (italic name, replaced by next preview).
   *  Double-click or pin to promote to permanent. */
  preview?: boolean;
  /** Source code lines (for file tabs). Each row: [number, text, syntaxClass?, diffClass?]. */
  lines?: Array<[string, string, string?, string?]>;
  /** For md file tabs, toggles source vs rendered preview. */
  viewMode?: FileViewMode;
  /** Optional full path shown on hover (§3.14). */
  fullPath?: string;
  /** Plan markdown body (for kind === 'plan'). */
  planBody?: string;
  /** Raw unified diff text (for kind === 'diff'). */
  diffText?: string;
}

export interface SheetActions {
  activateTab: (pane: 0 | 1, id: string) => void;
  closeTab: (id: string) => void;
  pinTab: (id: string) => void;
  setTabViewMode: (id: string, mode: FileViewMode) => void;
}

/** File preview capability matrix.
 *  - canPreviewInApp: shows the eye/code toggle inside the sheet. Only
 *    Markdown today (we render it via MarkdownPreview). Other text-based
 *    formats (json/ts/css/...) only have the source view, so the toggle
 *    is redundant and hidden.
 *  - canOpenInBrowser: shows the "open in new tab" button. Only file types
 *    that the browser RENDERS visually (different from raw text). HTML/SVG
 *    qualify; plain code/text doesn't (a browser tab would just show the
 *    same source we already show in-app). Markdown is also excluded —
 *    the rendered view exists in-app; a browser tab would only show source. */
function fileCapabilities(tab: SheetTab): { canPreviewInApp: boolean; canOpenInBrowser: boolean; mime: string | null } {
  if (tab.kind !== 'file') return { canPreviewInApp: false, canOpenInBrowser: false, mime: null };
  const name = tab.fullPath ?? tab.name;
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
  switch (ext) {
    case 'md':
      return { canPreviewInApp: true, canOpenInBrowser: false, mime: 'text/markdown' };
    case 'html':
    case 'htm':
      return { canPreviewInApp: false, canOpenInBrowser: true, mime: 'text/html' };
    case 'svg':
      return { canPreviewInApp: false, canOpenInBrowser: true, mime: 'image/svg+xml' };
    default:
      return { canPreviewInApp: false, canOpenInBrowser: false, mime: null };
  }
}

function openTabInBrowser(tab: SheetTab, mime: string): void {
  const body = tab.lines?.map(r => r[1]).join('\n') ?? '';
  const blob = new Blob([body], { type: mime });
  const url = URL.createObjectURL(blob);
  // Revoke after a delay — Safari/Chrome both need the blob alive long enough
  // for the new tab to load it. 1 minute is plenty; the OS-level GC handles
  // the tab's own retention afterwards.
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

interface Props {
  tabs: SheetTab[];
  active: { 0: string | null; 1: string | null };
  actions: SheetActions;
  /** Render content for non-file tab kinds. Sheet renders file/plan bodies
   *  inline; term/settings are externally-provided so the host can decide
   *  data sources. */
  renderTab?: (tab: SheetTab) => React.ReactNode | null;
  /** Called when the user clicks the trailing "+" in the tab strip. App
   *  decides what to add (currently a new terminal — see toggleWbTabKind). */
  onAddTab?: (pane: 0 | 1) => void;
}

function Icon({ d, size = 16, stroke = 1.6 }: { d: string; size?: number; stroke?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
         strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

const I = {
  pin: 'M12 3l5 5-2 2-3 6-3-3-5 5 5-5-3-3 6-3 2-2z',
  x: 'M5 5l14 14 M5 19L19 5',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  code: 'M8 17l-5-5 5-5 M16 7l5 5-5 5 M14 4l-4 16',
  openNew: 'M14 4h6v6 M20 4l-9 9 M19 13v7H4V5h7',
  gear: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M19 12a7 7 0 0 0-.2-1.6l2-1.6-2-3.4-2.4.9a7 7 0 0 0-2.8-1.6L13.2 2H10.8l-.4 2.7a7 7 0 0 0-2.8 1.6L5.2 5.4l-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .6.1 1.1.2 1.6l-2 1.6 2 3.4 2.4-.9a7 7 0 0 0 2.8 1.6l.4 2.7h2.4l.4-2.7a7 7 0 0 0 2.8-1.6l2.4.9 2-3.4-2-1.6c.1-.5.2-1 .2-1.6z',
  check: 'M5 12l5 5L20 7',
  plus: 'M12 5v14 M5 12h14',
  diff: 'M9 4v12 M9 4l-3 3 M9 4l3 3 M15 20V8 M15 20l3-3 M15 20l-3-3',
};

function ExtIco({ kind, ico }: { kind: SheetTab['icoKind']; ico: string }) {
  if (kind === 'gear') return <span className={`ext-ico ${kind}`}><Icon d={I.gear} size={9} stroke={2} /></span>;
  if (kind === 'plan') return <span className={`ext-ico ${kind}`}><Icon d={I.check} size={9} stroke={2.4} /></span>;
  if (kind === 'diff') return <span className={`ext-ico ${kind}`}><Icon d={I.diff} size={10} stroke={1.8} /></span>;
  return <span className={`ext-ico ${kind}`}>{ico || kind.toUpperCase().slice(0, 2)}</span>;
}

function FileBody({ lines }: { lines: Array<[string, string, string?, string?]> }) {
  return (
    <div className="sheet-file">
      {lines.map(([n, t, cls, diff], i) => (
        <div className={`ln ${diff || ''}`} key={i}>
          <span className="num">{n}</span>
          <span className={`txt ${cls || ''}`}>{t}</span>
        </div>
      ))}
    </div>
  );
}

/** Minimal markdown renderer for tab preview mode — headings/paragraphs/lists/code fences. */
function MarkdownPreview({ source }: { source: string }) {
  type Block =
    | { type: 'h'; lvl: number; text: string }
    | { type: 'p'; text: string }
    | { type: 'ul'; items: string[] }
    | { type: 'code'; lang: string; code: string };
  const rows = source.split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < rows.length) {
    const ln = rows[i] ?? '';
    if (/^```/.test(ln)) {
      const lang = ln.slice(3).trim();
      const code: string[] = [];
      i++;
      while (i < rows.length && !/^```/.test(rows[i] ?? '')) { code.push(rows[i] ?? ''); i++; }
      i++;
      blocks.push({ type: 'code', lang, code: code.join('\n') });
      continue;
    }
    const h = ln.match(/^(#{1,4})\s+(.*)$/);
    if (h) { blocks.push({ type: 'h', lvl: h[1]!.length, text: h[2]! }); i++; continue; }
    if (/^[-*]\s+/.test(ln)) {
      const items: string[] = [];
      while (i < rows.length && /^[-*]\s+/.test(rows[i] ?? '')) {
        items.push((rows[i] ?? '').replace(/^[-*]\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }
    if (ln.trim() === '') { i++; continue; }
    const paras = [ln];
    i++;
    while (i < rows.length && (rows[i] ?? '').trim() !== '' && !/^(#{1,4}\s|[-*]\s|```)/.test(rows[i] ?? '')) {
      paras.push(rows[i] ?? ''); i++;
    }
    blocks.push({ type: 'p', text: paras.join(' ') });
  }
  function inline(t: string, kp: number): React.ReactNode[] {
    const parts: React.ReactNode[] = [];
    let rest = t;
    let key = kp;
    while (rest.length) {
      const m = rest.match(/`([^`]+)`|\*\*([^*]+)\*\*/);
      if (!m) { parts.push(rest); break; }
      if (m.index! > 0) parts.push(rest.slice(0, m.index));
      if (m[1] !== undefined) parts.push(<code key={`c${key++}`}>{m[1]}</code>);
      else parts.push(<strong key={`s${key++}`}>{m[2]}</strong>);
      rest = rest.slice(m.index! + m[0].length);
    }
    return parts;
  }
  return (
    <div className="md-preview">
      {blocks.map((b, k) => {
        if (b.type === 'h') {
          const lvl = Math.min(b.lvl, 4) as 1 | 2 | 3 | 4;
          const Tag = (`h${lvl}` as 'h1' | 'h2' | 'h3' | 'h4');
          return <Tag key={k}>{inline(b.text, k * 100)}</Tag>;
        }
        if (b.type === 'p') return <p key={k}>{inline(b.text, k * 100)}</p>;
        if (b.type === 'ul') return (
          <ul key={k}>
            {b.items.map((it, j) => <li key={j}>{inline(it, k * 100 + j)}</li>)}
          </ul>
        );
        return <pre key={k} className="md-code"><code>{b.code}</code></pre>;
      })}
    </div>
  );
}

function PlanBody({ source }: { source: string }) {
  return <MarkdownPreview source={source} />;
}

/** Render a unified diff as hunks with +/- coloring. Uses the shared
 *  `parseUnifiedDiff` so the format matches DiffCard / Changes events. */
function DiffBody({ diffText, path }: { diffText: string; path?: string }) {
  const files = parseUnifiedDiff(diffText);
  if (files.length === 0 || files.every(f => f.hunks.length === 0)) {
    return (
      <div className="sheet-diff-empty">
        {path ? `No uncommitted changes for ${path}.` : 'No changes.'}
      </div>
    );
  }
  return (
    <div className="sheet-diff">
      {files.map((f, fi) => (
        <div key={fi} className="sheet-diff-file">
          {files.length > 1 && (
            <div className="sheet-diff-file-head">
              <span className="path">{f.path}</span>
              <span className="stat">
                {f.add > 0 && <span className="add">+{f.add}</span>}
                {f.del > 0 && <span className="del">−{f.del}</span>}
              </span>
            </div>
          )}
          {f.hunks.map((h, hi) => (
            <div key={hi} className="sheet-diff-hunk">
              <div className="sheet-diff-hunk-head">{h.header}</div>
              {h.lines.map((ln, li) => (
                <div key={li} className={`sheet-diff-ln ${ln.kind}`}>
                  <span className="sig">{ln.kind === 'add' ? '+' : ln.kind === 'del' ? '−' : ' '}</span>
                  <span className="txt">{ln.text}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function Sheet({ tabs, active, actions, renderTab, onAddTab }: Props) {
  const byPane: Record<0 | 1, SheetTab[]> = { 0: [], 1: [] };
  tabs.forEach(t => byPane[t.pane].push(t));
  const panes: Array<{ idx: 0 | 1; tabs: SheetTab[] }> = [];
  if (byPane[0].length) panes.push({ idx: 0, tabs: byPane[0] });
  if (byPane[1].length) panes.push({ idx: 1, tabs: byPane[1] });
  if (panes.length === 0) return null;

  return (
    <section className="sheet" data-testid="workbench-sheet">
      {panes.map((p, i) => {
        const activeId = active[p.idx] || p.tabs[0]?.id || null;
        const tab = p.tabs.find(t => t.id === activeId) || p.tabs[0]!;
        const caps = fileCapabilities(tab);
        const showActions = caps.canPreviewInApp || caps.canOpenInBrowser;
        return (
          <Fragment key={p.idx}>
            {i > 0 && <Splitter axis="y" varName="--sheet-top-h" base={320} min={120} max={700} />}
            <div className="sheet-pane" style={i === 0 && panes.length === 2 ? { flex: 'none', height: 'var(--sheet-top-h, 320px)' } : undefined}>
              <div className="sheet-tabs">
                {p.tabs.map(t => (
                  <button
                    key={t.id}
                    className={`sheet-tab ${t.id === activeId ? 'active' : ''} ${t.preview ? 'preview' : ''}`}
                    data-testid={`sheet-tab-${t.kind}`}
                    title={t.fullPath || (t.preview ? `${t.name} · single-click preview — double-click or pin to keep` : t.name)}
                    onClick={() => actions.activateTab(p.idx, t.id)}
                    onDoubleClick={() => actions.pinTab(t.id)}
                  >
                    <ExtIco kind={t.icoKind} ico={t.ico} />
                    <span className="name">{t.name}</span>
                    {t.preview && (
                      <span className="tab-pin-inline" title="Keep this tab open" onClick={e => { e.stopPropagation(); actions.pinTab(t.id); }}>
                        <Icon d={I.pin} size={10} stroke={1.8} />
                      </span>
                    )}
                    <span className="tab-x" onClick={e => { e.stopPropagation(); actions.closeTab(t.id); }}>
                      <Icon d={I.x} size={10} stroke={2.2} />
                    </span>
                  </button>
                ))}
                {onAddTab && p.tabs.some(t => t.kind === 'term') && (
                  <button
                    className="tab-add"
                    type="button"
                    title="New terminal"
                    onClick={() => onAddTab(p.idx)}
                  >
                    <Icon d={I.plus} size={12} stroke={1.8} />
                  </button>
                )}
                <span className="sheet-tabs-spacer" />
              </div>
              <div className="sheet-content">
                {showActions && (
                  <span className="sheet-content-actions">
                    {caps.canPreviewInApp && (
                      <div className="sheet-mode-toggle" role="tablist">
                        <button className={tab.viewMode === 'preview' ? 'active' : ''}
                                title="Rendered preview"
                                onClick={() => actions.setTabViewMode(tab.id, 'preview')}>
                          <Icon d={I.eye} size={11} stroke={1.8} />
                        </button>
                        <button className={(tab.viewMode || 'source') === 'source' ? 'active' : ''}
                                title="Source"
                                onClick={() => actions.setTabViewMode(tab.id, 'source')}>
                          <Icon d={I.code} size={11} stroke={1.8} />
                        </button>
                      </div>
                    )}
                    {caps.canOpenInBrowser && caps.mime && (
                      <button className="sheet-tabs-act" title="Open in browser tab"
                              onClick={() => openTabInBrowser(tab, caps.mime!)}>
                        <Icon d={I.openNew} size={12} stroke={1.8} />
                      </button>
                    )}
                  </span>
                )}
                {tab.kind === 'file' && tab.icoKind === 'md' && tab.viewMode === 'preview' && tab.lines
                  ? <MarkdownPreview source={tab.lines.map(r => r[1]).join('\n')} />
                  : tab.kind === 'file' && tab.lines
                    ? <FileBody lines={tab.lines} />
                    : tab.kind === 'plan' && tab.planBody
                      ? <PlanBody source={tab.planBody} />
                      : tab.kind === 'diff' && tab.diffText !== undefined
                        ? <DiffBody diffText={tab.diffText} path={tab.fullPath ?? tab.name} />
                        : renderTab
                          ? renderTab(tab)
                          : null}
              </div>
            </div>
          </Fragment>
        );
      })}
    </section>
  );
}
