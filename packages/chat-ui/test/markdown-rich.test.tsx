// chat-ui markdown rich rendering: mermaid diagrams (tagged fences and
// bare-fence keyword sniffing) with a parse-failure/streaming fallback to the
// plain code block, math via KaTeX, and syntax highlighting for tagged code.
// The mermaid module is mocked — jsdom never lays out a real SVG.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { MarkdownText } from '../src/markdown.js';

const mermaidMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  parse: vi.fn<(source: string) => Promise<unknown>>(),
  render: vi.fn<(id: string, source: string) => Promise<{ svg: string }>>(),
}));

vi.mock('mermaid', () => ({ default: mermaidMocks }));

function mockClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
}

beforeEach(() => {
  vi.clearAllMocks();
  mermaidMocks.parse.mockResolvedValue({});
  mermaidMocks.render.mockImplementation(async (id: string) => ({
    svg: `<svg id="${id}" data-diagram="yes"></svg>`,
  }));
});

describe('MarkdownText mermaid', () => {
  it('renders a tagged mermaid fence as a diagram, not raw text', async () => {
    const { container } = render(
      <MarkdownText>{'```mermaid\nflowchart LR\n  A1 --> B1\n```'}</MarkdownText>,
    );
    await vi.waitFor(() => {
      expect(container.querySelector('.mermaid-block .mermaid-diagram svg')).not.toBeNull();
    });
    expect(mermaidMocks.parse).toHaveBeenCalledWith('flowchart LR\n  A1 --> B1');
    expect(container.querySelector('.mermaid-block pre')).toBeNull();
  });

  it('keeps the copy button copying the diagram source', async () => {
    const writeText = mockClipboard();
    const { container } = render(
      <MarkdownText>{'```mermaid\nflowchart LR\n  A2 --> B2\n```'}</MarkdownText>,
    );
    const btn = container.querySelector('.mermaid-block .code-copy');
    expect(btn).not.toBeNull();
    fireEvent.click(btn!);
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('flowchart LR\n  A2 --> B2');
    });
  });

  it('sniffs a bare fence whose first line is a diagram keyword', async () => {
    const { container } = render(
      <MarkdownText>{'```\nsequenceDiagram\n  Alice->>Bob: hi\n```'}</MarkdownText>,
    );
    await vi.waitFor(() => {
      expect(container.querySelector('.mermaid-block .mermaid-diagram svg')).not.toBeNull();
    });
    expect(mermaidMocks.parse).toHaveBeenCalledWith('sequenceDiagram\n  Alice->>Bob: hi');
  });

  it('does not sniff a bare fence of ordinary prose or code', async () => {
    const { container } = render(
      <MarkdownText>{'```\nconst graph = buildGraph();\n```'}</MarkdownText>,
    );
    await vi.waitFor(() => {
      expect(container.querySelector('.code-block pre')).not.toBeNull();
    });
    expect(mermaidMocks.parse).not.toHaveBeenCalled();
    expect(container.querySelector('.mermaid-block')).toBeNull();
  });

  it('never sniffs inline code, even when it starts with a keyword', () => {
    const { container } = render(
      <MarkdownText>{'Use `flowchart TD` inline here.'}</MarkdownText>,
    );
    expect(container.querySelector('code')?.textContent).toBe('flowchart TD');
    expect(container.querySelector('.mermaid-block')).toBeNull();
    expect(mermaidMocks.parse).not.toHaveBeenCalled();
  });

  it('falls back to the code block when parsing fails', async () => {
    mermaidMocks.parse.mockRejectedValue(new Error('Syntax error in text'));
    const writeText = mockClipboard();
    const { container } = render(
      <MarkdownText>{'```mermaid\nflowchart LR\n  A3 -->>\n```'}</MarkdownText>,
    );
    await vi.waitFor(() => {
      expect(container.querySelector('.mermaid-block pre.mermaid-source code')?.textContent)
        .toBe('flowchart LR\n  A3 -->>');
    });
    expect(container.querySelector('.mermaid-diagram')).toBeNull();
    expect(mermaidMocks.render).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector('.mermaid-block .code-copy')!);
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('flowchart LR\n  A3 -->>');
    });
  });

  it('retries a failed source once it completes (streaming) and then renders', async () => {
    // Mid-stream the diagram body is incomplete and mermaid rejects it; once
    // the closing lines arrive the same block parses and renders.
    mermaidMocks.parse.mockImplementation(async (source: string) => {
      if (source.includes('B4')) return {};
      throw new Error('incomplete');
    });
    const { container, rerender } = render(
      <MarkdownText>{'```mermaid\nflowchart LR\n  A4 -->\n```'}</MarkdownText>,
    );
    await vi.waitFor(() => {
      expect(container.querySelector('pre.mermaid-source')).not.toBeNull();
    });
    rerender(<MarkdownText>{'```mermaid\nflowchart LR\n  A4 --> B4\n```'}</MarkdownText>);
    await vi.waitFor(() => {
      expect(container.querySelector('.mermaid-block .mermaid-diagram svg')).not.toBeNull();
    });
    expect(mermaidMocks.parse).toHaveBeenLastCalledWith('flowchart LR\n  A4 --> B4');
  });

  it('gives every rendered diagram a unique SVG id', async () => {
    const { container } = render(
      <MarkdownText>{
        '```mermaid\nflowchart LR\n  A5 --> B5\n```\n\n```mermaid\nflowchart LR\n  C5 --> D5\n```'
      }</MarkdownText>,
    );
    await vi.waitFor(() => {
      expect(container.querySelectorAll('.mermaid-diagram svg').length).toBe(2);
    });
    const ids = mermaidMocks.render.mock.calls.map(call => call[0]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('MarkdownText math', () => {
  it('renders display math through KaTeX', () => {
    const { container } = render(<MarkdownText>{'$$\nx^2 + y^2 = z^2\n$$'}</MarkdownText>);
    expect(container.querySelector('.katex-display .katex')).not.toBeNull();
  });

  it('renders inline math through KaTeX', () => {
    const { container } = render(<MarkdownText>{'Energy is $e = mc^2$ exactly.'}</MarkdownText>);
    expect(container.querySelector('p .katex')).not.toBeNull();
  });
});

describe('MarkdownText syntax highlighting', () => {
  it('highlights a tagged language block', async () => {
    const writeText = mockClipboard();
    const { container } = render(
      <MarkdownText>{'```js\nconst answer = 42;\n```'}</MarkdownText>,
    );
    const code = container.querySelector('.code-block pre code')!;
    expect(code.classList.contains('hljs')).toBe(true);
    expect(code.querySelector('.hljs-keyword')?.textContent).toBe('const');
    expect(code.querySelector('.hljs-number')?.textContent).toBe('42');
    // Highlight spans must not change what the copy button copies.
    fireEvent.click(container.querySelector('.code-copy')!);
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('const answer = 42;');
    });
  });

  it('leaves untagged non-mermaid blocks unhighlighted', () => {
    const { container } = render(
      <MarkdownText>{'```\njust some plain output\n```'}</MarkdownText>,
    );
    const code = container.querySelector('.code-block pre code')!;
    expect(code.querySelector('[class*="hljs-"]')).toBeNull();
    expect(code.textContent).toBe('just some plain output\n');
  });
});
