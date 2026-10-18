import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $setBlocksType } from '@lexical/selection';
import { $createCodeNode, $isCodeNode } from '@lexical/code-core';
import { $isLinkNode, $toggleLink, TOGGLE_LINK_COMMAND } from '@lexical/link';
import {
  $isListItemNode,
  $isListNode,
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
  REMOVE_LIST_COMMAND,
} from '@lexical/list';
import { $createQuoteNode, $isQuoteNode } from '@lexical/rich-text';
import {
  $createParagraphNode,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  COMMAND_PRIORITY_LOW,
  COMMAND_PRIORITY_NORMAL,
  FORMAT_TEXT_COMMAND,
  KEY_MODIFIER_COMMAND,
  SELECTION_CHANGE_COMMAND,
  type LexicalNode,
  type RangeSelection,
  type TextFormatType,
} from 'lexical';
import { useT } from '../../i18n/index.js';

// Inline lucide 24-grid paths, matching the repo's ICON map idiom.
const ICONS = {
  bold: 'M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z',
  italic: 'M19 4h-9 M14 20H5 M15 4 9 20',
  strikethrough: 'M16 4H9a3 3 0 0 0-2.83 4 M14 12a4 4 0 0 1 0 8H6 M4 12h16',
  code: 'm16 18 6-6-6-6 M8 6l-6 6 6 6',
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71 M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  bulletList: 'M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01',
  orderedList: 'M10 6h11 M10 12h11 M10 18h11 M4 6h1v4 M4 10h2 M6 18H4c0-1 2-2 2-3s-1-1.5-2-1',
  quote: 'M17 6H3 M21 12H8 M21 18H8 M3 12v6',
  codeBlock: 'M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1 M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1',
  clear: 'M4 7V4h16v3 M5 20h14 M12 4 8 20',
} as const;

const VIEWPORT_EDGE = 12;
const TOOLBAR_CLEARANCE = 8;
const TOOLBAR_HEIGHT_ESTIMATE = 40;
const TOOLBAR_HALF_WIDTH_ESTIMATE = 170;

type BlockKind = 'paragraph' | 'quote' | 'code' | 'bullet' | 'number';

interface ToolbarState {
  left: number;
  top: number;
  below: boolean;
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  code: boolean;
  link: boolean;
  block: BlockKind;
}

function $selectionBlockKind(selection: RangeSelection): BlockKind {
  const anchor = selection.anchor.getNode();
  const chain: LexicalNode[] = [anchor, ...anchor.getParents()];
  for (const node of chain) {
    if ($isListItemNode(node)) {
      const list = node.getParent();
      return $isListNode(list) && list.getListType() === 'number' ? 'number' : 'bullet';
    }
    if ($isQuoteNode(node)) return 'quote';
    if ($isCodeNode(node)) return 'code';
  }
  return 'paragraph';
}

function $selectionHasLink(selection: RangeSelection): boolean {
  return selection.getNodes().some(node => $isLinkNode(node) || $isLinkNode(node.getParent()));
}

function FormatIcon({ path }: { path: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}

type FormatState = Omit<ToolbarState, 'left' | 'top' | 'below'>;

function $readFormatState(): FormatState | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || selection.isCollapsed()) return null;
  return {
    bold: selection.hasFormat('bold'),
    italic: selection.hasFormat('italic'),
    strikethrough: selection.hasFormat('strikethrough'),
    code: selection.hasFormat('code'),
    link: $selectionHasLink(selection),
    block: $selectionBlockKind(selection),
  };
}

