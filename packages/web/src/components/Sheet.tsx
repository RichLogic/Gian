import { useContext, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { OpenAppPrefs } from '@gian/shared';
import { useT } from '../i18n/index.js';
import { parseUnifiedDiff } from '../transcript/apply.js';
import { BrowserLinkOpenContext } from '../presentation/chat-panel.js';
import { AppIcon } from './AppIcon.js';
import {
  SHEET_GROUP_ORDER,
  openCategoryFor,
  resolveOpenTarget,
  type SheetActions,
  type SheetGroup,
  type SheetOpenWith,
  type SheetTab,
} from './sheet-model.js';
export {
  DEFAULT_OPEN_TARGET,
  IMAGE_EXTS,
  openCategoryFor,
  resolveOpenTarget,
} from './sheet-model.js';
export type {
  FileViewMode,
  RailId,
  SheetActions,
  SheetGroup,
  SheetOpenWith,
  SheetTab,
  SheetTabKind,
} from './sheet-model.js';

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

interface Props {
  tabs: SheetTab[];
  /** Active tab id per group — each rail remembers its own selection. */
  activeByGroup: Partial<Record<SheetGroup, string | null>>;
  /** Group shown for the current rail; null hides every group (they stay
   *  mounted so terminals keep running). */
  activeGroup: SheetGroup | null;
  actions: SheetActions;
  /** Render content for non-file tab kinds. Sheet renders file/plan bodies
   *  inline; term/settings are externally-provided so the host can decide
   *  data sources. */
  renderTab?: (tab: SheetTab) => React.ReactNode | null;
  /** Called when the user clicks the trailing "+" in the terminal tab strip. */
  onAddTab?: (group: SheetGroup) => void;
  /** Content for the active group when it has no tabs yet. Rendered inside
   *  the normal `.sheet-group` so the panel keeps
   *  its width (`--sheet-w`) and stays resizable in the empty state too. */
  renderEmpty?: (group: SheetGroup) => React.ReactNode;
  /** Whole-sheet display:none — element stays in the DOM so child
   *  terminals stay mounted across visibility flips. */
  hidden?: boolean;
  /** Configured external editors / apps surfaced in a file tab's "Open with…"
   *  menu (managed in Settings). The fixed system openers are always shown. */
  externalEditors?: Array<{ id: string; name: string }>;
  /** Per-category Open target prefs (Settings → Default apps). Drives what the
   *  main Open button does + which icon it shows. */
  openApps?: OpenAppPrefs;
  /** Open the given file tab with the chosen target. Undefined hides the
   *  "Open with…" control (e.g. when there's no working-tree context). */
  onOpenWith?: (tab: SheetTab, target: SheetOpenWith) => void;
  /** Jump to the editor-config settings (footer of the "Open with…" menu). */
  onConfigureEditors?: () => void;
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
  kebab: 'M12 5.01v-.02 M12 12.01v-.02 M12 19.01v-.02',
  gear: 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z M18.7 12a6 6 0 0 0-.1-1.2l1.8-1.4-1.8-3.1-2.1.8a6.2 6.2 0 0 0-2.1-1.2L14 3.5h-4l-.4 2.4a6.2 6.2 0 0 0-2.1 1.2l-2.1-.8-1.8 3.1 1.8 1.4a6 6 0 0 0 0 2.4l-1.8 1.4 1.8 3.1 2.1-.8a6.2 6.2 0 0 0 2.1 1.2l.4 2.4h4l.4-2.4a6.2 6.2 0 0 0 2.1-1.2l2.1.8 1.8-3.1-1.8-1.4c.07-.4.1-.8.1-1.2z',
  check: 'M5 12l5 5L20 7',
  plus: 'M12 5v14 M5 12h14',
  diff: 'M8.5 4v13 M8.5 4l-3 3 M8.5 4l3 3 M15.5 20V7 M15.5 20l3-3 M15.5 20l-3-3',
  commit: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M3 12h6 M15 12h6',
  image: 'M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z M8.5 10.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z M20 15.5l-4.5-4.5L5 20',
  terminal: 'M5.5 7.5l4.5 4.5-4.5 4.5 M12.5 18.5h6',
  browser: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z M3.5 12h17 M12 3.5c2.2 2.3 3.3 5.1 3.3 8.5S14.2 18.2 12 20.5 M12 3.5C9.8 5.8 8.7 8.6 8.7 12s1.1 6.2 3.3 8.5',
  grid: 'M4 5.5A1.5 1.5 0 0 1 5.5 4h4A1.5 1.5 0 0 1 11 5.5v4A1.5 1.5 0 0 1 9.5 11h-4A1.5 1.5 0 0 1 4 9.5z M13 5.5A1.5 1.5 0 0 1 14.5 4h4A1.5 1.5 0 0 1 20 5.5v4a1.5 1.5 0 0 1-1.5 1.5h-4A1.5 1.5 0 0 1 13 9.5z M4 14.5A1.5 1.5 0 0 1 5.5 13h4a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-4A1.5 1.5 0 0 1 4 18.5z M13 14.5a1.5 1.5 0 0 1 1.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-4a1.5 1.5 0 0 1-1.5-1.5z',
  // Generic document (file tabs) — color comes from the per-ext CSS class.
  file: 'M6.5 3.5h6L17 8v12.5h-10.5z M12.5 3.5V8H17',
};

/** Tab-leading icon: a minimal SVG mark per tab/file type (phase 6 — the old
 *  colored chips with text glyphs "M"/"TS"/"{}"/"±" are gone). Colors come
 *  from the `.ext-ico.<kind>` CSS classes; the glyph itself inherits
 *  currentColor. */
function ExtIco({ kind }: { kind: SheetTab['icoKind'] }) {
  const d =
    kind === 'gear' ? I.gear
    : kind === 'plan' ? I.check
    : kind === 'img' ? I.image
    : kind === 'diff' ? I.diff
    : kind === 'commit' ? I.commit
    : kind === 'term' ? I.terminal
    : kind === 'browser' ? I.browser
    : kind === 'grid' ? I.grid
    : I.file;
  return <span className={`ext-ico ${kind}`}><Icon d={d} size={11} stroke={1.6} /></span>;
}

/** Tab label with MIDDLE truncation: the head shrinks with an ellipsis while a
 *  fixed tail (last few chars, usually the extension) stays visible — so a long
 *  `apr-001-approval-card.test.tsx` reads as `apr-001-app…test.tsx` instead of
 *  pushing the tab wide. CSS (`.sheet-tab .name`) caps the width. */
function TabName({ name }: { name: string }) {
  const tailLen = Math.min(8, name.length);
  const head = name.slice(0, name.length - tailLen);
  const tail = name.slice(name.length - tailLen);
  return (
    <span className="name">
      {head && <span className="name-head">{head}</span>}
      <span className="name-tail">{tail}</span>
    </span>
  );
}

/** Image tab body — renders the file directly from the host `/raw` endpoint
 *  (correct Content-Type + security headers) instead of loading it as text. */
function ImageBody({ src, name }: { src: string; name: string }) {
  return (
    <div className="sheet-image">
      <img src={src} alt={name} />
    </div>
  );
}

function FileBody({ lines, scrollLine }: { lines: Array<[string, string, string?, string?]>; scrollLine?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!scrollLine || !ref.current) return;
    const el = ref.current.querySelector<HTMLElement>(`[data-ln="${scrollLine}"]`);
    if (el) el.scrollIntoView({ block: 'center' });
  }, [scrollLine]);
  return (
    <div className="sheet-file" ref={ref}>
      {lines.map(([n, t, cls, diff], i) => (
        <div className={`ln ${diff || ''}${scrollLine && Number(n) === scrollLine ? ' ln-jump' : ''}`} key={i} data-ln={n}>
          <span className="num">{n}</span>
          <span className={`txt ${cls || ''}`}>{t}</span>
        </div>
      ))}
    </div>
  );
}

