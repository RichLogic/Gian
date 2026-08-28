import { readFileSync } from 'node:fs';
import { createRef } from 'react';
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
  KEY_ARROW_RIGHT_COMMAND,
  PASTE_COMMAND,
  type LexicalEditor,
  UNDO_COMMAND,
} from 'lexical';

import {
  InlineComposerEditor,
  type InlineComposerEditorHandle,
} from '../src/components/composer/InlineComposerEditor.js';

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
      // Collapsed to the paragraph-level caret right after the chip.
      expect($isElementNode(selection?.anchor.getNode())).toBe(true);
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