// Floating markdown format toolbar for the composer: appears above the current
// text selection with toggle buttons for inline formats, link, and block types.
// Geometry and dismissal mirror TranscriptSelectionActions: portal to the body,
// range-rect positioning with viewport clamp and above/below flip, mousedown
// prevented so the editor keeps focus and selection, closed on Escape, outside
// pointerdown, scroll, or resize.
export function FormatToolbarPlugin() {
  const [editor] = useLexicalComposerContext();
  const t = useT();
  const toolbarRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingLinkSelection = useRef<RangeSelection | null>(null);
  const [state, setState] = useState<ToolbarState | null>(null);
  const [linkEditing, setLinkEditing] = useState(false);
  const visibleRef = useRef(false);
  visibleRef.current = state !== null;

  const close = useCallback(() => {
    setState(null);
    setLinkEditing(false);
    pendingLinkSelection.current = null;
  }, []);

  // `formats` is passed by callers already inside an editor read/update
  // context. External callers fall back to reading the committed state —
  // editor.read() is NOT used because its default 'force-commit' mode flushes
  // the pending update, which corrupts history coalescing when invoked from a
  // command listener mid-update.
  const sync = useCallback((formats?: FormatState | null) => {
    const resolved = formats === undefined
      ? editor.getEditorState().read($readFormatState)
      : formats;
    const native = window.getSelection();
    if (!resolved || !native || native.isCollapsed || native.rangeCount === 0) {
      close();
      return;
    }
    const rootElement = editor.getRootElement();
    if (!rootElement || !native.anchorNode || !rootElement.contains(native.anchorNode)) {
      close();
      return;
    }
    const rect = native.getRangeAt(0).getBoundingClientRect();
    if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top)) {
      close();
      return;
    }
    const below = rect.top < TOOLBAR_HEIGHT_ESTIMATE + TOOLBAR_CLEARANCE;
    const halfWidth = Math.min(
      TOOLBAR_HALF_WIDTH_ESTIMATE,
      Math.max(0, (window.innerWidth - VIEWPORT_EDGE * 2) / 2),
    );
    setState({
      ...resolved,
      below,
      left: Math.min(
        window.innerWidth - VIEWPORT_EDGE - halfWidth,
        Math.max(VIEWPORT_EDGE + halfWidth, rect.left + rect.width / 2),
      ),
      top: below ? rect.bottom + TOOLBAR_CLEARANCE : rect.top - TOOLBAR_CLEARANCE,
    });
  }, [editor, close]);

  useEffect(() => editor.registerCommand(
    SELECTION_CHANGE_COMMAND,
    () => {
      sync($readFormatState());
      return false;
    },
    COMMAND_PRIORITY_LOW,
  ), [editor, sync]);

  // Format toggles do not move the selection, so SELECTION_CHANGE never fires
  // for them; re-read the pressed state after every update while visible.
  useEffect(() => editor.registerUpdateListener(({ editorState }) => {
    if (visibleRef.current) sync(editorState.read($readFormatState));
  }), [editor, sync]);

  // No LexicalLinkPlugin is mounted in the composer; own TOGGLE_LINK_COMMAND
  // here so the toolbar's link action and tests share one canonical path.
  useEffect(() => editor.registerCommand(
    TOGGLE_LINK_COMMAND,
    payload => {
      if (payload === null) {
        $toggleLink(null);
        return true;
      }
      if (typeof payload === 'string') {
        $toggleLink(payload);
        return true;
      }
      return false;
    },
    COMMAND_PRIORITY_NORMAL,
  ), [editor]);

  useEffect(() => {
    if (!state) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && toolbarRef.current?.contains(event.target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (event.target instanceof Node && toolbarRef.current?.contains(event.target)) return;
      close();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [state, close]);

  useEffect(() => {
    if (linkEditing) inputRef.current?.focus();
  }, [linkEditing]);

  if (!state) return null;

  const toggleFormat = (format: TextFormatType) => {
    editor.dispatchCommand(FORMAT_TEXT_COMMAND, format);
    sync();
  };

  const toggleList = (kind: 'bullet' | 'number') => {
    if (state.block === kind) {
      editor.dispatchCommand(REMOVE_LIST_COMMAND, undefined);
    } else {
      editor.dispatchCommand(
        kind === 'bullet' ? INSERT_UNORDERED_LIST_COMMAND : INSERT_ORDERED_LIST_COMMAND,
        undefined,
      );
    }
    sync();
  };

  const toggleBlock = (kind: 'quote' | 'code') => {
    editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;
      const active = $selectionBlockKind(selection) === kind;
      $setBlocksType(selection, () => (
        active
          ? $createParagraphNode()
          : kind === 'quote' ? $createQuoteNode() : $createCodeNode()
      ));
    });
    sync();
  };

  const toggleLink = () => {
    if (state.link) {
      editor.dispatchCommand(TOGGLE_LINK_COMMAND, null);
      sync();
      return;
    }
    editor.getEditorState().read(() => {
      const selection = $getSelection();
      pendingLinkSelection.current = $isRangeSelection(selection) ? selection.clone() : null;
    });
    if (pendingLinkSelection.current) setLinkEditing(true);
  };

  const applyLink = (url: string) => {
    const cloned = pendingLinkSelection.current;
    pendingLinkSelection.current = null;
    setLinkEditing(false);
    if (!cloned) return;
    const trimmed = url.trim();
    if (!trimmed) {
      sync();
      return;
    }
    editor.update(() => {
      $setSelection(cloned);
      editor.dispatchCommand(TOGGLE_LINK_COMMAND, trimmed);
    });
    sync();
  };

  const clearFormatting = () => {
    editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;
      // FORMAT_TEXT_COMMAND only toggles, so it cannot clear a selection whose
      // formats are mixed; reset every covered text node directly instead.
      for (const node of selection.getNodes()) {
        if ($isTextNode(node)) node.setFormat(0);
      }
      // Keep the selection's cached format bits in line with the cleared
      // nodes, or the pressed state and the next toggle direction go stale.
      if (selection.format !== 0) selection.setFormat(0);
      const block = $selectionBlockKind(selection);
      if (block === 'bullet' || block === 'number') {
        editor.dispatchCommand(REMOVE_LIST_COMMAND, undefined);
      } else if (block === 'quote' || block === 'code') {
        $setBlocksType(selection, () => $createParagraphNode());
      }
    });
    sync();
  };

  const button = (
    testId: string,
    title: string,
    path: string,
    pressed: boolean | undefined,
    onClick: () => void,
  ) => (
    <button
      key={testId}
      type="button"
      data-testid={testId}
      className={`composer-format-btn${pressed ? ' active' : ''}`}
      {...(pressed === undefined ? {} : { 'aria-pressed': pressed })}
      title={title}
      aria-label={title}
      onClick={onClick}
    >
      <FormatIcon path={path} />
    </button>
  );

  return createPortal(
    <div
      ref={toolbarRef}
      className={`composer-format-toolbar is-${state.below ? 'below' : 'above'}`}
      role="toolbar"
      aria-label={t('composer.format.toolbar')}
      data-testid="composer-format-toolbar"
      style={{ left: state.left, top: state.top }}
      onMouseDown={event => {
        // Keep the editor's focus/selection — except the link input, which
        // needs its own caret once open (it is autofocused anyway).
        if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
      }}
    >
      {linkEditing ? (
        <input
          ref={inputRef}
          type="text"
          className="composer-format-link-input"
          data-testid="composer-format-link-input"
          placeholder={t('composer.format.linkPlaceholder')}
          aria-label={t('composer.format.link')}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault();
              applyLink(event.currentTarget.value);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              pendingLinkSelection.current = null;
              setLinkEditing(false);
            }
          }}
        />
      ) : (
        <>
          {button('composer-format-bold', t('composer.format.bold'), ICONS.bold, state.bold, () => toggleFormat('bold'))}
          {button('composer-format-italic', t('composer.format.italic'), ICONS.italic, state.italic, () => toggleFormat('italic'))}
          {button('composer-format-strikethrough', t('composer.format.strikethrough'), ICONS.strikethrough, state.strikethrough, () => toggleFormat('strikethrough'))}
          {button('composer-format-inline-code', t('composer.format.inlineCode'), ICONS.code, state.code, () => toggleFormat('code'))}
          {button('composer-format-link', t('composer.format.link'), ICONS.link, state.link, toggleLink)}
          <span className="composer-format-divider" aria-hidden="true" />
          {button('composer-format-bullet-list', t('composer.format.bulletList'), ICONS.bulletList, state.block === 'bullet', () => toggleList('bullet'))}
          {button('composer-format-ordered-list', t('composer.format.orderedList'), ICONS.orderedList, state.block === 'number', () => toggleList('number'))}
          {button('composer-format-quote', t('composer.format.quote'), ICONS.quote, state.block === 'quote', () => toggleBlock('quote'))}
          {button('composer-format-code-block', t('composer.format.codeBlock'), ICONS.codeBlock, state.block === 'code', () => toggleBlock('code'))}
          <span className="composer-format-divider" aria-hidden="true" />
          {button('composer-format-clear', t('composer.format.clearFormat'), ICONS.clear, undefined, clearFormatting)}
        </>
      )}
    </div>,
    document.body,
  );
}

// ⌘/Ctrl+B bold, ⌘/Ctrl+I italic, ⌘/Ctrl+E inline code, ⇧⌘/Ctrl+X strikethrough.
// Anything else returns false so the composer's ⌘Enter handling, chip
// machinery, and Lexical defaults keep ownership of their keys.
export function FormatShortcutPlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => editor.registerCommand(
    KEY_MODIFIER_COMMAND,
    (event: KeyboardEvent) => {
      if (event.isComposing) return false;
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return false;
      const key = event.key.toLowerCase();
      let format: TextFormatType | null = null;
      if (!event.shiftKey) {
        if (key === 'b') format = 'bold';
        else if (key === 'i') format = 'italic';
        else if (key === 'e') format = 'code';
      } else if (key === 'x') {
        format = 'strikethrough';
      }
      if (!format) return false;
      event.preventDefault();
      editor.dispatchCommand(FORMAT_TEXT_COMMAND, format);
      return true;
    },
    COMMAND_PRIORITY_NORMAL,
  ), [editor]);
  return null;
}
