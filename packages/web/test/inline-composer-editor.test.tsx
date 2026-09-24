import { readFileSync } from 'node:fs';
import { createRef } from 'react';
import type { ComposerDocument } from '@gian/shared';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  $createRangeSelection,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  COPY_COMMAND,
  CUT_COMMAND,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  PASTE_COMMAND,
  SELECTION_CHANGE_COMMAND,
  type LexicalEditor,
  type LexicalNode,
  type TextNode,
  UNDO_COMMAND,
} from 'lexical';

import {
  InlineComposerEditor,
  type ComposerFileReference,
  type InlineComposerEditorHandle,
} from '../src/components/composer/InlineComposerEditor.js';
import type { ComposerFileOption } from '../src/components/composer/capabilities.js';
import {
  UPWARD_POPOVER_GAP,
  UPWARD_POPOVER_MARGIN,
  UPWARD_POPOVER_MIN_HEIGHT,
} from '../src/components/composer/upward-popover.js';

const rangeRect = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect');
const textRect = Object.getOwnPropertyDescriptor(Text.prototype, 'getBoundingClientRect');
const zeroRect = () => ({
  x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0,
  toJSON: () => ({}),
} as DOMRect);

class TestClipboardData {
  private values = new Map<string, string>();

  getData(type: string): string {
    return this.values.get(type) ?? '';
  }

  setData(type: string, value: string): void {
    this.values.set(type, value);
  }
}

function clipboardEvent(type: 'copy' | 'cut' | 'paste', data: TestClipboardData): ClipboardEvent {
  const event = new ClipboardEvent(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { configurable: true, value: data });
  return event;
}

function selectWholeDocument(editor: LexicalEditor): void {
  editor.update(() => {
    const paragraph = $getRoot().getFirstChild();
    if (!$isElementNode(paragraph)) throw new Error('expected paragraph');
    const first = paragraph.getFirstChild();
    const last = paragraph.getLastChild();
    if (!$isTextNode(first) || !$isTextNode(last)) throw new Error('expected boundary text');
    const selection = $createRangeSelection();
    selection.anchor.set(first.getKey(), 0, 'text');
    selection.focus.set(last.getKey(), last.getTextContentSize(), 'text');
    $setSelection(selection);
  }, { discrete: true });
}

beforeAll(() => {
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: zeroRect });
  Object.defineProperty(Text.prototype, 'getBoundingClientRect', { configurable: true, value: zeroRect });
});

afterAll(() => {
  if (rangeRect) Object.defineProperty(Range.prototype, 'getBoundingClientRect', rangeRect);
  else Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
  if (textRect) Object.defineProperty(Text.prototype, 'getBoundingClientRect', textRect);
  else Reflect.deleteProperty(Text.prototype, 'getBoundingClientRect');
});

