import { createRef } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  $createRangeSelection,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  KEY_MODIFIER_COMMAND,
  SELECTION_CHANGE_COMMAND,
  type LexicalEditor,
} from 'lexical';

import {
  InlineComposerEditor,
  type InlineComposerEditorHandle,
} from '../src/components/composer/InlineComposerEditor.js';

const rangeRect = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect');
const selectionRect = () => ({
  x: 80, y: 100, left: 80, top: 100, right: 240, bottom: 122, width: 160, height: 22,
  toJSON: () => ({}),
} as DOMRect);

beforeAll(() => {
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: selectionRect,
  });
});

afterAll(() => {
  if (rangeRect) Object.defineProperty(Range.prototype, 'getBoundingClientRect', rangeRect);
  else Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
  window.getSelection()?.removeAllRanges();
});

function renderedEditor(): LexicalEditor {
  const root = screen.getByRole('textbox');
  const editor = (root as HTMLElement & { __lexicalEditor?: LexicalEditor }).__lexicalEditor;
  if (!editor) throw new Error('expected lexical editor on contenteditable');
  return editor;
}

function renderComposer(text: string, onChange = vi.fn()) {
  const handle = createRef<InlineComposerEditorHandle>();
  render(
    <InlineComposerEditor
      ref={handle}
      initialDocument={{ version: 1, segments: text ? [{ type: 'text' as const, text }] : [] }}
      placeholder="Message"
      onChange={onChange}
    />,
  );
  return { handle, onChange };
}

function lastUserText(onChange: ReturnType<typeof vi.fn>): string {
  return onChange.mock.calls.at(-1)?.[1];
}

// Selects every text node of the first block, mirroring a native drag
// selection: the Lexical range (text-point anchored so block detection works
// inside lists/quotes/links) plus a jsdom native range anchored on the root
// ELEMENT, which survives the DOM reconciliation that format toggles cause.
function selectWholeFirstBlock(editor: LexicalEditor): void {
  const rootElement = editor.getRootElement();
  if (!rootElement) throw new Error('expected a root element');
  act(() => {
    editor.update(() => {
      const textNodes = $getRoot().getAllTextNodes();
      const first = textNodes[0];
      const last = textNodes[textNodes.length - 1];
      if (!first || !last) throw new Error('expected text content');
      const selection = $createRangeSelection();
      selection.anchor.set(first.getKey(), 0, 'text');
      selection.focus.set(last.getKey(), last.getTextContentSize(), 'text');
      // Native selectionchange syncs selection.format from the anchor text
      // node; replay it so format toggles pick the right direction.
      selection.setFormat(first.getFormat());
      $setSelection(selection);
    }, { discrete: true });
    const range = document.createRange();
    range.selectNodeContents(rootElement);
    const native = window.getSelection()!;
    native.removeAllRanges();
    native.addRange(range);
    editor.dispatchCommand(SELECTION_CHANGE_COMMAND, undefined);
  });
}

function collapseSelection(editor: LexicalEditor): void {
  act(() => {
    editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) throw new Error('expected a range selection');
      const node = selection.anchor.getNode();
      if (!$isTextNode(node)) throw new Error('expected a text anchor');
      node.select(1, 1);
    }, { discrete: true });
    editor.dispatchCommand(SELECTION_CHANGE_COMMAND, undefined);
  });
}

describe('composer format toolbar visibility', () => {
  it('appears above a non-collapsed selection and hides on collapse, Escape, and outside pointerdown', async () => {
    renderComposer('selectable words');
    const editor = renderedEditor();
    expect(screen.queryByTestId('composer-format-toolbar')).toBeNull();

    selectWholeFirstBlock(editor);
    const toolbar = await screen.findByTestId('composer-format-toolbar');
    expect(toolbar.className).toContain('is-above');
    expect(toolbar.getAttribute('role')).toBe('toolbar');

    collapseSelection(editor);
    expect(screen.queryByTestId('composer-format-toolbar')).toBeNull();

    selectWholeFirstBlock(editor);
    await screen.findByTestId('composer-format-toolbar');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('composer-format-toolbar')).toBeNull();

    selectWholeFirstBlock(editor);
    await screen.findByTestId('composer-format-toolbar');
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId('composer-format-toolbar')).toBeNull();
  });

  it('hides when the native selection leaves the editor even while the Lexical range persists', async () => {
    renderComposer('selectable words');
    const editor = renderedEditor();
    selectWholeFirstBlock(editor);
    await screen.findByTestId('composer-format-toolbar');

    act(() => {
      window.getSelection()?.removeAllRanges();
      editor.dispatchCommand(SELECTION_CHANGE_COMMAND, undefined);
    });
    expect(screen.queryByTestId('composer-format-toolbar')).toBeNull();
  });
});

