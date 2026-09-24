import { useEffect, useState } from 'react';

/** Mermaid diagram support for MarkdownText: lazy-loaded `mermaid` (kept out
 *  of the main bundle), parse-gated rendering, and bare-fence keyword
 *  sniffing. Anything that fails to parse — including a diagram whose source
 *  is still streaming in — falls back to the plain code block. Rendering is
 *  theme-aware: the host's `body[data-theme]` switch (light / warm / dark)
 *  re-initializes mermaid and re-renders the diagram. */

type MermaidApi = typeof import('mermaid').default;
type MermaidConfig = Parameters<MermaidApi['initialize']>[0];

/** The theme values hosts write to `body[data-theme]`. Unknown/absent values
 *  count as light. */
type AppTheme = 'light' | 'warm' | 'dark';

/** Light and warm share one mermaid config (neutral draws dark strokes on a
 *  light card); dark gets mermaid's dark theme. This is also the SVG cache
 *  key, so flipping light ↔ warm never re-runs layout. */
type DiagramTheme = 'neutral' | 'dark';

function readAppTheme(): AppTheme {
  if (typeof document === 'undefined') return 'light';
  const value = document.body?.getAttribute('data-theme');
  return value === 'dark' || value === 'warm' ? value : 'light';
}

/** Tracks the host's `body[data-theme]` attribute. chat-ui stays
 *  host-agnostic: the DOM attribute is the contract (both Gian Web and
 *  Remote Web flip it), and the MutationObserver catches live switches. */
function useAppTheme(): AppTheme {
  const [theme, setTheme] = useState<AppTheme>(readAppTheme);
  useEffect(() => {
    if (typeof document === 'undefined' || !document.body) return;
    const observer = new MutationObserver(() => setTheme(readAppTheme()));
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/** Dark values match the host dark surface tokens (chat-ui.css cards ride
 *  `var(--surface-2)` ≈ #252629, raised ≈ #323438, text ≈ #E0E1E4) so diagram
 *  boxes, ER attribute rows, and table fills sit on the card instead of
 *  mermaid's default near-black. */
function mermaidConfig(theme: DiagramTheme): MermaidConfig {
  const base: MermaidConfig = {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
  };
  if (theme === 'neutral') return { ...base, theme: 'neutral' };
  return {
    ...base,
    theme: 'dark',
    themeVariables: {
      background: '#252629',
      primaryColor: '#323438',
      primaryBorderColor: '#52555B',
      primaryTextColor: '#E0E1E4',
      secondaryColor: '#2A2C2F',
      tertiaryColor: '#18191B',
      lineColor: '#9A9DA3',
      textColor: '#E0E1E4',
      mainBkg: '#323438',
      nodeBkg: '#323438',
      nodeBorder: '#52555B',
      clusterBkg: '#2A2C2F',
      edgeLabelBackground: '#252629',
      attributeBackgroundColorOdd: '#2A2C2F',
      attributeBackgroundColorEven: '#252629',
    },
  };
}

let mermaidApiPromise: Promise<MermaidApi> | null = null;
let appliedTheme: DiagramTheme | null = null;

/** Resolves the lazily imported mermaid api, (re-)initializing it whenever
 *  the diagram theme changed since the last render (`initialize` is global). */
async function mermaidFor(theme: DiagramTheme): Promise<MermaidApi> {
  mermaidApiPromise ??= import('mermaid').then(module => module.default);
  const api = await mermaidApiPromise;
  if (appliedTheme !== theme) {
    api.initialize(mermaidConfig(theme));
    appliedTheme = theme;
  }
  return api;
}

/** Diagram-type keywords accepted at the start of a bare (language-less)
 *  fenced block. Keep in sync with the mermaid diagram taxonomy. */
const MERMAID_KEYWORDS = [
  'flowchart',
  'graph',
  'sequenceDiagram',
  'erDiagram',
  'classDiagram',
  'stateDiagram',
  'stateDiagram-v2',
  'gantt',
  'journey',
  'pie',
  'mindmap',
  'timeline',
  'gitGraph',
  'C4Context',
  'requirementDiagram',
  'quadrantChart',
  'xychart-beta',
  'block-beta',
  'packet-beta',
  'kanban',
  'sankey-beta',
  'architecture-beta',
  'radar-beta',
  'treemap-beta',
];

const MERMAID_FIRST_LINE = new RegExp(
  `^(?:${MERMAID_KEYWORDS.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?:\\s|$)`,
);

/** True when a fenced block without a language tag starts with a mermaid
 *  diagram keyword (leading blank lines and a `%%` comment are skipped). */
export function looksLikeMermaid(source: string): boolean {
  const first = source
    .split('\n')
    .map(line => line.trim())
    .find(line => line.length > 0 && !line.startsWith('%%'));
  return first !== undefined && MERMAID_FIRST_LINE.test(first);
}

/** Successful renders are memoized by diagram theme + exact source so
 *  streaming deltas and transcript re-renders don't re-run the SVG layout,
 *  and a theme flip never serves an SVG rendered for the other theme. Failed
 *  parses are not cached: a source that fails mid-stream becomes valid once
 *  the closing lines arrive, and must be retried. Bounded — transcripts are
 *  long-lived. */
const SVG_CACHE_LIMIT = 50;
const svgCache = new Map<string, string>();

function cacheKey(theme: DiagramTheme, source: string): string {
  return `${theme}\n${source}`;
}

let renderSeq = 0;

/** Renders mermaid source as SVG. While the module loads, or when parsing
 *  fails (invalid or still-incomplete source), it renders the raw block so
 *  the transcript always shows something copyable. */
export function MermaidDiagram({ source }: { source: string }) {
  const theme = useAppTheme() === 'dark' ? 'dark' : 'neutral';
  const key = cacheKey(theme, source);
  const [result, setResult] = useState<{ key: string; svg: string | null } | null>(() => {
    const cached = svgCache.get(key);
    return cached !== undefined ? { key, svg: cached } : null;
  });

  useEffect(() => {
    const cached = svgCache.get(key);
    if (cached !== undefined) {
      setResult({ key, svg: cached });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const mermaid = await mermaidFor(theme);
        // Gate on parse first: suppressErrorRendering keeps `render` from
        // injecting its error SVG into the document, but parse gives us the
        // clean signal to fall back before attempting layout.
        await mermaid.parse(source);
        const { svg } = await mermaid.render(`gian-mmd-${(renderSeq += 1)}`, source);
        // mermaid's config is global: a theme flip that landed mid-flight
        // means this SVG may carry the new theme's styling. Drop it — the
        // flip already re-rendered this component with the new cache key.
        if (appliedTheme !== theme) return;
        if (svgCache.size >= SVG_CACHE_LIMIT) {
          const oldest = svgCache.keys().next().value;
          if (oldest !== undefined) svgCache.delete(oldest);
        }
        svgCache.set(key, svg);
        if (!cancelled) setResult({ key, svg });
      } catch {
        if (!cancelled) setResult({ key, svg: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key, theme, source]);

  // Result for a stale source/theme (effect hasn't settled yet) counts as
  // loading — a theme flip briefly shows the raw block, never the SVG styled
  // for the previous theme.
  const current = result && result.key === key ? result.svg : undefined;
  if (current) {
    return <div className="mermaid-diagram" dangerouslySetInnerHTML={{ __html: current }} />;
  }
  return (
    <pre className="mermaid-source">
      <code>{source}</code>
    </pre>
  );
}
