import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MarkdownText, FileRefRehypeContext, FileLinkOpenContext } from '../src/transcript/items.js';
import { buildFileRefIndex, makeFileLinkifyRehype } from '../src/transcript/linkify-files.js';

const index = buildFileRefIndex(['packages/web/src/App.tsx', 'README.md'], '/repo');
const rehype = makeFileLinkifyRehype(index, rel => `/repo/${rel}`);

function renderMd(text: string, onOpen = vi.fn()) {
  const r = render(
    <FileLinkOpenContext.Provider value={onOpen}>
      <FileRefRehypeContext.Provider value={rehype}>
        <MarkdownText>{text}</MarkdownText>
      </FileRefRehypeContext.Provider>
    </FileLinkOpenContext.Provider>,
  );
  return Object.assign(onOpen, { container: r.container });
}

describe('MarkdownText file linkification', () => {
  it('turns a known file mention into a clickable link and opens it at the line', () => {
    const onOpen = renderMd('See App.tsx (line 12) and README.md for details.');
    const link = screen.getByText('App.tsx (line 12)');
    expect(link.tagName).toBe('A');
    expect(link.className).toContain('file-link');
    fireEvent.click(link);
    expect(onOpen).toHaveBeenCalledWith('/repo/packages/web/src/App.tsx', 12);
  });

  it('links a second known file in the same text', () => {
    const onOpen = renderMd('See App.tsx (line 12) and README.md for details.');
    fireEvent.click(screen.getByText('README.md'));
    expect(onOpen).toHaveBeenCalledWith('/repo/README.md', undefined);
  });

  it('leaves unknown file-like tokens as plain text (no link)', () => {
    renderMd('The file nope.ts is not in the tree.');
    expect(screen.queryByText('nope.ts')).toBeNull(); // not its own element → no link
    // The surrounding paragraph still contains the literal text.
    expect(screen.getByText(/nope\.ts is not in the tree/)).toBeTruthy();
  });

  it('renders plain markdown unchanged when no rehype provider is mounted', () => {
    render(<MarkdownText>{'Just **bold** text, App.tsx here.'}</MarkdownText>);
    // No linkification without the context → App.tsx stays plain text.
    expect(screen.queryByText('App.tsx')).toBeNull();
    expect(screen.getByText(/App\.tsx here/)).toBeTruthy();
  });

  it('links an absolute path under the working-tree root', () => {
    const onOpen = renderMd('open /repo/packages/web/src/App.tsx:5 now');
    fireEvent.click(screen.getByText('/repo/packages/web/src/App.tsx:5'));
    expect(onOpen).toHaveBeenCalledWith('/repo/packages/web/src/App.tsx', 5);
  });

  it('linkifies a file name inside INLINE code (intentional — files are often in backticks)', () => {
    const onOpen = renderMd('edit `App.tsx` then run');
    const link = onOpen.container.querySelector('code a');
    expect(link).toBeTruthy();
    expect(link!.textContent).toBe('App.tsx');
  });

  it('does NOT linkify inside a fenced code block (code stays literal)', () => {
    const onOpen = renderMd('```\nedit App.tsx now\n```');
    expect(onOpen.container.querySelector('pre a')).toBeNull();
    expect(onOpen.container.querySelector('a')).toBeNull();
  });
});

describe('MarkdownText fenced code block copy button', () => {
  it('wraps a fenced block and copies its source (trailing newline trimmed)', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const onOpen = renderMd('```js\nconst x = 1;\nconsole.log(x);\n```');
    const block = onOpen.container.querySelector('.code-block');
    expect(block).toBeTruthy();
    const btn = block!.querySelector('.code-copy');
    expect(btn).toBeTruthy();
    fireEvent.click(btn!);
    expect(writeText).toHaveBeenCalledWith('const x = 1;\nconsole.log(x);');
  });

  it('does not add the copy button to inline code', () => {
    const onOpen = renderMd('use `foo()` inline here');
    expect(onOpen.container.querySelector('.code-block')).toBeNull();
    expect(onOpen.container.querySelector('.code-copy')).toBeNull();
  });
});