describe('composer format toolbar inline toggles', () => {
  const INLINE_TOGGLES: Array<[string, string, string]> = [
    ['bold', 'composer-format-bold', '**hello**'],
    ['italic', 'composer-format-italic', '*hello*'],
    ['strikethrough', 'composer-format-strikethrough', '~~hello~~'],
    ['inline code', 'composer-format-inline-code', '`hello`'],
  ];

  it.each(INLINE_TOGGLES)(
    '%s button toggles its markdown marker and pressed state',
    async (_name, testId, expectedMarkdown) => {
      const { onChange } = renderComposer('hello');
      const editor = renderedEditor();
      selectWholeFirstBlock(editor);

      const button = await screen.findByTestId(testId);
      expect(button).toHaveAttribute('aria-pressed', 'false');
      fireEvent.click(button);
      await waitFor(() => expect(lastUserText(onChange)).toBe(expectedMarkdown));
      expect(screen.getByTestId(testId)).toHaveAttribute('aria-pressed', 'true');

      selectWholeFirstBlock(editor);
      fireEvent.click(screen.getByTestId(testId));
      await waitFor(() => expect(lastUserText(onChange)).toBe('hello'));
      expect(screen.getByTestId(testId)).toHaveAttribute('aria-pressed', 'false');
    },
  );

  it('shows the bold button pressed when the selection is already bold', async () => {
    renderComposer('**hello**');
    const editor = renderedEditor();
    selectWholeFirstBlock(editor);
    expect(await screen.findByTestId('composer-format-bold')).toHaveAttribute('aria-pressed', 'true');
  });

  it('round-trips strikethrough markdown through draft write and export', async () => {
    const handle = createRef<InlineComposerEditorHandle>();
    const onChange = vi.fn();
    render(
      <InlineComposerEditor
        ref={handle}
        initialDocument={{ version: 1, segments: [] }}
        placeholder="Message"
        onChange={onChange}
      />,
    );
    await waitFor(() => expect(handle.current).not.toBeNull());
    act(() => handle.current?.setDocument({ version: 1, segments: [{ type: 'text', text: '~~gone~~' }] }));
    await waitFor(() => expect(lastUserText(onChange)).toBe('~~gone~~'));
    expect(screen.getByRole('textbox').querySelector('.composer-md-strikethrough'))
      .toHaveTextContent(/^gone$/);
  });
});