describe('InlineComposerEditor', () => {
  it('scopes its absolute placeholder to the editor instead of an outer composer row', () => {
    render(
      <div className="composer-input-wrap">
        <input aria-label="Title" />
        <InlineComposerEditor
          initialDocument={{ version: 1, segments: [] }}
          placeholder="Message"
          onChange={() => {}}
        />
      </div>,
    );

    const title = screen.getByRole('textbox', { name: 'Title' });
    const editor = screen.getByRole('textbox', { name: 'Message' });
    const editorFrame = editor.closest('.composer-rich-wrap');
    expect(editorFrame).not.toBeNull();
    expect(editorFrame).not.toContainElement(title);
    expect(editorFrame?.parentElement).toContainElement(title);
    expect(editorFrame?.querySelector('.composer-rich-placeholder')).toHaveTextContent('Message');

    const css = readFileSync('src/styles/gian-v2.css', 'utf8');
    const anchorRule = css.match(/\.composer-rich-wrap\s*\{([^}]*)\}/);
    expect(anchorRule).not.toBeNull();
    expect(anchorRule![1]).toContain('position: relative');
  });

  it('inserts an atomic reference at the live caret and preserves surrounding text order', async () => {
    const handle = createRef<InlineComposerEditorHandle>();
    const onChange = vi.fn();
    render(
      <InlineComposerEditor
        ref={handle}
        initialDocument={{ version: 1, segments: [{ type: 'text', text: 'Review carefully' }] }}
        placeholder="Message"
        onChange={onChange}
      />,
    );
    const editor = screen.getByRole('textbox');
    await waitFor(() => expect(handle.current).not.toBeNull());
    const lexicalEditor = (editor as HTMLElement & { __lexicalEditor?: LexicalEditor }).__lexicalEditor;
    expect(lexicalEditor).toBeDefined();
    // Caret insertion is a focused interaction: focus the DOM root so the
    // editor treats the selection as a live caret.
    act(() => handle.current?.rootElement()?.focus());
    act(() => lexicalEditor?.update(() => {
      const textNode = $getRoot().getFirstDescendant();
      expect($isTextNode(textNode)).toBe(true);
      if ($isTextNode(textNode)) textNode.select(7, 7);
    }, { discrete: true }));
    act(() => handle.current?.insertReference({
      id: 'ctx-1',
      referenceType: 'context',
      label: 'selected quote',
    }));

    expect(editor).toHaveTextContent('Review selected quote carefully');
    expect(editor.querySelector('[data-reference-id="ctx-1"]')).not.toBeNull();
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith({
      version: 1,
      segments: [
        { type: 'text', text: 'Review ' },
        { type: 'reference', id: 'ctx-1', referenceType: 'context', label: 'selected quote' },
        { type: 'text', text: ' carefully' },
      ],
    }, 'Review  carefully'));
  });

  it('Backspace removes a reference as one atomic node and undo restores it', async () => {
    const handle = createRef<InlineComposerEditorHandle>();
    const onChange = vi.fn();
    render(
      <InlineComposerEditor
        ref={handle}
        initialDocument={{ version: 1, segments: [{ type: 'text', text: 'Before ' }] }}
        placeholder="Message"
        onChange={onChange}
      />,
    );
    const editor = screen.getByRole('textbox');
    await waitFor(() => expect(handle.current).not.toBeNull());
    act(() => handle.current?.insertReference({
      id: 'file-1',
      referenceType: 'attachment',
      label: 'notes.md',
    }));
    expect(editor.querySelector('[data-reference-id="file-1"]')).not.toBeNull();
    // Selection only persists while the editor is focused (jsdom blur drops it).
    act(() => handle.current?.focus());

    // Two-step delete (2026-08-27): the first Backspace splices the trailing
    // space and SELECTS the chip (highlight); only the second press deletes.
    act(() => handle.current?.deleteBackward());
    await waitFor(() => expect(editor.querySelector('[data-reference-id="file-1"]')).toHaveClass('is-selected'));
    act(() => handle.current?.deleteBackward());
    await waitFor(() => expect(editor.querySelector('[data-reference-id="file-1"]')).toBeNull());
    expect(onChange.mock.calls.at(-1)?.[0].segments).toEqual([{ type: 'text', text: 'Before ' }]);

    const lexicalEditor = (editor as HTMLElement & { __lexicalEditor?: LexicalEditor }).__lexicalEditor;
    // Two undo steps: one for the chip deletion, one for the space splice.
    act(() => lexicalEditor?.dispatchCommand(UNDO_COMMAND, undefined));
    act(() => lexicalEditor?.dispatchCommand(UNDO_COMMAND, undefined));
    await waitFor(() => expect(editor.querySelector('[data-reference-id="file-1"]')).not.toBeNull());
    expect(onChange.mock.calls.at(-1)?.[0].segments).toEqual([
      { type: 'text', text: 'Before ' },
      { type: 'reference', id: 'file-1', referenceType: 'attachment', label: 'notes.md' },
      { type: 'text', text: ' ' },
    ]);
  });

  it('arrow keys move the caret off a selected reference chip', async () => {
    const handle = createRef<InlineComposerEditorHandle>();
    render(
      <InlineComposerEditor
        ref={handle}
        initialDocument={{ version: 1, segments: [{ type: 'text', text: 'Before ' }] }}
        placeholder="Message"
        onChange={() => {}}
      />,
    );
    const editor = screen.getByRole('textbox');
    await waitFor(() => expect(handle.current).not.toBeNull());
    act(() => handle.current?.insertReference({
      id: 'file-1',
      referenceType: 'attachment',
      label: 'notes.md',
    }));
    act(() => handle.current?.focus());
    const lexicalEditor = (editor as HTMLElement & { __lexicalEditor?: LexicalEditor }).__lexicalEditor;
    const chip = () => editor.querySelector('[data-reference-id="file-1"]');

    // First Backspace selects the chip…
    act(() => handle.current?.deleteBackward());
    await waitFor(() => expect(chip()).toHaveClass('is-selected'));

    // …and → collapses the caret past it instead of getting stuck.
    act(() => lexicalEditor?.dispatchCommand(
      KEY_ARROW_RIGHT_COMMAND,
      new KeyboardEvent('keydown', { key: 'ArrowRight' }),
    ));
    await waitFor(() => expect(chip()).not.toHaveClass('is-selected'));
    expect(chip()).not.toBeNull();
    lexicalEditor?.getEditorState().read(() => {
      const selection = $getSelection();
      expect($isRangeSelection(selection)).toBe(true);
      if (!$isRangeSelection(selection)) return;
      // Collapsed somewhere past the chip: either a paragraph-level caret or
      // inside the (possibly empty) text node that follows it.
      expect(selection.isCollapsed()).toBe(true);
      const anchorNode = selection.anchor.getNode();
      expect(anchorNode.getType()).not.toBe('composer-reference');
      if ($isTextNode(anchorNode)) {
        expect(anchorNode.getPreviousSibling()?.getType()).toBe('composer-reference');
      }
    });
  });

  it('restores a structured document and routes reference activation by id', async () => {
    const user = userEvent.setup();
    const handle = createRef<InlineComposerEditorHandle>();
    const onActivate = vi.fn();
    render(
      <InlineComposerEditor
        ref={handle}
        initialDocument={{
          version: 1,
          segments: [
            { type: 'reference', id: 'folder-1', referenceType: 'context', label: 'src' },
            { type: 'text', text: ' inspect this folder' },
          ],
        }}
        placeholder="Message"
        onChange={() => {}}
        onReferenceActivate={onActivate}
      />,
    );
    await user.click(screen.getByText('src'));
    expect(onActivate).toHaveBeenCalledWith('folder-1', 'context', expect.any(HTMLElement));

    act(() => handle.current?.setDocument({
      version: 1,
      segments: [{ type: 'text', text: 'replacement' }],
    }));
    expect(screen.getByRole('textbox')).toHaveTextContent('replacement');
  });

  it('copies and pastes selected references atomically inside the same editor', async () => {
    const onChange = vi.fn();
    render(
      <InlineComposerEditor
        initialDocument={{
          version: 1,
          segments: [
            { type: 'text', text: 'Before ' },
            { type: 'reference', id: 'folder-1', referenceType: 'context', label: 'src' },
            { type: 'text', text: ' after' },
          ],
        }}
        placeholder="Message"
        onChange={onChange}
      />,
    );
    const root = screen.getByRole('textbox');
    const editor = (root as HTMLElement & { __lexicalEditor?: LexicalEditor }).__lexicalEditor!;
    selectWholeDocument(editor);
    const clipboard = new TestClipboardData();
    act(() => editor.dispatchCommand(COPY_COMMAND, clipboardEvent('copy', clipboard)));
    expect(clipboard.getData('application/x-lexical-editor')).toContain('composer-reference');

    act(() => editor.update(() => $getRoot().selectEnd(), { discrete: true }));
    act(() => editor.dispatchCommand(PASTE_COMMAND, clipboardEvent('paste', clipboard)));

    await waitFor(() => expect(root.querySelectorAll('[data-reference-id="folder-1"]')).toHaveLength(2));
    const latestDocument = onChange.mock.calls.at(-1)?.[0];
    expect(latestDocument.segments.filter((segment: { type: string }) => segment.type === 'reference'))
      .toEqual([
        { type: 'reference', id: 'folder-1', referenceType: 'context', label: 'src' },
        { type: 'reference', id: 'folder-1', referenceType: 'context', label: 'src' },
      ]);
  });

  it('cuts an atomic reference selection and can paste it back', async () => {
    render(
      <InlineComposerEditor
        initialDocument={{
          version: 1,
          segments: [
            { type: 'text', text: 'Before ' },
            { type: 'reference', id: 'file-1', referenceType: 'attachment', label: 'notes.md' },
            { type: 'text', text: ' after' },
          ],
        }}
        placeholder="Message"
        onChange={() => {}}
      />,
    );
    const root = screen.getByRole('textbox');
    const editor = (root as HTMLElement & { __lexicalEditor?: LexicalEditor }).__lexicalEditor!;
    selectWholeDocument(editor);
    const clipboard = new TestClipboardData();
    act(() => editor.dispatchCommand(CUT_COMMAND, clipboardEvent('cut', clipboard)));
    await waitFor(() => expect(root.querySelector('[data-reference-id="file-1"]')).toBeNull());

    act(() => editor.dispatchCommand(PASTE_COMMAND, clipboardEvent('paste', clipboard)));
    await waitFor(() => expect(root.querySelector('[data-reference-id="file-1"]')).not.toBeNull());
  });

  it('falls back to label text when a reference is pasted into another Composer', async () => {
    render(
      <>
        <InlineComposerEditor
          initialDocument={{
            version: 1,
            segments: [
              { type: 'text', text: 'Use ' },
              { type: 'reference', id: 'folder-1', referenceType: 'context', label: 'src' },
              { type: 'text', text: ' now' },
            ],
          }}
          placeholder="Source"
          onChange={() => {}}
        />
        <InlineComposerEditor
          initialDocument={{ version: 1, segments: [] }}
          placeholder="Target"
          onChange={() => {}}
        />
      </>,
    );
    const [source, target] = screen.getAllByRole('textbox');
    const sourceEditor = (source as HTMLElement & { __lexicalEditor?: LexicalEditor }).__lexicalEditor!;
    const targetEditor = (target as HTMLElement & { __lexicalEditor?: LexicalEditor }).__lexicalEditor!;
    selectWholeDocument(sourceEditor);
    const clipboard = new TestClipboardData();
    act(() => sourceEditor.dispatchCommand(COPY_COMMAND, clipboardEvent('copy', clipboard)));
    act(() => targetEditor.update(() => $getRoot().selectEnd(), { discrete: true }));
    act(() => targetEditor.dispatchCommand(PASTE_COMMAND, clipboardEvent('paste', clipboard)));

    await waitFor(() => expect(target).toHaveTextContent('Use "src" now'));
    expect(target.querySelector('[data-reference-id]')).toBeNull();
  });
});

