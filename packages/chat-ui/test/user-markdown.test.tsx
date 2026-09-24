// User message bubbles render through the same enhanced markdown pipeline as
// assistant messages (the composer is a markdown editor that exports literal
// `**`/`-`/`#` syntax). Covers formatting, bare-URL linkify, soft line
// breaks, mermaid fences, the plain-text history edge cases, and the
// chip-interleaving flow of composer documents. The mermaid module is mocked
// — jsdom never lays out a real SVG.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { UserMessage } from '../src/items.js';
import type { MsgItem } from '../src/types.js';
import type { ComposerDocument } from '@gian/shared';

const mermaidMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  parse: vi.fn<(source: string) => Promise<unknown>>(),
  render: vi.fn<(id: string, source: string) => Promise<{ svg: string }>>(),
}));

vi.mock('mermaid', () => ({ default: mermaidMocks }));

beforeEach(() => {
  vi.clearAllMocks();
  mermaidMocks.parse.mockResolvedValue({});
  mermaidMocks.render.mockImplementation(async (id: string) => ({
    svg: `<svg id="${id}" data-diagram="yes"></svg>`,
  }));
});

function userMsg(text: string, overrides: Partial<MsgItem> = {}): MsgItem {
  return { kind: 'user', id: 'u-1', text, exec: 'claude', ts: 1_000, turn: 1, ...overrides };
}

function docMsg(segments: ComposerDocument['segments']): MsgItem {
  return userMsg('', {
    composerDocument: { version: 1, segments },
    attachments: [{ name: 'spec.pdf', mime: 'application/pdf', url: '/api/x/spec.pdf' }],
  });
}

function childClasses(el: Element): string[] {
  return [...el.children].map(child => child.className);
}

describe('UserMessage markdown', () => {
  it('renders bold/italic/inline code, lists and headings in the bubble', () => {
    const { container } = render(
      <UserMessage item={userMsg('**bold** *italic* `code`\n\n- one\n- two\n\n## plan')} />,
    );
    const text = container.querySelector('.msg-text.user-text.user-md')!;
    expect(text.querySelector('strong')!.textContent).toBe('bold');
    expect(text.querySelector('em')!.textContent).toBe('italic');
    expect(text.querySelector('code')!.textContent).toBe('code');
    expect(text.querySelectorAll('li')).toHaveLength(2);
    expect(text.querySelector('h2')!.textContent).toBe('plan');
    // Literal markers are gone from the rendered text.
    expect(text.textContent).not.toContain('**');
  });

  it('keeps bare-URL linkify through the markdown pipeline (GFM autolink → LinkAnchor)', () => {
    const { container } = render(
      <UserMessage item={userMsg('check https://example.com/docs please')} />,
    );
    const link = container.querySelector('.user-text a[data-link-kind="web"]')!;
    expect(link.getAttribute('href')).toBe('https://example.com/docs');
  });

  it('keeps soft line breaks in text nodes so the pre-wrap bubble still shows them', () => {
    const { container } = render(<UserMessage item={userMsg('line one\nline two')} />);
    expect(container.querySelector('.user-text')!.textContent).toBe('line one\nline two');
  });

  it('renders pre-markdown history harmlessly: unpaired markers stay literal', () => {
    // Accepted consequence of the markdown composer: PAIRED markers in old
    // plain-text messages now format. Lone markers never pair — "a*b" and
    // "2 * 3" stay literal, and "C#" is not a heading.
    const { container } = render(
      <UserMessage item={userMsg('C# issue and a*b and 2 * 3')} />,
    );
    const text = container.querySelector('.user-text')!;
    expect(text.querySelector('h1, h2, strong, em')).toBeNull();
    expect(text.textContent).toBe('C# issue and a*b and 2 * 3');
  });

  it('renders a mermaid fence as a diagram, like assistant content', async () => {
    const { container } = render(
      <UserMessage item={userMsg('```mermaid\nflowchart LR\n  A --> B\n```')} />,
    );
    await vi.waitFor(() => {
      expect(container.querySelector('.mermaid-block .mermaid-diagram svg')).not.toBeNull();
    });
    expect(mermaidMocks.parse).toHaveBeenCalledWith('flowchart LR\n  A --> B');
  });

  it('keeps a fenced code block with its copy button inside the bubble', () => {
    const { container } = render(
      <UserMessage item={userMsg('```ts\nconst x = 1;\n```')} />,
    );
    const block = container.querySelector('.user-text .code-block')!;
    expect(block.querySelector('pre code')).not.toBeNull();
    expect(block.querySelector('.code-copy')).not.toBeNull();
  });
});