describe('composer format toolbar link', () => {
  it('opens a URL input, applies the link on Enter, and removes it on a second click', async () => {
    const { onChange } = renderComposer('click here');
    const editor = renderedEditor();
    selectWholeFirstBlock(editor);

    fireEvent.click(await screen.findByTestId('composer-format-link'));
    const input = await screen.findByTestId('composer-format-link-input');
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: 'https://example.com' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(lastUserText(onChange)).toBe('[click here](https://example.com)'));
    expect(screen.queryByTestId('composer-format-link-input')).toBeNull();
    expect(screen.getByTestId('composer-format-link')).toHaveAttribute('aria-pressed', 'true');

    selectWholeFirstBlock(editor);
    fireEvent.click(screen.getByTestId('composer-format-link'));
    await waitFor(() => expect(lastUserText(onChange)).toBe('click here'));
  });

  it('Escape in the URL input cancels back to the toolbar without linking', async () => {
    const { onChange } = renderComposer('click here');
    const editor = renderedEditor();
    selectWholeFirstBlock(editor);
    fireEvent.click(await screen.findByTestId('composer-format-link'));

    const input = await screen.findByTestId('composer-format-link-input');
    fireEvent.change(input, { target: { value: 'https://example.com' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByTestId('composer-format-link-input')).toBeNull();
    expect(screen.getByTestId('composer-format-bold')).toBeTruthy();
    expect(lastUserText(onChange)).not.toBe('[click here](https://example.com)');
    expect(screen.getByRole('textbox').querySelector('a')).toBeNull();
  });
});

describe('composer format toolbar block toggles', () => {
  it('bullet list button wraps the block and toggles back', async () => {
    const { onChange } = renderComposer('hello');
    const editor = renderedEditor();
    selectWholeFirstBlock(editor);
    fireEvent.click(await screen.findByTestId('composer-format-bullet-list'));
    await waitFor(() => expect(lastUserText(onChange)).toBe('- hello'));
    expect(screen.getByTestId('composer-format-bullet-list')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('textbox').querySelector('ul li')).toHaveTextContent(/^hello$/);

    selectWholeFirstBlock(editor);
    fireEvent.click(screen.getByTestId('composer-format-bullet-list'));
    await waitFor(() => expect(lastUserText(onChange)).toBe('hello'));
  });

  it('ordered list button wraps the block and toggles back', async () => {
    const { onChange } = renderComposer('hello');
    const editor = renderedEditor();
    selectWholeFirstBlock(editor);
    fireEvent.click(await screen.findByTestId('composer-format-ordered-list'));
    await waitFor(() => expect(lastUserText(onChange)).toBe('1. hello'));
    expect(screen.getByRole('textbox').querySelector('ol li')).toHaveTextContent(/^hello$/);

    selectWholeFirstBlock(editor);
    fireEvent.click(screen.getByTestId('composer-format-ordered-list'));
    await waitFor(() => expect(lastUserText(onChange)).toBe('hello'));
  });

  it('quote button wraps the block and toggles back to a paragraph', async () => {
    const { onChange } = renderComposer('hello');
    const editor = renderedEditor();
    selectWholeFirstBlock(editor);
    fireEvent.click(await screen.findByTestId('composer-format-quote'));
    await waitFor(() => expect(lastUserText(onChange)).toBe('> hello'));
    expect(screen.getByTestId('composer-format-quote')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('textbox').querySelector('blockquote')).toHaveTextContent(/^hello$/);

    selectWholeFirstBlock(editor);
    fireEvent.click(screen.getByTestId('composer-format-quote'));
    await waitFor(() => expect(lastUserText(onChange)).toBe('hello'));
    expect(screen.getByTestId('composer-format-quote')).toHaveAttribute('aria-pressed', 'false');
  });

  it('code block button fences the block and toggles back to a paragraph', async () => {
    const { onChange } = renderComposer('hello');
    const editor = renderedEditor();
    selectWholeFirstBlock(editor);
    fireEvent.click(await screen.findByTestId('composer-format-code-block'));
    await waitFor(() => expect(lastUserText(onChange)).toBe('```\nhello\n```'));
    expect(screen.getByRole('textbox').querySelector('code.composer-md-codeblock'))
      .toHaveTextContent(/^hello$/);

    selectWholeFirstBlock(editor);
    fireEvent.click(screen.getByTestId('composer-format-code-block'));
    await waitFor(() => expect(lastUserText(onChange)).toBe('hello'));
  });
});

describe('composer format toolbar clear formatting', () => {
  it('strips mixed inline formats down to plain text', async () => {
    const handle = createRef<InlineComposerEditorHandle>();
    const onChange = vi.fn();
    render(
      <InlineComposerEditor
        ref={handle}
        initialDocument={{ version: 1, segments: [] }}
        placeholder="Message"
        onChange={onChange}
      />,
    );
    await waitFor(() => expect(handle.current).not.toBeNull());
    act(() => handle.current?.setDocument({
      version: 1,
      segments: [{ type: 'text', text: '**bold** and *italic* and ~~strike~~ and `code`' }],
    }));
    await waitFor(() => expect(lastUserText(onChange)).toBe('**bold** and *italic* and ~~strike~~ and `code`'));

    const editor = renderedEditor();
    selectWholeFirstBlock(editor);
    fireEvent.click(await screen.findByTestId('composer-format-clear'));
    await waitFor(() => expect(lastUserText(onChange)).toBe('bold and italic and strike and code'));
  });
});

describe('composer format shortcuts', () => {
  const SHORTCUTS: Array<[string, KeyboardEventInit, string]> = [
    ['bold', { key: 'b', metaKey: true }, '**hello**'],
    ['italic', { key: 'i', metaKey: true }, '*hello*'],
    ['inline code', { key: 'e', metaKey: true }, '`hello`'],
    ['strikethrough', { key: 'X', metaKey: true, shiftKey: true }, '~~hello~~'],
  ];

  it.each(SHORTCUTS)('modifier shortcut toggles %s', async (_name, init, expectedMarkdown) => {
    const { onChange } = renderComposer('hello');
    const editor = renderedEditor();
    selectWholeFirstBlock(editor);

    let handled = false;
    act(() => {
      handled = editor.dispatchCommand(
        KEY_MODIFIER_COMMAND,
        new KeyboardEvent('keydown', { ...init, cancelable: true }),
      );
    });
    expect(handled).toBe(true);
    await waitFor(() => expect(lastUserText(onChange)).toBe(expectedMarkdown));

    selectWholeFirstBlock(editor);
    act(() => {
      editor.dispatchCommand(
        KEY_MODIFIER_COMMAND,
        new KeyboardEvent('keydown', { ...init, cancelable: true }),
      );
    });
    await waitFor(() => expect(lastUserText(onChange)).toBe('hello'));
  });

  it('leaves unmodified, unbound, composing, and ⌘Enter keys to their owners', () => {
    renderComposer('hello');
    const editor = renderedEditor();
    selectWholeFirstBlock(editor);

    const composing = new KeyboardEvent('keydown', { key: 'b', metaKey: true, cancelable: true });
    Object.defineProperty(composing, 'isComposing', { value: true });
    const cases: KeyboardEvent[] = [
      new KeyboardEvent('keydown', { key: 'b', cancelable: true }),
      new KeyboardEvent('keydown', { key: 'k', metaKey: true, cancelable: true }),
      new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, cancelable: true }),
      composing,
    ];
    for (const event of cases) {
      let handled = true;
      act(() => {
        handled = editor.dispatchCommand(KEY_MODIFIER_COMMAND, event);
      });
      expect(handled).toBe(false);
    }
  });
});
