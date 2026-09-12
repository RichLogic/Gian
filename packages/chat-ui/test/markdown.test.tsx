// chat-ui markdown: GFM rendering, fenced-code copy button, and the safe
// link contract — external links and file references only travel through the
// app-provided callbacks; the package never opens a URL by itself.

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { MarkdownText, FileLink } from '../src/markdown.js';
import {
  BrowserLinkOpenContext,
  FileLinkHrefContext,
  FileLinkOpenContext,
  RelativeLinkOpenContext,
} from '../src/contexts.js';

describe('MarkdownText', () => {
  it('renders GFM tables and inline code', () => {
    const { container } = render(
      <MarkdownText>{'| a | b |\n| --- | --- |\n| 1 | 2 |\n\nuse `foo()` here'}</MarkdownText>,
    );
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelector('code')?.textContent).toBe('foo()');
  });

  it('repairs a glued list/table and still renders the table', () => {
    const { container } = render(
      <MarkdownText>{'- item\n| a |\n| --- |\n| 1 |'}</MarkdownText>,
    );
    expect(container.querySelector('table')).not.toBeNull();
  });

  it('wraps a fenced block with a copy button (trailing newline trimmed)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { container } = render(<MarkdownText>{'```js\nconst x = 1;\n```'}</MarkdownText>);
    const btn = container.querySelector('.code-block .code-copy');
    expect(btn).not.toBeNull();
    fireEvent.click(btn!);
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('const x = 1;'));
  });

  it('routes external links through the app callback instead of navigating', () => {
    const openBrowser = vi.fn();
    const { container } = render(
      <BrowserLinkOpenContext.Provider value={openBrowser}>
        <MarkdownText>{'[site](https://example.com)'}</MarkdownText>
      </BrowserLinkOpenContext.Provider>,
    );
    const link = container.querySelector('a')!;
    expect(link.getAttribute('target')).toBeNull(); // in-app routing: no _blank
    expect(fireEvent.click(link)).toBe(false);
    expect(openBrowser).toHaveBeenCalledWith('https://example.com');
  });

  it('opens external links in a new tab when no browser callback is mounted', () => {
    const { container } = render(<MarkdownText>{'[site](https://example.com)'}</MarkdownText>);
    const link = container.querySelector('a')!;
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('swallows unresolved relative links so the SPA never navigates', () => {
    const { container } = render(<MarkdownText>{'[missing](./missing.md)'}</MarkdownText>);
    const link = container.querySelector('a')!;
    expect(fireEvent.click(link)).toBe(false);
  });

  it('routes unresolved relative links to the click-time fallback when mounted', () => {
    const openRelative = vi.fn();
    const { container } = render(
      <RelativeLinkOpenContext.Provider value={openRelative}>
        <MarkdownText>{'[missing](./missing.md)'}</MarkdownText>
      </RelativeLinkOpenContext.Provider>,
    );
    expect(fireEvent.click(container.querySelector('a')!)).toBe(false);
    expect(openRelative).toHaveBeenCalledWith('./missing.md');
  });
});

describe('FileLink', () => {
  it('routes clicks through the app open callback, never a synthesized URL', () => {
    const open = vi.fn();
    const { container } = render(
      <FileLinkOpenContext.Provider value={open}>
        <FileLink path="/repo/src/a.ts" line={12} />
      </FileLinkOpenContext.Provider>,
    );
    const link = container.querySelector('a.file-link')!;
    expect(fireEvent.click(link)).toBe(false);
    expect(open).toHaveBeenCalledWith('/repo/src/a.ts', 12);
  });

  it('never fabricates an editor-scheme href by itself', () => {
    const { container } = render(<FileLink path="/repo/src/a.ts" />);
    const link = container.querySelector('a.file-link')!;
    expect(link.getAttribute('href')).toBeNull();
    // Inert without a handler: the click is still prevented.
    expect(fireEvent.click(link)).toBe(false);
  });

  it('uses the app-supplied href factory when one is mounted', () => {
    const { container } = render(
      <FileLinkHrefContext.Provider value={(p, line) => `app://open${p}${line ? `:${line}` : ''}`}>
        <FileLink path="/repo/src/a.ts" line={3} />
      </FileLinkHrefContext.Provider>,
    );
    expect(container.querySelector('a.file-link')!.getAttribute('href')).toBe('app://open/repo/src/a.ts:3');
  });
});