describe('InlineComposerEditor markdown', () => {
  const MARKDOWN_ROUND_TRIPS: Array<[string, string]> = [
    ['a heading', '# Title'],
    ['multi-level headings', '## Sub\n\n### Third'],
    ['bold, italic, and bold-italic', '**bold** and *italic* and ***both***'],
    ['inline code', 'run `pnpm test` now'],
    ['an unordered list', '- one\n- two'],
    ['an ordered list', '1. first\n2. second'],
    ['a blockquote', '> quoted\n> lines'],
    ['a code fence', '```ts\nconst x = 1;\n```'],
    ['separate paragraphs', 'first\n\nsecond'],
  ];

  function renderedEditor(): LexicalEditor {
    const root = screen.getByRole('textbox');
    const editor = (root as HTMLElement & { __lexicalEditor?: LexicalEditor }).__lexicalEditor;
    if (!editor) throw new Error('expected lexical editor on contenteditable');
    return editor;
  }

  function placeCaretAtDocumentEnd(editor: LexicalEditor): void {
    act(() => editor.update(() => {
      let node = $getRoot().getLastChild();
      while (node && $isElementNode(node) && node.getChildrenSize() > 0) {
        node = node.getLastChild();
      }
      if ($isTextNode(node)) node.selectEnd();
      else if ($isElementNode(node)) node.selectEnd();
    }, { discrete: true }));
  }

  function typeText(editor: LexicalEditor, text: string): void {
    act(() => editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) selection.insertText(text);
    }, { discrete: true }));
  }

  it.each(MARKDOWN_ROUND_TRIPS)('round-trips %s through draft write and export', async (_name, markdown) => {
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
    act(() => handle.current?.setDocument({ version: 1, segments: [{ type: 'text', text: markdown }] }));
    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toEqual({
      version: 1,
      segments: [{ type: 'text', text: markdown }],
    }));
  });

  it('restores markdown drafts into rich nodes', async () => {
    const handle = createRef<InlineComposerEditorHandle>();
    render(
      <InlineComposerEditor
        ref={handle}
        initialDocument={{ version: 1, segments: [] }}
        placeholder="Message"
        onChange={() => {}}
      />,
    );
    await waitFor(() => expect(handle.current).not.toBeNull());
    act(() => handle.current?.setDocument({
      version: 1,
      segments: [{ type: 'text', text: '# Title\n\n- one\n- two\n\n> note\n\n```js\ncode\n```' }],
    }));
    const editor = screen.getByRole('textbox');
    expect(editor.querySelector('h1')).toHaveTextContent('Title');
    expect(editor.querySelectorAll('ul li')).toHaveLength(2);
    expect(editor.querySelector('blockquote')).toHaveTextContent('note');
    expect(editor.querySelector('code.composer-md-codeblock')).toHaveTextContent('code');
  });

  it('keeps reference chips as segment boundaries inside markdown blocks', async () => {
    const handle = createRef<InlineComposerEditorHandle>();
    const onChange = vi.fn();
    const document = {
      version: 1 as const,
      segments: [
        { type: 'text' as const, text: '# Head\n\n- item ' },
        { type: 'reference' as const, id: 'ctx-1', referenceType: 'context' as const, label: 'src' },
        { type: 'text' as const, text: ' tail\n\n> quote' },
      ],
    };
    render(
      <InlineComposerEditor
        ref={handle}
        initialDocument={{ version: 1, segments: [] }}
        placeholder="Message"
        onChange={onChange}
      />,
    );
    await waitFor(() => expect(handle.current).not.toBeNull());
    act(() => handle.current?.setDocument(document));
    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toEqual(document));
    const editor = screen.getByRole('textbox');
    const chip = editor.querySelector('[data-reference-id="ctx-1"]');
    expect(chip).not.toBeNull();
    expect(chip?.closest('li')).not.toBeNull();
    expect(editor.querySelector('blockquote')).toHaveTextContent('quote');
  });

  it('restores a chip-leading draft into a fresh paragraph', async () => {
    const handle = createRef<InlineComposerEditorHandle>();
    const onChange = vi.fn();
    const document = {
      version: 1 as const,
      segments: [
        { type: 'reference' as const, id: 'file-1', referenceType: 'attachment' as const, label: 'notes.md' },
        { type: 'text' as const, text: ' check this' },
      ],
    };
    render(
      <InlineComposerEditor
        ref={handle}
        initialDocument={{ version: 1, segments: [] }}
        placeholder="Message"
        onChange={onChange}
      />,
    );
    await waitFor(() => expect(handle.current).not.toBeNull());
    act(() => handle.current?.setDocument(document));
    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toEqual(document));
    const editor = screen.getByRole('textbox');
    expect(editor.querySelector('[data-reference-id="file-1"]')).not.toBeNull();
    expect(editor).toHaveTextContent('notes.md check this');
  });

  it('Enter in a paragraph delegates to onKeyDown for submit', async () => {
    const onKeyDown = vi.fn(() => true);
    render(
      <InlineComposerEditor
        initialDocument={{ version: 1, segments: [{ type: 'text', text: 'hello' }] }}
        placeholder="Message"
        onChange={() => {}}
        onKeyDown={onKeyDown}
      />,
    );
    const editor = renderedEditor();
    placeCaretAtDocumentEnd(editor);
    act(() => editor.dispatchCommand(
      KEY_ENTER_COMMAND,
      new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }),
    ));
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    editor.getEditorState().read(() => {
      expect($getRoot().getChildrenSize()).toBe(1);
    });
  });

  it('Enter inside a list item submits instead of splitting', async () => {
    const onKeyDown = vi.fn(() => true);
    render(
      <InlineComposerEditor
        initialDocument={{ version: 1, segments: [{ type: 'text', text: '- one' }] }}
        placeholder="Message"
        onChange={() => {}}
        onKeyDown={onKeyDown}
      />,
    );
    const root = screen.getByRole('textbox');
    const editor = renderedEditor();
    placeCaretAtDocumentEnd(editor);
    act(() => editor.dispatchCommand(
      KEY_ENTER_COMMAND,
      new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }),
    ));
    // Enter ALWAYS sends (owner contract) — the list is not split.
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect(root.querySelectorAll('li')).toHaveLength(1);
  });

  it('Shift+Enter inside an ordered list creates the next numbered item', async () => {
    const onKeyDown = vi.fn(() => true);
    const onChange = vi.fn();
    render(
      <InlineComposerEditor
        initialDocument={{ version: 1, segments: [{ type: 'text', text: '1. first' }] }}
        placeholder="Message"
        onChange={onChange}
        onKeyDown={onKeyDown}
      />,
    );
    const root = screen.getByRole('textbox');
    const editor = renderedEditor();
    placeCaretAtDocumentEnd(editor);
    act(() => editor.dispatchCommand(
      KEY_ENTER_COMMAND,
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true }),
    ));

    // The editing newline inherits old-Enter: a new list item whose "2."
    // marker comes from the <ol>/<li> structure (CSS ::marker), never text.
    expect(onKeyDown).not.toHaveBeenCalled();
    await waitFor(() => expect(root.querySelectorAll('ol li')).toHaveLength(2));
    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toEqual({
      version: 1,
      segments: [{ type: 'text', text: '1. first\n2. ' }],
    }));
    editor.getEditorState().read(() => {
      const list = $getRoot().getFirstChild();
      expect(list?.getType()).toBe('list');
      expect($isElementNode(list) ? list.getChildren().map(node => node.getType()) : [])
        .toEqual(['listitem', 'listitem']);
    });

    // Marker CSS contract: the composer list classes must NOT suppress
    // ::marker (only the nested-list wrapper row may).
    const css = readFileSync('src/styles/gian-v2.css', 'utf8');
    const containers = css.match(/\.composer-md-ul,\s*\n\.composer-md-ol\s*\{([^}]*)\}/);
    expect(containers).not.toBeNull();
    expect(containers![1]).not.toContain('list-style');
    const item = css.match(/\.composer-md-li\s*\{([^}]*)\}/);
    expect(item).not.toBeNull();
    expect(item![1]).not.toContain('list-style');
  });

  it('Shift+Enter on an empty list item exits the list into a paragraph', async () => {
    const onKeyDown = vi.fn(() => true);
    render(
      <InlineComposerEditor
        initialDocument={{ version: 1, segments: [{ type: 'text', text: '- one' }] }}
        placeholder="Message"
        onChange={() => {}}
        onKeyDown={onKeyDown}
      />,
    );
    const editor = renderedEditor();
    placeCaretAtDocumentEnd(editor);
    const shiftEnter = () => act(() => editor.dispatchCommand(
      KEY_ENTER_COMMAND,
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true }),
    ));
    shiftEnter();
    expect(onKeyDown).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('textbox').querySelectorAll('li')).toHaveLength(2));
    // Same exit-on-empty as old Enter: the empty trailing item becomes a paragraph.
    shiftEnter();
    await waitFor(() => {
      editor.getEditorState().read(() => {
        expect($getRoot().getChildren().map(node => node.getType())).toEqual(['list', 'paragraph']);
      });
    });
    expect(onKeyDown).not.toHaveBeenCalled();
  });

  it('Shift+Enter during IME composition is left to the editor default', async () => {
    const onKeyDown = vi.fn(() => true);
    render(
      <InlineComposerEditor
        initialDocument={{ version: 1, segments: [{ type: 'text', text: '- one' }] }}
        placeholder="Message"
        onChange={() => {}}
        onKeyDown={onKeyDown}
      />,
    );
    const root = screen.getByRole('textbox');
    const editor = renderedEditor();
    placeCaretAtDocumentEnd(editor);
    const composing = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true });
    Object.defineProperty(composing, 'isComposing', { value: true });
    act(() => editor.dispatchCommand(KEY_ENTER_COMMAND, composing));
    // No submission, and no list continuation either — the composition owns Enter.
    expect(onKeyDown).not.toHaveBeenCalled();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(root.querySelectorAll('li')).toHaveLength(1);
  });

  it('Enter inside a code fence submits instead of adding a line', async () => {
    const onKeyDown = vi.fn(() => true);
    const onChange = vi.fn();
    render(
      <InlineComposerEditor
        initialDocument={{ version: 1, segments: [{ type: 'text', text: '```\nfirst\n```' }] }}
        placeholder="Message"
        onChange={onChange}
        onKeyDown={onKeyDown}
      />,
    );
    const editor = renderedEditor();
    placeCaretAtDocumentEnd(editor);
    act(() => editor.dispatchCommand(
      KEY_ENTER_COMMAND,
      new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }),
    ));
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    await new Promise(resolve => setTimeout(resolve, 20));
    // No line was added — the fence is exactly as it was.
    const root = screen.getByRole('textbox');
    expect(root.querySelector('code.composer-md-codeblock')).toHaveTextContent(/^first$/);
  });

  it('Shift+Enter inside a code fence adds a code line', async () => {
    const onKeyDown = vi.fn(() => true);
    const onChange = vi.fn();
    render(
      <InlineComposerEditor
        initialDocument={{ version: 1, segments: [{ type: 'text', text: '```\nfirst\n```' }] }}
        placeholder="Message"
        onChange={onChange}
        onKeyDown={onKeyDown}
      />,
    );
    const editor = renderedEditor();
    placeCaretAtDocumentEnd(editor);
    act(() => editor.dispatchCommand(
      KEY_ENTER_COMMAND,
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true }),
    ));
    expect(onKeyDown).not.toHaveBeenCalled();
    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toEqual({
      version: 1,
      segments: [{ type: 'text', text: '```\nfirst\n\n```' }],
    }));
  });

  it('Shift+Enter in a paragraph inserts a plain newline', async () => {
    const onKeyDown = vi.fn(() => true);
    const onChange = vi.fn();
    render(
      <InlineComposerEditor
        initialDocument={{ version: 1, segments: [{ type: 'text', text: 'hello' }] }}
        placeholder="Message"
        onChange={onChange}
        onKeyDown={onKeyDown}
      />,
    );
    const editor = renderedEditor();
    placeCaretAtDocumentEnd(editor);
    act(() => editor.dispatchCommand(
      KEY_ENTER_COMMAND,
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true }),
    ));
    expect(onKeyDown).not.toHaveBeenCalled();
    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toEqual({
      version: 1,
      segments: [{ type: 'text', text: 'hello\n' }],
    }));
    editor.getEditorState().read(() => {
      expect($getRoot().getChildren().map(node => node.getType())).toEqual(['paragraph']);
    });
  });

  it('transforms a heading shortcut while typing', async () => {
    const onChange = vi.fn();
    render(
      <InlineComposerEditor
        initialDocument={{ version: 1, segments: [] }}
        placeholder="Message"
        onChange={onChange}
      />,
    );
    const root = screen.getByRole('textbox');
    const editor = renderedEditor();
    act(() => editor.update(() => {
      $getRoot().getFirstChild()?.selectStart();
    }, { discrete: true }));
    typeText(editor, '#');
    typeText(editor, ' ');
    await waitFor(() => expect(root.querySelector('h1')).not.toBeNull());
    typeText(editor, 'Title');
    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[1]).toBe('# Title'));
  });

  it('transforms a bold shortcut while typing', async () => {
    const onChange = vi.fn();
    render(
      <InlineComposerEditor
        initialDocument={{ version: 1, segments: [] }}
        placeholder="Message"
        onChange={onChange}
      />,
    );
    const root = screen.getByRole('textbox');
    const editor = renderedEditor();
    act(() => editor.update(() => {
      $getRoot().getFirstChild()?.selectStart();
    }, { discrete: true }));
    typeText(editor, '**bold*');
    typeText(editor, '*');
    await waitFor(() => expect(root.querySelector('strong')).toHaveTextContent('bold'));
    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[1]).toBe('**bold**'));
  });

  it('transforms a list shortcut while typing', async () => {
    const onChange = vi.fn();
    render(
      <InlineComposerEditor
        initialDocument={{ version: 1, segments: [] }}
        placeholder="Message"
        onChange={onChange}
      />,
    );
    const root = screen.getByRole('textbox');
    const editor = renderedEditor();
    act(() => editor.update(() => {
      $getRoot().getFirstChild()?.selectStart();
    }, { discrete: true }));
    typeText(editor, '-');
    typeText(editor, ' ');
    await waitFor(() => expect(root.querySelector('ul li')).not.toBeNull());
    typeText(editor, 'item');
    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[1]).toBe('- item'));
  });

  it('keeps slash-command userText intact for the / prefix', async () => {
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
      segments: [{ type: 'text', text: '/model fast' }],
    }));
    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[1]).toBe('/model fast'));
    expect(screen.getByRole('textbox').querySelector('h1, ul, blockquote, pre')).toBeNull();
  });
});

