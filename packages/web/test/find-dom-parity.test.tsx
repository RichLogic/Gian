/**
 * Canonical-offset parity fixtures (Issue #168 / 0.6.7): for messages
 * rendered by the REAL chat-ui components (MarkdownText,
 * InlineReferenceDocument), the shared projection must align exactly, and a
 * canonical UTF-16 range (findLiteralRanges on the projection) must map to
 * the DOM Range selecting the SAME text — including hits preceded by other
 * formatted content, hard breaks, table cells, math (atomic visible anchor),
 * images (atomic element anchor) and composer reference chips. No occurrence
 * guessing, no invisible-node highlights.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { InlineReferenceDocument, MarkdownText, UserMessage } from '@gian/chat-ui';
import type { MsgItem } from '@gian/chat-ui';
import type { ComposerDocument } from '@gian/shared';
import {
  findLiteralRanges,
  projectComposerSearchText,
  projectSearchText,
} from '@gian/shared';
import {
  alignMessageToProjection,
  rangeForProjectionRange,
} from '../src/transcript/find-in-transcript.js';

function renderMarkdown(markdown: string): HTMLElement {
  const { container } = render(
    <div
      className="msg-text"
      data-transcript-selectable="true"
      data-transcript-source-id="1:assistant:m-1"
      data-transcript-source-kind="assistant"
    >
      <MarkdownText>{markdown}</MarkdownText>
    </div>,
  );
  return container.firstElementChild as HTMLElement;
}

function renderDocument(document: ComposerDocument): HTMLElement {
  const { container } = render(
    <div
      className="msg-text"
      data-transcript-selectable="true"
      data-transcript-source-id="1:user:m-1"
      data-transcript-source-kind="user"
    >
      <InlineReferenceDocument document={document} />
    </div>,
  );
  return container.firstElementChild as HTMLElement;
}

function renderUserDocument(document: ComposerDocument): HTMLElement {
  const item: MsgItem = {
    kind: 'user',
    id: 'm-1',
    text: '',
    exec: 'claude',
    ts: 1,
    turn: 1,
    composerDocument: document,
  };
  const { container } = render(<UserMessage item={item} />);
  const root = container.querySelector('.msg-text');
  if (!(root instanceof HTMLElement)) throw new Error('user message text missing');
  return root;
}

function reference(id: string, label: string): ComposerDocument['segments'][number] {
  return { type: 'reference', id, referenceType: 'context', label };
}

function labelRange(root: HTMLElement, projected: string, query: string) {
  const alignment = alignMessageToProjection(root, projected);
  expect(alignment, `alignment failed for ${JSON.stringify(projected)}`).not.toBeNull();
  const [range] = findLiteralRanges(projected, query);
  const mapped = rangeForProjectionRange(alignment!.spans, range!);
  expect(mapped, `range for ${query} unmappable`).not.toBeNull();
  return mapped!.range;
}

function mappedTexts(root: HTMLElement, projected: string, query: string): string[] {
  const alignment = alignMessageToProjection(root, projected);
  expect(alignment, `alignment failed for projection: ${JSON.stringify(projected)}`).not.toBeNull();
  return findLiteralRanges(projected, query).map(range => {
    const mapped = rangeForProjectionRange(alignment!.spans, range);
    expect(mapped, `range ${JSON.stringify(range)} unmappable`).not.toBeNull();
    return mapped!.range.toString();
  });
}

const CASES: Array<{ name: string; markdown: string; query: string }> = [
  { name: 'inline emphasis spanning a boundary', markdown: 'The **release** plan ships Friday', query: 'release plan' },
  { name: 'inline code identifier', markdown: 'call `loadEvents` twice', query: 'loadEvents' },
  { name: 'fenced code block', markdown: '```ts\nconst plan = 1;\n```', query: 'const plan' },
  { name: 'Chinese short term', markdown: '发布计划明天评审', query: '计划' },
  { name: 'link text without the destination', markdown: 'see [the release notes](https://example.com/notes) today', query: 'release notes' },
  { name: 'case-insensitive ASCII', markdown: 'Release Plan', query: 'release plan' },
  { name: 'a hit preceded by other formatted content', markdown: '```ts\nconst x = 1;\n```\n\nThen **ship** it', query: 'ship' },
];

describe('canonical range → visible DOM (real renderers)', () => {
  for (const fixture of CASES) {
    it(fixture.name, () => {
      const projected = projectSearchText(fixture.markdown);
      expect(mappedTexts(renderMarkdown(fixture.markdown), projected, fixture.query))
        .toEqual(findLiteralRanges(projected, fixture.query)
          .map(range => projected.slice(range.start, range.end)));
    });
  }

  it('hard break: the range crosses the <br> boundary at exact node offsets', () => {
    const markdown = 'line one  \nline two';
    const projected = projectSearchText(markdown);
    expect(projected).toBe('line one\nline two');
    const root = renderMarkdown(markdown);
    const alignment = alignMessageToProjection(root, projected);
    expect(alignment).not.toBeNull();
    const [range] = findLiteralRanges(projected, 'one\nline');
    const domRange = rangeForProjectionRange(alignment!.spans, range!)!.range;
    // 'one' ends the first text node; 'line' starts the second (the newline
    // itself has no DOM text node — the range is still exact).
    expect((domRange.startContainer as Text).data).toBe('line one');
    expect(domRange.startOffset).toBe(5);
    expect((domRange.endContainer as Text).data).toBe('line two');
    expect(domRange.endOffset).toBe(4);
  });

  it('table cells: a later-cell hit maps to that cell, not the first', () => {
    const markdown = '| 计划 | 状态 |\n| --- | --- |\n| 发布 | 就绪 |';
    const projected = projectSearchText(markdown);
    const root = renderMarkdown(markdown);
    const alignment = alignMessageToProjection(root, projected);
    expect(alignment).not.toBeNull();
    const [range] = findLiteralRanges(projected, '就绪');
    const domRange = rangeForProjectionRange(alignment!.spans, range!)!.range;
    expect(domRange.toString()).toBe('就绪');
    expect((domRange.startContainer as Text).data).toBe('就绪');
  });

  it('multiple text nodes inside ONE cell get no spurious cell separator', () => {
    const markdown = '| before **hit** after | next |';
    const projected = projectSearchText(markdown);
    const root = renderMarkdown(markdown);
    const alignment = alignMessageToProjection(root, projected);
    expect(alignment).not.toBeNull();
    // The aligned text is exactly 'before hit after\tnext' — no tabs inside
    // the first cell, exactly one between cells.
    const [range] = findLiteralRanges(projected, 'hit after');
    const domRange = rangeForProjectionRange(alignment!.spans, range!)!.range;
    expect(domRange.toString()).toBe('hit after');
  });

  it('block math between prose: boundaries around the atomic anchor align', () => {
    const markdown = 'before math\n\n$$x+1$$\n\nafter math';
    const projected = projectSearchText(markdown);
    const root = renderMarkdown(markdown);
    const alignment = alignMessageToProjection(root, projected);
    expect(alignment).not.toBeNull();
    const [range] = findLiteralRanges(projected, 'after math');
    const domRange = rangeForProjectionRange(alignment!.spans, range!)!.range;
    expect(domRange.toString()).toBe('after math');
  });

  it('an image paragraph between prose aligns and the image maps atomically', () => {
    const markdown = 'before\n\n![architecture diagram](https://example.com/a.png)\n\nafter';
    const projected = projectSearchText(markdown);
    const root = renderMarkdown(markdown);
    const alignment = alignMessageToProjection(root, projected);
    expect(alignment).not.toBeNull();
    const [range] = findLiteralRanges(projected, 'architecture');
    const mapped = rangeForProjectionRange(alignment!.spans, range!)!;
    expect(mapped.atomicElement).toBe(root.querySelector('img'));
    const [textRange] = findLiteralRanges(projected, 'after');
    expect(rangeForProjectionRange(alignment!.spans, textRange!)!.range.toString()).toBe('after');
  });

  it('code followed by a paragraph: the renderer newline is not double-consumed as the block separator', () => {
    const markdown = '```ts\nconst x = 1;\n```\n\nafter the code';
    const projected = projectSearchText(markdown);
    expect(projected).toBe('const x = 1;\nafter the code');
    const root = renderMarkdown(markdown);
    const alignment = alignMessageToProjection(root, projected);
    expect(alignment).not.toBeNull();
    const [range] = findLiteralRanges(projected, 'after the code');
    const domRange = rangeForProjectionRange(alignment!.spans, range!)!.range;
    expect(domRange.toString()).toBe('after the code');
  });

  it('trailing blank lines INSIDE the fence survive; only the renderer-added newline is stripped', () => {
    const markdown = '```ts\nconst x = 1;\n\n```';
    const projected = projectSearchText(markdown);
    expect(projected).toBe('const x = 1;\n');
    const root = renderMarkdown(markdown);
    const alignment = alignMessageToProjection(root, projected);
    expect(alignment).not.toBeNull();
    const [range] = findLiteralRanges(projected, 'const x');
    const domRange = rangeForProjectionRange(alignment!.spans, range!)!.range;
    expect(domRange.toString()).toBe('const x');
  });

  it('code whitespace is preserved across normalization with exact node offsets', () => {
    const source = '  const x = 1;\n\n\n';
    const markdown = ['```ts', source, '```'].join('\n');
    const projected = projectSearchText(markdown);
    expect(projected).toBe(source);
    const root = renderMarkdown(markdown);
    const alignment = alignMessageToProjection(root, projected);
    expect(alignment).not.toBeNull();
    const [range] = findLiteralRanges(projected, 'x = 1;\n\n\n');
    const mapped = rangeForProjectionRange(alignment!.spans, range!)!;
    expect(mapped.range.toString()).toBe('x = 1;\n\n\n');
    const node = mapped.range.endContainer as Text;
    expect(mapped.range.endOffset).toBe(node.data.length - 1);
  });

  it('math: the canonical TeX range highlights the whole visible .katex element, never the hidden annotation', () => {
    const markdown = 'energy is $E=mc^2$ exactly';
    const projected = projectSearchText(markdown);
    expect(projected).toContain('E=mc^2');
    const root = renderMarkdown(markdown);
    const alignment = alignMessageToProjection(root, projected);
    expect(alignment).not.toBeNull();
    const [range] = findLiteralRanges(projected, 'E=mc^2');
    const domRange = rangeForProjectionRange(alignment!.spans, range!)!.range;
    // Atomic anchor: the RANGE selects the visible element, not a Text node
    // inside the hidden MathML annotation.
    expect(domRange.startContainer.nodeType).toBe(Node.ELEMENT_NODE);
    expect(root.querySelector('.katex')).not.toBeNull();
    expect(domRange.toString()).toContain('E=mc^2');
  });

  it('image alt: the indexed alt maps to the visible <img> element as an atomic anchor', () => {
    const markdown = 'before ![architecture diagram](https://example.com/a.png) after';
    const projected = projectSearchText(markdown);
    const root = renderMarkdown(markdown);
    const alignment = alignMessageToProjection(root, projected);
    expect(alignment).not.toBeNull();
    const [range] = findLiteralRanges(projected, 'architecture');
    const domRange = rangeForProjectionRange(alignment!.spans, range!)!.range;
    expect(domRange.startContainer.nodeType).toBe(Node.ELEMENT_NODE);
    const img = root.querySelector('img')!;
    expect(domRange.intersectsNode(img)).toBe(true);
  });

  it('composer reference chips: the visible label maps at the exact projected offset', () => {
    const document: ComposerDocument = {
      version: 1,
      segments: [
        { type: 'text', text: 'deploy with ' },
        { type: 'reference', id: 'ref-1', referenceType: 'context', label: 'release-plan.md', kind: 'file' },
        { type: 'text', text: ' tonight' },
      ],
    };
    const projected = projectComposerSearchText(document);
    expect(projected).not.toContain('"release-plan.md"');
    const root = renderDocument(document);
    const alignment = alignMessageToProjection(root, projected);
    expect(alignment).not.toBeNull();
    const [range] = findLiteralRanges(projected, 'release-plan');
    const domRange = rangeForProjectionRange(alignment!.spans, range!)!.range;
    expect(domRange.toString()).toBe('release-plan');
    // The hit sits inside the chip label, not the surrounding prose.
    expect((domRange.startContainer as Element).parentElement?.classList.contains('mir-label')).toBe(true);
  });

  it('a reference-only message with the composer caret space maps the label', () => {
    const document: ComposerDocument = {
      version: 1,
      segments: [reference('ref-image', 'image1'), { type: 'text', text: ' ' }],
    };
    const projected = projectComposerSearchText(document);
    expect(projected).toBe('image1');
    const root = renderUserDocument(document);
    const domRange = labelRange(root, projected, 'image');
    expect(domRange.toString()).toBe('image');
    expect((domRange.startContainer as Text).data).toBe('image1');
    expect(domRange.startOffset).toBe(0);
    expect(domRange.endOffset).toBe('image'.length);
    expect((domRange.endContainer as Text).parentElement?.classList.contains('mir-label')).toBe(true);
    const texts: string[] = [];
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node.textContent ?? '');
    expect(texts).toContain(' ');
  });

  it('leading and trailing whitespace slots do not shift the reference label', () => {
    const document: ComposerDocument = {
      version: 1,
      segments: [
        { type: 'text', text: '  \t' },
        reference('ref-image', 'image1'),
        { type: 'text', text: ' ' },
      ],
    };
    const projected = projectComposerSearchText(document);
    expect(projected).toBe('image1');
    const domRange = labelRange(renderUserDocument(document), projected, 'image');
    expect(domRange.toString()).toBe('image');
    expect((domRange.startContainer as Text).data).toBe('image1');
    expect((domRange.startContainer as Text).parentElement?.classList.contains('mir-label')).toBe(true);
  });

  it('a reference mixed with prose highlights the label and the prose separately', () => {
    const document: ComposerDocument = {
      version: 1,
      segments: [
        reference('ref-image', 'image1'),
        { type: 'text', text: ' ffffff' },
      ],
    };
    const projected = projectComposerSearchText(document);
    expect(projected).toBe('image1 ffffff');
    const root = renderUserDocument(document);
    const label = labelRange(root, projected, 'image');
    expect((label.startContainer as Text).parentElement?.classList.contains('mir-label')).toBe(true);
    const prose = labelRange(root, projected, 'ffffff');
    expect(prose.toString()).toBe('ffffff');
    expect((prose.startContainer as Text).parentElement?.closest('.mir-label')).toBeNull();
  });

  it('a reference with no boundary whitespace still maps onto its label', () => {
    const document: ComposerDocument = {
      version: 1,
      segments: [reference('ref-image', 'image1')],
    };
    const projected = projectComposerSearchText(document);
    expect(projected).toBe('image1');
    const domRange = labelRange(renderUserDocument(document), projected, 'image');
    expect(domRange.toString()).toBe('image');
    expect((domRange.startContainer as Text).parentElement?.classList.contains('mir-label')).toBe(true);
  });

  it('trimmed prose around a reference keeps the interior label offset', () => {
    const document: ComposerDocument = {
      version: 1,
      segments: [
        { type: 'text', text: 'before ' },
        reference('ref-image', 'image1'),
        { type: 'text', text: ' after ' },
      ],
    };
    const projected = projectComposerSearchText(document);
    expect(projected).toBe('before image1 after');
    const domRange = labelRange(renderUserDocument(document), projected, 'image');
    expect(domRange.toString()).toBe('image');
    expect((domRange.startContainer as Text).parentElement?.classList.contains('mir-label')).toBe(true);
  });

  it('maps leading spaces and a collapsed newline run to the raw text-node offsets', () => {
    const raw = '  alpha\n\n\n\nbeta  ';
    const { container } = render(
      <div
        className="msg-text"
        data-transcript-selectable="true"
        data-transcript-source-id="1:assistant:m-raw"
        data-transcript-source-kind="assistant"
      >
        <p>{raw}</p>
      </div>,
    );
    const root = container.firstElementChild as HTMLElement;
    const projected = 'alpha\n\nbeta';
    const alignment = alignMessageToProjection(root, projected);
    expect(alignment).not.toBeNull();
    const text = root.querySelector('p')?.firstChild;
    expect(text).toBeInstanceOf(Text);
    expect((text as Text).data).toBe(raw);
    const alpha = findLiteralRanges(projected, 'alpha')[0]!;
    const beta = findLiteralRanges(projected, 'beta')[0]!;
    const alphaRange = rangeForProjectionRange(alignment!.spans, alpha)!.range;
    const betaRange = rangeForProjectionRange(alignment!.spans, beta)!.range;
    expect(alphaRange.startContainer).toBe(text);
    expect(alphaRange.startOffset).toBe(2);
    expect(alphaRange.endOffset).toBe(7);
    expect(alphaRange.toString()).toBe('alpha');
    expect(betaRange.startContainer).toBe(text);
    expect(betaRange.startOffset).toBe(11);
    expect(betaRange.endOffset).toBe(15);
    expect(betaRange.toString()).toBe('beta');

    const hello = '  hello';
    const helloView = render(
      <div className="msg-text" data-transcript-selectable="true">
        <p>{hello}</p>
      </div>,
    );
    const helloRoot = helloView.container.firstElementChild as HTMLElement;
    const helloAlignment = alignMessageToProjection(helloRoot, 'hello');
    expect(helloAlignment).not.toBeNull();
    const helloText = helloRoot.querySelector('p')?.firstChild as Text;
    expect(helloText.data).toBe(hello);
    const helloRange = rangeForProjectionRange(
      helloAlignment!.spans,
      findLiteralRanges('hello', 'hello')[0]!,
    )!.range;
    expect(helloRange.startContainer).toBe(helloText);
    expect(helloRange.startOffset).toBe(2);
    expect(helloRange.toString()).toBe('hello');
  });

  it('maps prose around math and images and rejects a range that crosses an atomic span', () => {
    const markdown = 'energy is $E=mc^2$ exactly';
    const projected = projectSearchText(markdown);
    const root = renderMarkdown(markdown);
    const alignment = alignMessageToProjection(root, projected);
    expect(alignment).not.toBeNull();
    const energy = findLiteralRanges(projected, 'energy')[0]!;
    const exactly = findLiteralRanges(projected, 'exactly')[0]!;
    const formula = findLiteralRanges(projected, 'E=mc^2')[0]!;
    const energyRange = rangeForProjectionRange(alignment!.spans, energy)!;
    const exactlyRange = rangeForProjectionRange(alignment!.spans, exactly)!;
    expect(energyRange.atomicElement).toBeUndefined();
    expect(energyRange.range.toString()).toBe('energy');
    expect(exactlyRange.atomicElement).toBeUndefined();
    expect(exactlyRange.range.toString()).toBe('exactly');
    const wholeFormula = rangeForProjectionRange(alignment!.spans, formula)!;
    expect(wholeFormula.atomicElement).toBe(root.querySelector('.katex'));
    expect(rangeForProjectionRange(alignment!.spans, { start: formula.start - 1, end: formula.end })).toBeNull();
    expect(rangeForProjectionRange(alignment!.spans, { start: formula.start, end: formula.end + 1 })).toBeNull();

    const imageMarkdown = 'before ![architecture diagram](https://example.com/a.png) after';
    const imageProjected = projectSearchText(imageMarkdown);
    const imageRoot = renderMarkdown(imageMarkdown);
    const imageAlignment = alignMessageToProjection(imageRoot, imageProjected);
    expect(imageAlignment).not.toBeNull();
    const before = findLiteralRanges(imageProjected, 'before')[0]!;
    const after = findLiteralRanges(imageProjected, 'after')[0]!;
    const alt = findLiteralRanges(imageProjected, 'architecture')[0]!;
    const beforeRange = rangeForProjectionRange(imageAlignment!.spans, before)!;
    const afterRange = rangeForProjectionRange(imageAlignment!.spans, after)!;
    expect(beforeRange.atomicElement).toBeUndefined();
    expect(beforeRange.range.toString()).toBe('before');
    expect(afterRange.atomicElement).toBeUndefined();
    expect(afterRange.range.toString()).toBe('after');
    const wholeImage = rangeForProjectionRange(imageAlignment!.spans, alt)!;
    expect(wholeImage.atomicElement).toBe(imageRoot.querySelector('img'));
    expect(rangeForProjectionRange(imageAlignment!.spans, { start: before.end - 1, end: alt.end })).toBeNull();
    expect(rangeForProjectionRange(imageAlignment!.spans, { start: alt.start, end: after.start + 1 })).toBeNull();
  });

  it('a mismatching message fails alignment instead of mapping a guess', () => {
    const root = renderMarkdown('the actual text');
    expect(alignMessageToProjection(root, 'different text')).toBeNull();
  });

  it('copy buttons are never part of the alignment text', () => {
    const markdown = '```ts\nrun deploy\n```';
    const projected = projectSearchText(markdown);
    const alignment = alignMessageToProjection(renderMarkdown(markdown), projected);
    expect(alignment).not.toBeNull();
    expect(mappedTexts(renderMarkdown(markdown), projected, 'run deploy')).toEqual(['run deploy']);
  });
});
