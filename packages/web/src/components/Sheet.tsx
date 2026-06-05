import { Fragment, useEffect, useRef, useState } from 'react';
import type { OpenFileCategory, OpenAppPrefs } from '@gian/shared';
import { useT } from '../i18n/index.js';
import { parseUnifiedDiff } from '../transcript/apply.js';
import { Splitter } from './Splitter.js';
import { AppIcon } from './AppIcon.js';

export type SheetTabKind = 'file' | 'term' | 'settings' | 'plan' | 'diff';
export type FileViewMode = 'source' | 'preview';

/** Target chosen from a file tab's "Open with…" menu, or via the smart Open
 *  button. `system` names: `default` (OS default app) / `finder` (reveal) /
 *  `browser` (raw in a new tab) / `terminal` (at folder). `default` + `browser`
 *  are no longer listed in the menu — they're the two outcomes of the smart
 *  Open main button — but remain valid targets. `editor` = a configured app. */
export type SheetOpenWith =
  | { kind: 'system'; name: 'default' | 'finder' | 'browser' | 'terminal' }
  | { kind: 'app'; app: string }
  | { kind: 'editor'; id: string };

export interface SheetTab {
  id: string;
  pane: 0 | 1;
  name: string;
  kind: SheetTabKind;
  icoKind: 'md' | 'ts' | 'tsx' | 'json' | 'css' | 'term' | 'gear' | 'plan' | 'diff' | 'img';
  ico: string;
  /** When true, this tab is a "preview" (italic name, replaced by next preview).
   *  Double-click or pin to promote to permanent. */
  preview?: boolean;
  /** Source code lines (for file tabs). Each row: [number, text, syntaxClass?, diffClass?]. */
  lines?: Array<[string, string, string?, string?]>;
  /** For md file tabs, toggles source vs rendered preview. */
  viewMode?: FileViewMode;
  /** 1-based line to scroll to + highlight when the tab opens (file-link jump). */
  scrollLine?: number;
  /** Optional full path shown on hover (§3.14). */
  fullPath?: string;
  /** Working tree this file/diff belongs to — authoritative for routing
   *  "open with" back to the host (avoids re-deriving from the abs path, which
   *  mis-handles sibling roots like `/…/Gian` vs `/…/Gian-Dev`). */
  workingTreeId?: string;
  /** Plan markdown body (for kind === 'plan'). */
  planBody?: string;
  /** Raw unified diff text (for kind === 'diff'). */
  diffText?: string;
  /** `/raw` URL for image tabs — rendered inline with an `<img>` (no `lines`). */
  rawSrc?: string;
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
  /** Visually hide panes whose tabs are all terminals — the dock's
   *  terminal show/hide toggle relies on this so xterm stays mounted
   *  (tty keeps running) across hide cycles. */
  hideTerm?: boolean;
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
  gear: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M19 12a7 7 0 0 0-.2-1.6l2-1.6-2-3.4-2.4.9a7 7 0 0 0-2.8-1.6L13.2 2H10.8l-.4 2.7a7 7 0 0 0-2.8 1.6L5.2 5.4l-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .6.1 1.1.2 1.6l-2 1.6 2 3.4 2.4-.9a7 7 0 0 0 2.8 1.6l.4 2.7h2.4l.4-2.7a7 7 0 0 0 2.8-1.6l2.4.9 2-3.4-2-1.6c.1-.5.2-1 .2-1.6z',
  check: 'M5 12l5 5L20 7',
  plus: 'M12 5v14 M5 12h14',
  diff: 'M9 4v12 M9 4l-3 3 M9 4l3 3 M15 20V8 M15 20l3-3 M15 20l-3-3',
  image: 'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M8.5 10.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z M21 16l-5-5L5 21',
};