describe('InlineComposerEditor soft-line markdown shortcuts', () => {
  function renderedEditor(): LexicalEditor {
    const root = screen.getByRole('textbox');
    const editor = (root as HTMLElement & { __lexicalEditor?: LexicalEditor }).__lexicalEditor;
    if (!editor) throw new Error('expected lexical editor on contenteditable');
    return editor;
  }

  function placeCaretAtDocumentEnd(editor: LexicalEditor): void {
    act(() => editor.update(() => {
      let node = $getRoot().getLastChild();
      while (node && $isElementNode(node) && node.getChildrenSize() > 0) {
        node = node.getLastChild();
      }
      if ($isTextNode(node)) node.selectEnd();
      else if ($isElementNode(node)) node.selectEnd();
    }, { discrete: true }));
  }

  // One update per character: the shortcut guards expect the caret to
  // advance a single character per update, exactly like real keystrokes.
  function typeText(editor: LexicalEditor, text: string): void {
    for (const char of text) {
      act(() => editor.update(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) selection.insertText(char);
      }, { discrete: true }));
    }
  }

  function shiftEnter(editor: LexicalEditor): void {
    act(() => editor.dispatchCommand(
      KEY_ENTER_COMMAND,
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true }),
    ));
  }

  const HEADING_LEVELS: Array<[string, number]> = [
    ['#', 1],
    ['##', 2],
    ['###', 3],
    ['####', 4],
    ['#####', 5],
    ['######', 6],
  ];

  it.each(HEADING_LEVELS)(
    'converts %s typed on a Shift+Enter line into a themed h%i with content intact',
    async (hashes, level) => {
      const onChange = vi.fn();
      render(
        <InlineComposerEditor
          initialDocument={{ version: 1, segments: [{ type: 'text', text: 'intro' }] }}
          placeholder="Message"
          onChange={onChange}
        />,
      );
      const root = screen.getByRole('textbox');
      const editor = renderedEditor();
      placeCaretAtDocumentEnd(editor);
      shiftEnter(editor);
      await waitFor(() => expect(root.querySelector('br')).not.toBeNull());

      typeText(editor, `${hashes} `);
      await waitFor(() => expect(root.querySelector(`h${level}.composer-md-h.composer-md-h${level}`)).not.toBeNull());
      typeText(editor, 'Title');
      // No swallowed or mangled characters: the heading is exactly "Title".
      await waitFor(() => expect(root.querySelector(`h${level}`)).toHaveTextContent(/^Title$/));

      // The trigger line became its own block; the previous line keeps its
      // paragraph, and the export re-emits literal markdown.
      editor.getEditorState().read(() => {
        expect($getRoot().getChildren().map(node => node.getType())).toEqual(['paragraph', 'heading']);
      });
      await waitFor(() => expect(onChange.mock.calls.at(-1)?.[1]).toBe(`intro\n\n${hashes} Title`));
    },
  );

  it('converts every heading level across consecutive Shift+Enter lines (owner scenario)', async () => {
    const onChange = vi.fn();
    render(
      <InlineComposerEditor
        initialDocument={{ version: 1, segments: [] }}
        placeholder="Message"
        onChange={onChange}
      />,
    );
    const root = screen.getByRole('textbox');
    const editor = renderedEditor();
    placeCaretAtDocumentEnd(editor);

    for (const [hashes, level] of HEADING_LEVELS) {
      if (level > 1) shiftEnter(editor);
      typeText(editor, `${hashes} `);
      await waitFor(() => expect(root.querySelector(`h${level}`)).not.toBeNull());
      typeText(editor, String(level));
    }

    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[1]).toBe(
      '# 1\n\n## 2\n\n### 3\n\n#### 4\n\n##### 5\n\n###### 6',
    ));
    editor.getEditorState().read(() => {
      const children = $getRoot().getChildren();
      expect(children.map(node => node.getType())).toEqual([
        'heading', 'heading', 'heading', 'heading', 'heading', 'heading',
      ]);
    });
    for (const [, level] of HEADING_LEVELS) {
      expect(root.querySelector(`h${level}.composer-md-h${level}`)).toHaveTextContent(new RegExp(`^${level}$`));
    }
  });

  it('keeps a heading trigger typed mid-line as literal text', async () => {
    const onChange = vi.fn();
    render(
      <InlineComposerEditor
        initialDocument={{ version: 1, segments: [{ type: 'text', text: 'intro' }] }}
        placeholder="Message"
        onChange={onChange}
      />,
    );
    const root = screen.getByRole('textbox');
    const editor = renderedEditor();
    placeCaretAtDocumentEnd(editor);
    shiftEnter(editor);
    await waitFor(() => expect(root.querySelector('br')).not.toBeNull());

    typeText(editor, 'x # 7');
    // Give the shortcut pass a beat to wrongly fire.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(root.querySelector('h1, h2, h3, h4, h5, h6')).toBeNull();
    expect(onChange.mock.calls.at(-1)?.[1]).toBe('intro\nx # 7');
  });

  it('plain Enter inside a heading submits instead of splitting the block', async () => {
    const onKeyDown = vi.fn(() => true);
    render(
      <InlineComposerEditor
        initialDocument={{ version: 1, segments: [{ type: 'text', text: '# Title' }] }}
        placeholder="Message"
        onChange={() => {}}
        onKeyDown={onKeyDown}
      />,
    );
    const root = screen.getByRole('textbox');
    const editor = renderedEditor();
    placeCaretAtDocumentEnd(editor);
    act(() => editor.dispatchCommand(
      KEY_ENTER_COMMAND,
      new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }),
    ));
    // Enter ALWAYS sends (owner contract) — the heading is not split.
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(root.querySelectorAll('h1')).toHaveLength(1);
    editor.getEditorState().read(() => {
      expect($getRoot().getChildren().map(node => node.getType())).toEqual(['heading']);
    });
  });

  it('restores a soft-wrapped multi-line heading draft into heading nodes', async () => {
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
    // Drafts persisted while lines were soft-wrapped carry single newlines;
    // the restore parse still recovers one heading per line.
    act(() => handle.current?.setDocument({
      version: 1,
      segments: [{ type: 'text', text: '# 1\n## 2\n### 3' }],
    }));
    const root = screen.getByRole('textbox');
    await waitFor(() => {
      expect(root.querySelector('h1.composer-md-h1')).toHaveTextContent(/^1$/);
      expect(root.querySelector('h2.composer-md-h2')).toHaveTextContent(/^2$/);
      expect(root.querySelector('h3.composer-md-h3')).toHaveTextContent(/^3$/);
    });
    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[1]).toBe('# 1\n\n## 2\n\n### 3'));
  });
});

