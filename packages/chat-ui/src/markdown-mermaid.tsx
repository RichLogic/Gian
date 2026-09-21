import { useEffect, useState } from 'react';

/** Mermaid diagram support for MarkdownText: lazy-loaded `mermaid` (kept out
 *  of the main bundle), parse-gated rendering, and bare-fence keyword
 *  sniffing. Anything that fails to parse — including a diagram whose source
 *  is still streaming in — falls back to the plain code block. */

type MermaidApi = typeof import('mermaid').default;

let mermaidApiPromise: Promise<MermaidApi> | null = null;

function loadMermaid(): Promise<MermaidApi> {
  mermaidApiPromise ??= import('mermaid').then(module => {
    const api = module.default;
    api.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: 'neutral',
    });
    return api;
  });
  return mermaidApiPromise;
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

/** Successful renders are memoized by exact source so streaming deltas and
 *  transcript re-renders don't re-run the SVG layout. Failed parses are not
 *  cached: a source that fails mid-stream becomes valid once the closing
 *  lines arrive, and must be retried. Bounded — transcripts are long-lived. */
const SVG_CACHE_LIMIT = 50;
const svgCache = new Map<string, string>();

let renderSeq = 0;

/** Renders mermaid source as SVG. While the module loads, or when parsing
 *  fails (invalid or still-incomplete source), it renders the raw block so
 *  the transcript always shows something copyable. */
export function MermaidDiagram({ source }: { source: string }) {
  const [result, setResult] = useState<{ src: string; svg: string | null } | null>(() => {
    const cached = svgCache.get(source);
    return cached !== undefined ? { src: source, svg: cached } : null;
  });

  useEffect(() => {
    const cached = svgCache.get(source);
    if (cached !== undefined) {
      setResult({ src: source, svg: cached });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const mermaid = await loadMermaid();
        // Gate on parse first: suppressErrorRendering keeps `render` from
        // injecting its error SVG into the document, but parse gives us the
        // clean signal to fall back before attempting layout.
        await mermaid.parse(source);
        const { svg } = await mermaid.render(`gian-mmd-${(renderSeq += 1)}`, source);
        if (svgCache.size >= SVG_CACHE_LIMIT) {
          const oldest = svgCache.keys().next().value;
          if (oldest !== undefined) svgCache.delete(oldest);
        }
        svgCache.set(source, svg);
        if (!cancelled) setResult({ src: source, svg });
      } catch {
        if (!cancelled) setResult({ src: source, svg: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source]);

  // Result for a stale source (effect hasn't settled yet) counts as loading.
  const current = result && result.src === source ? result.svg : undefined;
  if (current) {
    return <div className="mermaid-diagram" dangerouslySetInnerHTML={{ __html: current }} />;
  }
  return (
    <pre className="mermaid-source">
      <code>{source}</code>
    </pre>
  );
}