function ExtIco({ kind, ico }: { kind: SheetTab['icoKind']; ico: string }) {
  if (kind === 'gear') return <span className={`ext-ico ${kind}`}><Icon d={I.gear} size={9} stroke={2} /></span>;
  if (kind === 'plan') return <span className={`ext-ico ${kind}`}><Icon d={I.check} size={9} stroke={2.4} /></span>;
  if (kind === 'img') return <span className={`ext-ico ${kind}`}><Icon d={I.image} size={10} stroke={1.7} /></span>;
  if (kind === 'diff') return <span className={`ext-ico ${kind}`}><Icon d={I.diff} size={10} stroke={1.8} /></span>;
  return <span className={`ext-ico ${kind}`}>{ico || kind.toUpperCase().slice(0, 2)}</span>;
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
 *  (old | new) view; `wrap` mirrors the sheet's word-wrap preference. */
function DiffBody({ diffText, path, split, wrap }: { diffText: string; path?: string; split?: boolean; wrap?: boolean }) {
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

/** Images we render inline (`<img src=/raw>`). Also used to decide image tabs. */
export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico']);

// "Open" routes a file into one of a few broad categories; the target for each
// category (an installed app, a new browser tab, or reveal in Finder) is
// user-configurable in Settings (SystemConfig.open_apps), with these built-in
// defaults. Categories: code/text → TextEdit; web/images/pdf → new tab; else → Finder.
const IMAGE_PREVIEW_EXTS = new Set([...IMAGE_EXTS, 'tiff', 'tif', 'heic', 'heif']);
const TEXT_EXTS = new Set([
  'txt', 'text', 'log', 'csv', 'tsv', 'md', 'markdown', 'mdx', 'rst',
  'json', 'json5', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties', 'xml', 'plist',
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'astro',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hxx', 'm', 'mm', 'swift',
  'php', 'pl', 'pm', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'lua', 'r', 'sql', 'graphql', 'gql', 'proto',
  'dockerfile', 'makefile', 'gitignore', 'gitattributes', 'editorconfig', 'lock',
]);
export function openCategoryFor(name: string): OpenFileCategory {
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (IMAGE_PREVIEW_EXTS.has(ext)) return 'images';
  if (ext === 'html' || ext === 'htm') return 'web';
  if (TEXT_EXTS.has(ext)) return 'code';
  return 'other';
}

/** Built-in per-category default target (sentinels: `@newtab` / `@finder`). */
export const DEFAULT_OPEN_TARGET: Record<OpenFileCategory, string> = {
  code: 'TextEdit', web: '@newtab', images: '@newtab', pdf: '@newtab', other: '@finder',
};

/** Resolve a category + the user's prefs into a concrete open target. */
export function resolveOpenTarget(cat: OpenFileCategory, openApps?: OpenAppPrefs): SheetOpenWith {
  const v = (openApps?.[cat]) || DEFAULT_OPEN_TARGET[cat];
  if (v === '@newtab') return { kind: 'system', name: 'browser' };
  if (v === '@finder') return { kind: 'system', name: 'finder' };
  return { kind: 'app', app: v };
}

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

export function Sheet({ tabs, active, actions, renderTab, onAddTab, hideTerm, hidden, externalEditors, openApps, onOpenWith, onConfigureEditors }: Props) {
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
  const byPane: Record<0 | 1, SheetTab[]> = { 0: [], 1: [] };
  tabs.forEach(t => byPane[t.pane].push(t));
  const panes: Array<{ idx: 0 | 1; tabs: SheetTab[] }> = [];
  if (byPane[0].length) panes.push({ idx: 0, tabs: byPane[0] });
  if (byPane[1].length) panes.push({ idx: 1, tabs: byPane[1] });
  if (panes.length === 0) return null;

  // Panes that the dock's terminal toggle has collapsed (`display:none`) still
  // sit in `panes` so xterm stays mounted, but they don't occupy layout space.
  // The top pane only gets a fixed split height when there's a *visible* pane
  // below it — otherwise it must fill the sheet (matching the all-tabs-closed
  // path, where the term pane is gone entirely).
  const isHiddenTermPane = (p: { tabs: SheetTab[] }) =>
    !!hideTerm && p.tabs.every(t => t.kind === 'term');
  const visiblePaneCount = panes.filter(p => !isHiddenTermPane(p)).length;

  return (
    <section className="sheet" data-testid="workbench-sheet" style={hidden ? { display: 'none' } : undefined}>
      {panes.map((p, i) => {
        const activeId = active[p.idx] || p.tabs[0]?.id || null;
        const tab = p.tabs.find(t => t.id === activeId) || p.tabs[0]!;
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
        const paneHidden = isHiddenTermPane(p);
        const sizingStyle = i === 0 && visiblePaneCount === 2
          ? { flex: 'none', height: 'var(--sheet-top-h, 320px)' }
          : undefined;
        const paneStyle = paneHidden
          ? { ...(sizingStyle ?? {}), display: 'none' as const }
          : sizingStyle;
        return (
          <Fragment key={p.idx}>
            {i > 0 && !paneHidden && <Splitter axis="y" varName="--sheet-top-h" base={320} min={120} max={700} />}
            <div className="sheet-pane" style={paneStyle}>
              <div className="sheet-tabs">
                {p.tabs.map(t => (
                  <button
                    key={t.id}
                    className={`sheet-tab ${t.id === activeId ? 'active' : ''} ${t.preview ? 'preview' : ''}`}
                    data-testid={`sheet-tab-${t.kind}`}
                    title={t.fullPath || (t.preview ? `${t.name} · ${tr('sheet.preview.singleClick')}` : t.name)}
                    onClick={() => actions.activateTab(p.idx, t.id)}
                    onDoubleClick={() => actions.pinTab(t.id)}
                  >
                    {/* Lead slot: file icon by default; becomes a close × on
                        hover only — no separate × column widens every tab. */}
                    <span className="tab-lead">
                      <ExtIco kind={t.icoKind} ico={t.ico} />
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
                    <TabName name={t.name} />
                  </button>
                ))}
                {onAddTab && p.tabs.some(t => t.kind === 'term') && (
                  <button
                    className="tab-add"
                    type="button"
                    title={tr('sheet.newTerminal')}
                    onClick={() => onAddTab(p.idx)}
                  >
                    <Icon d={I.plus} size={12} stroke={1.8} />
                  </button>
                )}
                <span className="sheet-tabs-spacer" />
              </div>
              <div className={`sheet-content${wrap ? '' : ' nowrap'}`}>
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
                {tab.kind === 'file' && tab.rawSrc
                  ? <ImageBody src={tab.rawSrc} name={tab.name} />
                  : tab.kind === 'file' && tab.icoKind === 'md' && tab.viewMode === 'preview' && tab.lines
                  ? <MarkdownPreview source={tab.lines.map(r => r[1]).join('\n')} />
                  : tab.kind === 'file' && tab.lines
                    ? <FileBody lines={tab.lines} scrollLine={tab.scrollLine} />
                    : tab.kind === 'plan' && tab.planBody
                      ? <PlanBody source={tab.planBody} />
                      : tab.kind === 'diff' && tab.diffText !== undefined
                        ? <DiffBody diffText={tab.diffText} path={tab.fullPath ?? tab.name} split={split} wrap={wrap} />
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