/** Markdown renderer for file preview & plan bodies. Uses react-markdown +
 *  remark-gfm so GFM tables, ordered lists, task lists, links and blockquotes
 *  render properly — the previous hand-rolled parser knew only headings /
 *  paragraphs / bullet lists / code fences and flattened everything else
 *  (notably tables) into a run-on paragraph. Raw HTML stays disabled
 *  (react-markdown's default: no rehype-raw) so previewed file contents can't
 *  inject markup. Styling hangs off the shared `.md-preview` class. */
function MarkdownPreview({ source }: { source: string }) {
  const openBrowser = useContext(BrowserLinkOpenContext);
  return (
    <div className="md-preview">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            const routesToBrowser = !!href && /^https?:\/\//i.test(href);
            return (
              <a
                href={href}
                target={routesToBrowser && openBrowser ? undefined : '_blank'}
                rel="noreferrer noopener"
                onClick={event => {
                  if (!routesToBrowser || !openBrowser || !href) return;
                  event.preventDefault();
                  openBrowser(href);
                }}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

function PlanBody({ source }: { source: string }) {
  return <MarkdownPreview source={source} />;
}

/** Level-3 transcript detail body (P3): full command output / reasoning
 *  trace / long result list — mono, pre-wrap, scrollable. */
function TextBody({ text }: { text: string }) {
  return <div className="sheet-text">{text}</div>;
}

/** One row of a side-by-side hunk: each side is null when that side has no
 *  cell on this row (e.g. a pure add has no left cell). `n` is the 1-based
 *  line number in that file; `text` is the line body. */
type SplitCell = { n: number; text: string } | null;
/** `ctx` marks an unchanged context row (same text both sides) so the
 *  renderer can pick neutral styling instead of add/del coloring. */
type SplitRow = { left: SplitCell; right: SplitCell; ctx: boolean };

/** Turn a hunk's unified `lines` into aligned side-by-side rows.
 *  - ctx  → both sides, same text, both numbers advance.
 *  - del  → left only, old# advances.
 *  - add  → right only, new# advances.
 *  Consecutive del/add runs are paired row-by-row (del[i] with add[i]); any
 *  surplus del or add lines fall onto their own rows with the other side blank.
 *  Line numbers are seeded from the hunk header (`@@ -old +new @@`). */
function splitHunkRows(header: string, lines: Array<{ kind: 'add' | 'del' | 'ctx'; text: string }>): SplitRow[] {
  const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
  let oldN = m ? Number(m[1]) : 1;
  let newN = m ? Number(m[2]) : 1;
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i]!;
    if (ln.kind === 'ctx') {
      rows.push({ left: { n: oldN++, text: ln.text }, right: { n: newN++, text: ln.text }, ctx: true });
      i++;
      continue;
    }
    // Gather a contiguous run of del then add and pair them up by index.
    const dels: Array<{ n: number; text: string }> = [];
    const adds: Array<{ n: number; text: string }> = [];
    while (i < lines.length && lines[i]!.kind === 'del') dels.push({ n: oldN++, text: lines[i++]!.text });
    while (i < lines.length && lines[i]!.kind === 'add') adds.push({ n: newN++, text: lines[i++]!.text });
    const pairs = Math.max(dels.length, adds.length);
    for (let p = 0; p < pairs; p++) {
      rows.push({ left: dels[p] ?? null, right: adds[p] ?? null, ctx: false });
    }
  }
  return rows;
}

/** Render a unified diff as hunks with +/- coloring. Uses the shared
 *  `parseUnifiedDiff` so the format matches DiffCard / Changes events.
 *  `split` swaps the single-column unified view for a side-by-side
 *  (old | new) view; `wrap` mirrors the sheet's word-wrap preference.
 *  Each file block carries `data-path` (kept from the anchor-jump
 *  experiment — harmless, useful for future cross-linking).
 *  Exported for the History commit change-set body (Issue #3) — History,
 *  Changes and ref-compare all share this one renderer. */
export function DiffBody({ diffText, path, split, wrap }: { diffText: string; path?: string; split?: boolean; wrap?: boolean }) {
  const t = useT();
  const files = parseUnifiedDiff(diffText);
  if (files.length === 0 || files.every(f => f.hunks.length === 0)) {
    return (
      <div className="sheet-diff-empty">
        {path ? `${t('sheet.noUncommittedChanges')} ${path}.` : t('sheet.noChanges')}
      </div>
    );
  }
  const rootClass = `sheet-diff${split ? ' split' : ''}${wrap ? '' : ' nowrap'}`;
  return (
    <div className={rootClass}>
      {files.map((f, fi) => (
        <div key={fi} className="sheet-diff-file" data-path={f.path}>
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
              {split
                ? splitHunkRows(h.header, h.lines).map((row, ri) => (
                    <div key={ri} className="sheet-diff-row">
                      <div className={`sheet-diff-side old${row.left ? (row.ctx ? ' ctx' : ' del') : ' empty'}`}>
                        <span className="num">{row.left ? row.left.n : ''}</span>
                        <span className="txt">{row.left ? row.left.text : ''}</span>
                      </div>
                      <div className={`sheet-diff-side new${row.right ? (row.ctx ? ' ctx' : ' add') : ' empty'}`}>
                        <span className="num">{row.right ? row.right.n : ''}</span>
                        <span className="txt">{row.right ? row.right.text : ''}</span>
                      </div>
                    </div>
                  ))
                : h.lines.map((ln, li) => (
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

/** Floating top-right action bar for a file tab: md preview/source toggle,
 *  open-in-browser, an "Open with…" dropdown (system default / configured
 *  editors / installed apps), and a "more" menu (copy path, copy contents,
 *  word-wrap toggle). Owns its own popover open/close state. */
// System openers listed in the "Open with…" menu. `default` + `browser` are NOT
// here — they're the two outcomes of the smart Open button (see smartOpen).
const SYSTEM_OPENERS: Array<{ name: 'finder' | 'terminal'; key: string; app: string }> = [
  { name: 'finder', key: 'sheet.openWith.finder', app: 'Finder' },
  { name: 'terminal', key: 'sheet.openWith.terminal', app: 'Terminal' },
];

function FileActions({
  tab, caps, actions, tr, wrap, onToggleWrap, split, onToggleSplit, externalEditors, openApps, onOpenWith, onConfigureEditors,
}: {
  tab: SheetTab;
  caps: { canPreviewInApp: boolean; canOpenInBrowser: boolean; mime: string | null };
  actions: SheetActions;
  tr: ReturnType<typeof useT>;
  wrap: boolean;
  onToggleWrap: () => void;
  split: boolean;
  onToggleSplit: () => void;
  externalEditors?: Array<{ id: string; name: string }>;
  openApps?: OpenAppPrefs;
  onOpenWith?: (tab: SheetTab, target: SheetOpenWith) => void;
  onConfigureEditors?: () => void;
}) {
  const [menu, setMenu] = useState<null | 'open' | 'more'>(null);
  const [copied, setCopied] = useState<null | 'path' | 'contents'>(null);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!menu) return;
    function onDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenu(null);
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setMenu(null); }
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const hasPath = !!tab.fullPath;
  const editors = externalEditors ?? [];

  function copy(text: string, which: 'path' | 'contents') {
    try { void navigator.clipboard?.writeText(text); } catch { /* clipboard blocked */ }
    setCopied(which);
    setMenu(null);
    setTimeout(() => setCopied(c => (c === which ? null : c)), 1200);
  }

  // Open by category, using the user's per-category target (Settings) or the
  // built-in default. The button shows that target's icon.
  const openTarget = resolveOpenTarget(openCategoryFor(tab.fullPath ?? tab.name), openApps);
  function smartOpen() {
    if (!onOpenWith) return;
    setMenu(null);
    onOpenWith(tab, openTarget);
  }

  return (
    <span className="sheet-content-actions" ref={ref}>
      {/* Open split — to the LEFT of the ⋮ menu. */}
      {onOpenWith && (
        <span className="sheet-act-wrap sheet-open-split">
          {/* Smart main click: renderable → new browser tab, else default app.
              The caret opens the configured-apps menu. */}
          <button
            className="sheet-tabs-act sheet-open-main"
            title={
              openTarget.kind === 'app' ? tr('sheet.openIn').replace('{app}', openTarget.app)
              : openTarget.kind === 'system' && openTarget.name === 'finder' ? tr('sheet.openWith.finder')
              : tr('sheet.openInNewTab')
            }
            onClick={smartOpen}
          >
            {openTarget.kind === 'app'
              ? <AppIcon name={openTarget.app} size={14} />
              : openTarget.kind === 'system' && openTarget.name === 'finder'
                ? <AppIcon name="Finder" size={14} />
                : <Icon d={I.openNew} size={12} stroke={1.8} />}
            <span className="sheet-open-label">{tr('sheet.open')}</span>
          </button>
          <button
            className={`sheet-tabs-act sheet-open-caret${menu === 'open' ? ' active' : ''}`}
            title={tr('sheet.openWith')}
            aria-label={tr('sheet.openWith')}
            aria-haspopup="menu"
            aria-expanded={menu === 'open'}
            onClick={() => setMenu(m => (m === 'open' ? null : 'open'))}
          >
            <span className="sheet-act-caret">▾</span>
          </button>
          {menu === 'open' && (
            <div className="sheet-act-menu" role="menu">
              {SYSTEM_OPENERS.map(o => (
                <button key={o.name} className="sheet-act-item app-item" role="menuitem"
                        onClick={() => { setMenu(null); onOpenWith(tab, { kind: 'system', name: o.name }); }}>
                  <AppIcon name={o.app} />
                  <span>{tr(o.key)}</span>
                </button>
              ))}
              {editors.length > 0 && <div className="sheet-act-sep" />}
              {editors.map(ed => (
                <button key={ed.id} className="sheet-act-item app-item" role="menuitem"
                        onClick={() => { setMenu(null); onOpenWith(tab, { kind: 'editor', id: ed.id }); }}>
                  <AppIcon name={ed.name} />
                  <span>{ed.name || ed.id}</span>
                </button>
              ))}
              {onConfigureEditors && (
                <>
                  <div className="sheet-act-sep" />
                  <button className="sheet-act-item dim" role="menuitem"
                          onClick={() => { setMenu(null); onConfigureEditors(); }}>
                    {tr('sheet.openWith.configure')}
                  </button>
                </>
              )}
            </div>
          )}
        </span>
      )}
      {/* "More" (⋮) — rightmost. */}
      <span className="sheet-act-wrap">
        <button
          className={`sheet-tabs-act${menu === 'more' ? ' active' : ''}`}
          title={tr('sheet.more')}
          aria-label={tr('sheet.more')}
          aria-haspopup="menu"
          aria-expanded={menu === 'more'}
          onClick={() => setMenu(m => (m === 'more' ? null : 'more'))}
        >
          <Icon d={I.kebab} size={14} stroke={2.4} />
        </button>
        {menu === 'more' && (
          <div className="sheet-act-menu" role="menu">
            {/* md (and other previewable) tabs default to the rendered view;
                source is a de-emphasised toggle here rather than a button. */}
            {caps.canPreviewInApp && (
              <>
                <button className="sheet-act-item" role="menuitem"
                        onClick={() => { actions.setTabViewMode(tab.id, tab.viewMode === 'preview' ? 'source' : 'preview'); setMenu(null); }}>
                  {tab.viewMode === 'preview' ? tr('sheet.viewSource') : tr('sheet.viewRendered')}
                </button>
                <div className="sheet-act-sep" />
              </>
            )}
            {hasPath && (
              <button className="sheet-act-item" role="menuitem"
                      onClick={() => copy(tab.fullPath!, 'path')}>
                {copied === 'path' ? tr('common.copied') : tr('sheet.copyPath')}
              </button>
            )}
            {tab.lines && (
              <button className="sheet-act-item" role="menuitem"
                      onClick={() => copy(tab.lines!.map(r => r[1]).join('\n'), 'contents')}>
                {copied === 'contents' ? tr('common.copied') : tr('sheet.copyContents')}
              </button>
            )}
            <div className="sheet-act-sep" />
            <button className="sheet-act-item" role="menuitem"
                    onClick={() => { onToggleWrap(); setMenu(null); }}>
              {wrap ? tr('sheet.wordwrap.disable') : tr('sheet.wordwrap.enable')}
            </button>
            {tab.kind === 'diff' && (
              <button className="sheet-act-item" role="menuitem"
                      onClick={() => { onToggleSplit(); setMenu(null); }}>
                {split ? tr('sheet.diffview.toUnified') : tr('sheet.diffview.toSplit')}
              </button>
            )}
          </div>
        )}
      </span>
    </span>
  );
}

export function Sheet({ tabs, activeByGroup, activeGroup, actions, renderTab, onAddTab, renderEmpty, hidden, externalEditors, openApps, onOpenWith, onConfigureEditors }: Props) {
  const tr = useT();
  // Word-wrap preference for file/diff bodies. Wrap is the historical default
  // (`.txt { white-space: pre-wrap }`); toggling off switches to `pre` +
  // horizontal scroll. Persisted so it sticks across tabs and reloads.
  const [wrap, setWrap] = useState<boolean>(() => {
    try { return localStorage.getItem('gian.sheet.wordwrap') !== 'off'; } catch { return true; }
  });
  const toggleWrap = () => setWrap(w => {
    const next = !w;
    try { localStorage.setItem('gian.sheet.wordwrap', next ? 'on' : 'off'); } catch { /* storage disabled */ }
    return next;
  });
  // Split (side-by-side) vs unified diff view. Unified is the default; persisted
  // alongside word-wrap so it sticks across tabs and reloads. Only affects diff
  // tabs — the toggle is conditioned on the active tab being a diff.
  const [split, setSplit] = useState<boolean>(() => {
    try { return localStorage.getItem('gian.sheet.diffsplit') === 'on'; } catch { return false; }
  });
  const toggleSplit = () => setSplit(s => {
    const next = !s;
    try { localStorage.setItem('gian.sheet.diffsplit', next ? 'on' : 'off'); } catch { /* storage disabled */ }
    return next;
  });
  const byGroup = new Map<SheetGroup, SheetTab[]>();
  tabs.forEach(t => {
    const list = byGroup.get(t.group) ?? [];
    list.push(t);
    byGroup.set(t.group, list);
  });
  // One section per group. Only the active rail's group is visible; the rest
  // stay mounted under display:none so xterm sessions (and later iframes)
  // keep running across rail switches. An active group with no tabs renders
  // its `renderEmpty` content in the same slot (keeps the panel resizable).
  const emptyActive = !!renderEmpty && !!activeGroup && !byGroup.has(activeGroup);
  if (byGroup.size === 0 && !emptyActive) return null;

  return (
    <section className="sheet" data-testid="workbench-sheet" style={hidden ? { display: 'none' } : undefined}>
      {emptyActive && (
        <div className="sheet-group" key="__empty">
          {renderEmpty!(activeGroup!)}
        </div>
      )}
      {SHEET_GROUP_ORDER.filter(g => byGroup.has(g)).map(g => {
        const gTabs = byGroup.get(g)!;
        const activeId = activeByGroup[g] || gTabs[0]?.id || null;
        const tab = gTabs.find(t => t.id === activeId) || gTabs[0]!;
        const caps = fileCapabilities(tab);
        // File tabs always get the action bar now (copy / open-with / wrap
        // live there too — not just the md-preview & browser affordances).
        // Diff tabs also get it so the unified⇄split toggle has a home; the
        // file-only affordances self-hide via caps / missing `lines`.
        const showActions = tab.kind === 'file' || tab.kind === 'diff';
        // Path row: the full path + the action buttons, shown only for tabs
        // that have a path (file/diff). Terminal/settings have none → no row.
        // Split into dir + filename so the filename is never truncated; the
        // directory part ellipsizes on the left when the path is too long.
        const showPathRow = showActions && !!tab.fullPath;
        const pathSlash = tab.fullPath ? tab.fullPath.lastIndexOf('/') : -1;
        const pathDir = pathSlash >= 0 ? tab.fullPath!.slice(0, pathSlash + 1) : '';
        const pathFile = tab.fullPath ? (pathSlash >= 0 ? tab.fullPath.slice(pathSlash + 1) : tab.fullPath) : '';
        // Host-rendered groups with their own live state keep every tab mounted
        // in its own slot, hidden with display:none when inactive. File/diff/plan bodies are stateless
        // renders of tab data, so those groups render only the active tab.
        // History commit tabs hold lazily-loaded detail/diff state and scroll —
        // they get slots too so switching commits never refetches.
        const slotGroup = g === 'term' || g === 'browser' || g === 'workspaces'
          || g === 'settings' || g === 'history';
        // Singleton groups (workspaces/settings) can only ever hold one tab —
        // the tab strip would be a one-tab header of pure noise, so their
        // content renders headerless (items carry their own headers).
        // Browser deliberately keeps the standard tab strip so it matches the
        // established Terminal surface and can be closed/reopened from Dock.
        const hideTabStrip = g === 'workspaces' || g === 'settings';
        return (
          <div
            className="sheet-group"
            key={g}
            data-active-tab-id={tab.id}
            style={g === activeGroup ? undefined : { display: 'none' }}
          >
            {!hideTabStrip && (
            <div className="sheet-tabs">
              {gTabs.map(t => (
                <button
                  key={t.id}
                  className={`sheet-tab ${t.id === activeId ? 'active' : ''} ${t.preview ? 'preview' : ''}`}
                  data-testid={`sheet-tab-${t.kind}`}
                  title={t.fullPath || (t.preview ? `${t.name} · ${tr('sheet.preview.singleClick')}` : t.name)}
                  onClick={() => actions.activateTab(t.id)}
                  onDoubleClick={() => actions.pinTab(t.id)}
                >
                  {/* Lead slot: file icon by default; becomes a close × on
                      hover only — no separate × column widens every tab. */}
                  <span className="tab-lead">
                    <ExtIco kind={t.icoKind} />
                    <span
                      className="tab-close"
                      role="button"
                      aria-label={tr('common.close')}
                      title={tr('common.close')}
                      onClick={e => { e.stopPropagation(); actions.closeTab(t.id); }}
                    >
                      <Icon d={I.x} size={10} stroke={2.2} />
                    </span>
                  </span>
                  {/* Commit tabs read sha-first and END-truncate (there is no
                      extension tail worth pinning); file tabs keep the middle
                      truncation. ORPHANED marks a commit a fetch made
                      unreachable (its body keeps the snapshot + banner). */}
                  {t.kind === 'commit' ? (
                    <>
                      <span className="name"><span className="name-head">{t.name}</span></span>
                      {t.orphaned && <span className="tab-flag" title={tr('history.orphaned.tab')}>{tr('history.orphaned.tag')}</span>}
                    </>
                  ) : (
                    <TabName name={t.name} />
                  )}
                </button>
              ))}
              {onAddTab && (g === 'term' || g === 'browser') && (
                <button
                  className="tab-add"
                  type="button"
                  title={g === 'term' ? tr('sheet.newTerminal') : tr('browser.newTab')}
                  onClick={() => onAddTab(g)}
                >
                  <Icon d={I.plus} size={12} stroke={1.8} />
                </button>
              )}
              <span className="sheet-tabs-spacer" />
            </div>
            )}
            <div className={`sheet-content${wrap ? '' : ' nowrap'}`}>
              {slotGroup
                ? gTabs.map(slotTab => (
                    <div
                      className="sheet-tab-slot"
                      data-tab-id={slotTab.id}
                      key={slotTab.id}
                      style={slotTab.id === activeId ? undefined : { display: 'none' }}
                    >
                      {renderTab?.(slotTab)}
                    </div>
                  ))
                : (
                    <>
                      {showPathRow && (
                        <div className="sheet-path-row">
                          <span className="sheet-path" title={tab.fullPath}>
                            {pathDir && <span className="sheet-path-dir">{pathDir}</span>}
                            <span className="sheet-path-file">{pathFile}</span>
                          </span>
                          <FileActions
                            tab={tab}
                            caps={caps}
                            actions={actions}
                            tr={tr}
                            wrap={wrap}
                            onToggleWrap={toggleWrap}
                            split={split}
                            onToggleSplit={toggleSplit}
                            externalEditors={externalEditors}
                            openApps={openApps}
                            onOpenWith={onOpenWith}
                            onConfigureEditors={onConfigureEditors}
                          />
                        </div>
                      )}
                      {tab.loading
                        ? <div className="sheet-empty"><span className="spinner" aria-hidden="true" /> {tr('sheet.loading')}</div>
                        : (tab.kind === 'file' || tab.kind === 'diff') && tab.loadError
                        ? (
                          <div className="sheet-empty">
                            {tab.loadError}
                            {tab.retryLoad && (
                              <button className="btn sm secondary" type="button" onClick={tab.retryLoad}>
                                {tr('sheet.retry')}
                              </button>
                            )}
                          </div>
                        )
                        : tab.kind === 'file' && tab.rawSrc
                        ? <ImageBody src={tab.rawSrc} name={tab.name} />
                        : tab.kind === 'file' && tab.icoKind === 'md' && tab.viewMode === 'preview' && tab.lines
                        ? <MarkdownPreview source={tab.lines.map(r => r[1]).join('\n')} />
                        : tab.kind === 'file' && tab.lines
                          ? <FileBody lines={tab.lines} scrollLine={tab.scrollLine} />
                          : tab.kind === 'plan' && tab.planBody
                            ? <PlanBody source={tab.planBody} />
                            : tab.kind === 'diff' && tab.diffText !== undefined
                              ? <DiffBody diffText={tab.diffText} path={tab.fullPath ?? tab.name} split={split} wrap={wrap} />
                              : tab.kind === 'text' && tab.text !== undefined
                                ? <TextBody text={tab.text} />
                                : renderTab
                                  ? renderTab(tab)
                                  : null}
                    </>
                  )}
            </div>
          </div>
        );
      })}
    </section>
  );
}