describe('UserMessage composer document markdown', () => {
  it('preserves spaces and tabs around reference chips without losing Markdown', () => {
    const { container } = render(<UserMessage item={docMsg([
      { type: 'text', text: 'Before **bold** \t' },
      { type: 'reference', id: 'r1', referenceType: 'attachment', label: 'spec.pdf' },
      { type: 'text', text: ' after `code` ' },
    ])} />);
    expect(container.querySelector('.inline-reference-document')!.textContent).toBe('Before bold \tspec.pdf after code ');
    expect(container.querySelector('strong')!.textContent).toBe('bold');
    expect(container.querySelector('code')!.textContent).toBe('code');
  });

  it('preserves whitespace-only segments between adjacent reference chips', () => {
    const { container } = render(<UserMessage item={docMsg([
      { type: 'reference', id: 'r1', referenceType: 'attachment', label: 'spec.pdf' },
      { type: 'text', text: '  \t' },
      { type: 'reference', id: 'r1', referenceType: 'attachment', label: 'spec.pdf' },
    ])} />);
    expect(container.querySelector('.inline-reference-document')!.textContent).toBe('spec.pdf  \tspec.pdf');
  });

  it('keeps indented code semantics next to references', () => {
    const { container } = render(<UserMessage item={docMsg([
      { type: 'text', text: '    const x = 1;\n' },
      { type: 'reference', id: 'r1', referenceType: 'attachment', label: 'spec.pdf' },
    ])} />);
    expect(container.querySelector('pre code')!.textContent).toContain('const x = 1;');
  });

  it('renders text segments as markdown with chips interleaved in order', () => {
    const { container } = render(
      <UserMessage item={docMsg([
        { type: 'text', text: 'see **this** ' },
        { type: 'reference', id: 'r1', referenceType: 'attachment', label: 'spec.pdf' },
        { type: 'text', text: ' then `code`' },
      ])} />,
    );
    const doc = container.querySelector('.inline-reference-document')!;
    expect(childClasses(doc)).toEqual(['user-md-seg', 'message-inline-reference', 'user-md-seg']);
    expect(doc.querySelector('.user-md-seg strong')!.textContent).toBe('this');
    expect(doc.querySelector('.user-md-seg code')!.textContent).toBe('code');
    expect(doc.textContent).toContain('spec.pdf');
  });

  it('keeps a paragraph break around a chip as a visible gap', () => {
    const { container } = render(
      <UserMessage item={docMsg([
        { type: 'text', text: 'para one\n\n' },
        { type: 'reference', id: 'r1', referenceType: 'attachment', label: 'spec.pdf' },
        { type: 'text', text: '\n\npara two' },
      ])} />,
    );
    const doc = container.querySelector('.inline-reference-document')!;
    expect(childClasses(doc)).toEqual([
      'user-md-seg',
      'user-md-gap',
      'message-inline-reference',
      'user-md-gap',
      'user-md-seg',
    ]);
    expect(doc.textContent).toContain('para one');
    expect(doc.textContent).toContain('para two');
  });

  it('maps a soft break at a segment boundary to an explicit line break', () => {
    const { container } = render(
      <UserMessage item={docMsg([
        { type: 'text', text: 'line one\n' },
        { type: 'reference', id: 'r1', referenceType: 'attachment', label: 'spec.pdf' },
        { type: 'text', text: 'line two' },
      ])} />,
    );
    const doc = container.querySelector('.inline-reference-document')!;
    expect(childClasses(doc)).toEqual([
      'user-md-seg',
      'user-md-br',
      'message-inline-reference',
      'user-md-seg',
    ]);
  });
});