describe('InlineComposerEditor format boundary escape', () => {
  function renderedEditor(): LexicalEditor {
    const root = screen.getByRole('textbox');
    const editor = (root as HTMLElement & { __lexicalEditor?: LexicalEditor }).__lexicalEditor;
    if (!editor) throw new Error('expected lexical editor on contenteditable');
    return editor;
  }

  function $findTextNode(predicate: (node: TextNode) => boolean): TextNode | null {
    const stack: LexicalNode[] = [$getRoot()];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if ($isTextNode(node) && predicate(node)) return node;
      if ($isElementNode(node)) stack.push(...node.getChildren());
    }
    return null;
  }

  // Places a collapsed caret the way a native selectionchange does: Lexical's
  // onSelectionChange inherits the anchor text node's format into
  // selection.format and then dispatches SELECTION_CHANGE_COMMAND. jsdom
  // never fires that event, so the sequence is replayed explicitly.
  function placeCaret(
    editor: LexicalEditor,
    match: (node: TextNode) => boolean,
    offset: number | 'end',
  ): void {
    act(() => editor.update(() => {
      const node = $findTextNode(match);
      if (!node) throw new Error('expected a matching text node');
      const at = offset === 'end' ? node.getTextContentSize() : offset;
      node.select(at, at);
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) throw new Error('expected a range selection');
      selection.setFormat(node.getFormat());
      editor.dispatchCommand(SELECTION_CHANGE_COMMAND, undefined);
    }, { discrete: true }));
  }

  function typeText(editor: LexicalEditor, text: string): void {
    act(() => editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) selection.insertText(text);
    }, { discrete: true }));
  }

  function lastDocument(onChange: ReturnType<typeof vi.fn>) {
    return onChange.mock.calls.at(-1)?.[0];
  }

  async function renderDocument(text: string) {
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
    act(() => handle.current?.setDocument({ version: 1, segments: [{ type: 'text', text }] }));
    return { editor: renderedEditor(), onChange };
  }

  it('typing after a bold segment at the end of a paragraph escapes bold', async () => {
    const { editor, onChange } = await renderDocument('**bold**');
    const root = screen.getByRole('textbox');
    placeCaret(editor, node => node.hasFormat('bold'), 'end');
    // Two separate insertions: the escape must hold for everything typed
    // afterwards, not just the first character.
    typeText(editor, 'a');
    typeText(editor, 'b');

    await waitFor(() => expect(lastDocument(onChange).segments).toEqual([
      { type: 'text', text: '**bold**ab' },
    ]));
    expect(root.querySelector('.composer-md-bold')).toHaveTextContent(/^bold$/);
  });

  it('typing right after an inline-code segment escapes the code format', async () => {
    const { editor, onChange } = await renderDocument('run `web_fetch` 是怎么实现的');
    const root = screen.getByRole('textbox');
    placeCaret(editor, node => node.hasFormat('code'), 'end');
    typeText(editor, 'X');

    await waitFor(() => expect(lastDocument(onChange).segments).toEqual([
      { type: 'text', text: 'run `web_fetch`X 是怎么实现的' },
    ]));
    expect(root.querySelector('.composer-md-inline-code')).toHaveTextContent(/^web_fetch$/);
  });

  it('typing in the middle of a formatted segment keeps the format', async () => {
    const { editor, onChange } = await renderDocument('**bold**');
    placeCaret(editor, node => node.hasFormat('bold'), 2);
    typeText(editor, 'X');

    await waitFor(() => expect(lastDocument(onChange).segments).toEqual([
      { type: 'text', text: '**boXld**' },
    ]));
  });

  it('typing before a formatted segment preceded by plain text escapes the format', async () => {
    const { editor, onChange } = await renderDocument('plain **bold**');
    placeCaret(editor, node => node.hasFormat('bold'), 0);
    typeText(editor, 'X');

    await waitFor(() => expect(lastDocument(onChange).segments).toEqual([
      { type: 'text', text: 'plain X**bold**' },
    ]));
  });

  it('typing at the very start of a formatted block keeps the format', async () => {
    const { editor, onChange } = await renderDocument('**bold**');
    placeCaret(editor, node => node.hasFormat('bold'), 0);
    typeText(editor, 'X');

    await waitFor(() => expect(lastDocument(onChange).segments).toEqual([
      { type: 'text', text: '**Xbold**' },
    ]));
  });

  it('typing between a bold segment and a reference chip escapes bold', async () => {
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
      segments: [
        { type: 'text', text: '**bold**' },
        { type: 'reference', id: 'ctx-1', referenceType: 'context', label: 'src' },
        { type: 'text', text: ' ' },
      ],
    }));
    const editor = renderedEditor();
    placeCaret(editor, node => node.hasFormat('bold'), 'end');
    typeText(editor, 'X');

    await waitFor(() => expect(lastDocument(onChange)).toEqual({
      version: 1,
      segments: [
        { type: 'text', text: '**bold**X' },
        { type: 'reference', id: 'ctx-1', referenceType: 'context', label: 'src' },
        { type: 'text', text: ' ' },
      ],
    }));
  });

  it('preserves literal whitespace-only draft segments between and after reference chips', async () => {
    const handle = createRef<InlineComposerEditorHandle>();
    const onChange = vi.fn();
    render(<InlineComposerEditor ref={handle} initialDocument={{ version: 1, segments: [] }}
      placeholder="Message" onChange={onChange} />);
    await waitFor(() => expect(handle.current).not.toBeNull());
    const document: ComposerDocument = { version: 1, segments: [
      { type: 'reference', id: 'ctx-1', referenceType: 'context', label: 'one' },
      { type: 'text', text: ' \t ' },
      { type: 'reference', id: 'ctx-2', referenceType: 'context', label: 'two' },
      { type: 'text', text: ' ' },
    ] };
    act(() => handle.current?.setDocument(document));
    await waitFor(() => expect(lastDocument(onChange)).toEqual(document));
  });
});

