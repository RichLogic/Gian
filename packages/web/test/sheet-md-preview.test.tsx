import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { Sheet } from '../src/components/Sheet.js';
import type { SheetTab } from '../src/components/Sheet.js';

// The Sheet md preview mounts chat-ui's MarkdownText (the transcript's
// enhanced pipeline), so GFM tables render as real <table> markup, mermaid
// fences render as diagrams, math renders through KaTeX, and tagged code is
// highlighted. The mermaid module is mocked — jsdom never lays out a real
// SVG (same pattern as chat-ui's markdown-rich.test.tsx).
const mermaidMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  parse: vi.fn<(source: string) => Promise<unknown>>(),
  render: vi.fn<(id: string, source: string) => Promise<{ svg: string }>>(),
}));

vi.mock('mermaid', () => ({ default: mermaidMocks }));

const md = [
  '# Title',
  '',
  '| 来源 | 30 天 episode | 占比 |',
  '| --- | ---: | ---: |',
  '| QCE 云监控 | 977 | 48% |',
  '| RUM | 655 | 32% |',
  '',
  'Trailing paragraph.',
].join('\n');

function mdTab(source: string = md): SheetTab {
  return {
    id: 't1', group: 'files', name: 'report.md', kind: 'file', icoKind: 'md', ico: 'MD',
    lines: source.split('\n').map((l, i) => [String(i + 1), l] as [string, string]),
    fullPath: '/tmp/demo/report.md', viewMode: 'preview',
  };
}

function planTab(source: string): SheetTab {
  return {
    id: 'p1', group: 'files', name: 'Plan', kind: 'plan', icoKind: 'plan', ico: 'P',
    planBody: source,
  };
}

const actions = {
  activateTab: () => {}, closeTab: () => {}, pinTab: () => {}, setTabViewMode: () => {},
};

function renderSheet(tab: SheetTab) {
  return render(
    <Sheet tabs={[tab]} activeByGroup={{ files: tab.id }} activeGroup="files" actions={actions} />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mermaidMocks.parse.mockResolvedValue({});
  mermaidMocks.render.mockImplementation(async (id: string) => ({
    svg: `<svg id="${id}" data-diagram="yes"></svg>`,
  }));
});

afterEach(() => cleanup());

describe('Sheet markdown preview', () => {
  it('renders GFM tables as real <table> markup, not flattened text', () => {
    const { container } = renderSheet(mdTab());
    expect(container.querySelector('.md-preview table')).toBeTruthy();
    expect(container.querySelectorAll('.md-preview thead th').length).toBe(3);
    expect(container.querySelectorAll('.md-preview tbody tr').length).toBe(2);

    const text = container.querySelector('.md-preview')!.textContent ?? '';
    expect(text).not.toContain('---'); // separator row is not leaked as text
    expect(text).not.toContain('| QCE'); // cells are not run together with pipes
    expect(text).toContain('QCE 云监控');
  });

  it('still repairs a spec-invalid table glued to a list item', () => {
    const { container } = renderSheet(mdTab([
      '- item one',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
    ].join('\n')));
    expect(container.querySelector('.md-preview table')).toBeTruthy();
    expect(container.querySelectorAll('.md-preview tbody td').length).toBe(2);
  });

  it('renders a mermaid fence as a diagram, not a code block', async () => {
    const { container } = renderSheet(mdTab('```mermaid\nflowchart LR\n  A --> B\n```'));
    await vi.waitFor(() => {
      expect(container.querySelector('.md-preview .mermaid-block .mermaid-diagram svg')).not.toBeNull();
    });
    expect(mermaidMocks.parse).toHaveBeenCalledWith('flowchart LR\n  A --> B');
  });

  it('renders display math through KaTeX', () => {
    const { container } = renderSheet(mdTab('$$\nx^2 + y^2 = z^2\n$$'));
    expect(container.querySelector('.md-preview .katex-display .katex')).not.toBeNull();
  });

  it('highlights a tagged code block', () => {
    const { container } = renderSheet(mdTab('```js\nconst answer = 42;\n```'));
    const code = container.querySelector('.md-preview .code-block pre code')!;
    expect(code.classList.contains('hljs')).toBe(true);
    expect(code.querySelector('.hljs-keyword')?.textContent).toBe('const');
  });

  it('routes links through LinkAnchor', () => {
    const { container } = renderSheet(mdTab('See the [Gian docs](https://example.com/docs).'));
    const anchor = container.querySelector<HTMLAnchorElement>('.md-preview a[href="https://example.com/docs"]');
    expect(anchor).not.toBeNull();
    expect(anchor!.textContent).toBe('Gian docs');
  });

  it('renders plan bodies through the same enhanced pipeline', () => {
    const { container } = renderSheet(planTab([
      '## Steps',
      '',
      '| step | owner |',
      '| --- | --- |',
      '| build | agent |',
      '',
      'Inline math $e = mc^2$ works too.',
    ].join('\n')));
    expect(container.querySelector('.md-preview table')).toBeTruthy();
    expect(container.querySelector('.md-preview .katex')).not.toBeNull();
  });
});