describe('InlineComposerEditor @ file mention', () => {
  const FILES: ComposerFileOption[] = [
    { path: '/repo/src/index.ts', relPath: 'src/index.ts', name: 'index.ts' },
    { path: '/repo/src/app.ts', relPath: 'src/app.ts', name: 'app.ts' },
  ];

  function renderedEditor(): LexicalEditor {
    const root = screen.getByRole('textbox');
    const editor = (root as HTMLElement & { __lexicalEditor?: LexicalEditor }).__lexicalEditor;
    if (!editor) throw new Error('expected lexical editor on contenteditable');
    return editor;
  }

  function typeText(editor: LexicalEditor, text: string): void {
    act(() => editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) selection.insertText(text);
    }, { discrete: true }));
  }

  function renderMentionEditor(props?: {
    onFileQuery?: (query: string) => Promise<ComposerFileOption[]>;
    onFileReference?: (file: ComposerFileReference) => void;
    onChange?: (document: unknown, userText: string) => void;
  }) {
    return render(
      <InlineComposerEditor
        initialDocument={{ version: 1, segments: [] }}
        placeholder="Message"
        onChange={props?.onChange ?? (() => {})}
        {...(props?.onFileQuery ? { onFileQuery: props.onFileQuery } : {})}
        {...(props?.onFileReference ? { onFileReference: props.onFileReference } : {})}
      />,
    );
  }

  function openPopover(editor: LexicalEditor, query: string): void {
    act(() => editor.update(() => {
      $getRoot().getFirstChild()?.selectStart();
    }, { discrete: true }));
    typeText(editor, `@${query}`);
  }

  function keydown(editor: LexicalEditor, command: typeof KEY_ENTER_COMMAND, key: string): void {
    act(() => editor.dispatchCommand(command, new KeyboardEvent('keydown', { key, cancelable: true })));
  }

  it('opens the popover at the caret, accepts the first row with Enter, and inserts a file chip', async () => {
    const onFileQuery = vi.fn(async (query: string) =>
      FILES.filter(file => file.relPath.toLowerCase().includes(query.toLowerCase())));
    const onFileReference = vi.fn();
    const onChange = vi.fn();
    renderMentionEditor({ onFileQuery, onFileReference, onChange });
    const editor = renderedEditor();
    openPopover(editor, 'ind');

    await waitFor(() => expect(document.body.querySelector('.cmp-file-pop')).not.toBeNull());
    const row = document.body.querySelector('.cmp-file-row')!;
    expect(row.querySelector('.cmp-file-name')!.textContent).toBe('index.ts');
    // The matched substring is bolded; the muted directory trails the name.
    expect(row.querySelector('.cmp-file-name strong')!.textContent).toBe('ind');
    expect(row.querySelector('.cmp-file-path')!.textContent).toBe('src');
    expect(document.body.querySelector('.cmp-file-hint')!.textContent).toContain('↑↓');
    // The first row is preselected once results land.
    await waitFor(() => expect(document.body.querySelector('.cmp-file-row.active')).not.toBeNull());

    keydown(editor, KEY_ENTER_COMMAND, 'Enter');
    expect(onFileReference).toHaveBeenCalledTimes(1);
    const reference = onFileReference.mock.calls[0]![0] as ComposerFileReference;
    expect(reference).toEqual({
      id: expect.any(String),
      path: '/repo/src/index.ts',
      name: 'index.ts',
    });

    // The typed query is replaced by the chip plus a trailing space.
    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toEqual({
      version: 1,
      segments: [
        { type: 'reference', id: reference.id, referenceType: 'context', label: 'index.ts', kind: 'file' },
        { type: 'text', text: ' ' },
      ],
    }));
    expect(document.body.querySelector('.cmp-file-pop')).toBeNull();

    const chip = screen.getByRole('textbox').querySelector('.composer-inline-reference')!;
    expect(chip.getAttribute('data-reference-kind')).toBe('file');
    expect(chip.querySelector('.cir-glyph')).not.toBeNull();
    expect(chip.querySelector('.cir-label')!.textContent).toBe('index.ts');
  });

  it('opens upward above the composer box, not downward from the caret', async () => {
    const onFileQuery = vi.fn(async () => FILES);
    renderMentionEditor({ onFileQuery, onFileReference: vi.fn() });
    const editor = renderedEditor();
    openPopover(editor, 'ind');

    await waitFor(() => expect(document.body.querySelector('.cmp-file-pop')).not.toBeNull());
    const pop = document.body.querySelector<HTMLElement>('.cmp-file-pop')!;
    // Portaled straight to the body (escapes the Lexical typeahead anchor,
    // whose caret-relative geometry opens downward) and anchored bottom-up
    // like the `+` menu: `bottom` carries the position, `top` stays unset.
    expect(pop.parentElement).toBe(document.body);
    expect(pop.style.bottom).toBe(`${window.innerHeight + UPWARD_POPOVER_GAP}px`);
    expect(pop.style.top).toBe('');
    // jsdom rects are all-zero, so the space-above clamp floors the height.
    expect(pop.style.maxHeight).toBe(`${UPWARD_POPOVER_MIN_HEIGHT}px`);
    // Zero caret x clamps to the viewport margin.
    expect(pop.style.left).toBe(`${UPWARD_POPOVER_MARGIN}px`);
  });

  it('moves the highlight with the arrow keys and accepts it with Enter', async () => {
    const onFileQuery = vi.fn(async () => FILES);
    const onFileReference = vi.fn();
    renderMentionEditor({ onFileQuery, onFileReference });
    const editor = renderedEditor();
    openPopover(editor, '');

    await waitFor(() => expect(document.body.querySelectorAll('.cmp-file-row')).toHaveLength(2));
    keydown(editor, KEY_ARROW_DOWN_COMMAND, 'ArrowDown');
    const rows = document.body.querySelectorAll('.cmp-file-row');
    expect(rows[1]!.className).toContain('active');

    keydown(editor, KEY_ENTER_COMMAND, 'Enter');
    expect(onFileReference).toHaveBeenCalledWith(expect.objectContaining({ name: 'app.ts' }));
  });

  it('dismisses on Escape without inserting a chip', async () => {
    const onFileQuery = vi.fn(async () => FILES);
    const onFileReference = vi.fn();
    renderMentionEditor({ onFileQuery, onFileReference });
    const editor = renderedEditor();
    openPopover(editor, 'a');

    await waitFor(() => expect(document.body.querySelector('.cmp-file-pop')).not.toBeNull());
    keydown(editor, KEY_ESCAPE_COMMAND, 'Escape');
    await waitFor(() => expect(document.body.querySelector('.cmp-file-pop')).toBeNull());
    expect(onFileReference).not.toHaveBeenCalled();
    // The literal query text stays in the editor.
    expect(screen.getByRole('textbox').textContent).toContain('@a');
  });

  it('shows the empty state when no files match', async () => {
    const onFileQuery = vi.fn(async () => []);
    renderMentionEditor({ onFileQuery, onFileReference: vi.fn() });
    const editor = renderedEditor();
    openPopover(editor, 'zzzz');

    await waitFor(() => expect(document.body.querySelector('.cmp-file-empty')).not.toBeNull());
    expect(document.body.querySelector('.cmp-file-empty')!.textContent).toBe('No matching files');
  });

  it('selects a row by pointer', async () => {
    const onFileQuery = vi.fn(async () => FILES);
    const onFileReference = vi.fn();
    renderMentionEditor({ onFileQuery, onFileReference });
    const editor = renderedEditor();
    openPopover(editor, 'app');

    await waitFor(() => expect(document.body.querySelectorAll('.cmp-file-row')).toHaveLength(2));
    const row = [...document.body.querySelectorAll('.cmp-file-row')]
      .find(el => el.textContent?.includes('app.ts'))!;
    act(() => {
      // jsdom has no PointerEvent constructor; React's onPointerDown listens
      // for the 'pointerdown' event type, which a plain MouseEvent satisfies.
      row.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    });
    expect(onFileReference).toHaveBeenCalledWith(expect.objectContaining({ name: 'app.ts' }));
    await waitFor(() => expect(document.body.querySelector('.cmp-file-pop')).toBeNull());
  });

  it('keeps @ as plain text when no file query source is provided', async () => {
    renderMentionEditor({});
    const editor = renderedEditor();
    openPopover(editor, 'ind');
    // Give the (absent) plugin a beat to wrongly open.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(document.body.querySelector('.cmp-file-pop')).toBeNull();
    expect(screen.getByRole('textbox').textContent).toContain('@ind');
  });
});
