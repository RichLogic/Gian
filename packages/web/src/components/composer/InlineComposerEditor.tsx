import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type CSSProperties,
  type MutableRefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { MarkdownShortcutPlugin } from '@lexical/react/LexicalMarkdownShortcutPlugin';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
  useBasicTypeaheadTriggerMatch,
} from '@lexical/react/LexicalTypeaheadMenuPlugin';
import {
  $isHeadingNode,
  $isQuoteNode,
  HeadingNode,
  QuoteNode,
} from '@lexical/rich-text';
import {
  $isListItemNode,
  $isListNode,
  ListItemNode,
  ListNode,
} from '@lexical/list';
import { $isLinkNode, LinkNode } from '@lexical/link';
import {
  $isCodeNode,
  CodeHighlightNode,
  CodeNode,
} from '@lexical/code-core';
import {
  $generateNodesFromMarkdownString,
  BOLD_ITALIC_STAR,
  BOLD_ITALIC_UNDERSCORE,
  BOLD_STAR,
  BOLD_UNDERSCORE,
  CODE,
  HEADING,
  INLINE_CODE,
  ITALIC_STAR,
  ITALIC_UNDERSCORE,
  LINK,
  ORDERED_LIST,
  QUOTE,
  type ElementTransformer,
  type Transformer,
  UNORDERED_LIST,
} from '@lexical/markdown';
import {
  $getClipboardDataFromSelection,
  $insertDataTransferForRichText,
  setLexicalClipboardDataTransfer,
} from '@lexical/clipboard';
import {
  $addUpdateTag,
  $applyNodeReplacement,
  $createNodeSelection,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isLineBreakNode,
  $isNodeSelection,
  $isParagraphNode,
  $isRangeSelection,
  $isRootOrShadowRoot,
  $isTextNode,
  $setSelection,
  COLLABORATION_TAG,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  COMPOSITION_END_TAG,
  COPY_COMMAND,
  CUT_COMMAND,
  DecoratorNode,
  HISTORIC_TAG,
  HISTORY_PUSH_TAG,
  INSERT_LINE_BREAK_COMMAND,
  INSERT_PARAGRAPH_COMMAND,
  IS_BOLD,
  IS_CODE,
  IS_ITALIC,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  PASTE_COMMAND,
  SELECTION_CHANGE_COMMAND,
  type EditorState,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type LexicalUpdateJSON,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
  type TextNode,
} from 'lexical';
import type {
  ComposerDocument,
  ComposerReferenceSegment,
} from '@gian/shared';
import {
  composerDocumentUserText,
  normalizeComposerDocument,
} from '@gian/shared';
import { useT } from '../../i18n/index.js';
import type { ComposerFileOption } from './capabilities.js';
import { highlightMatch } from './highlight-match.js';
import { upwardPopoverLayout } from './upward-popover.js';

type SerializedReferenceNode = Spread<{
  referenceId: string;
  referenceType: ComposerReferenceSegment['referenceType'];
  label: string;
  kind?: 'file' | 'session';
}, SerializedLexicalNode>;

const REFERENCE_FILE_GLYPH_SVG = '<svg viewBox="0 0 16 16" fill="none"><path d="M4 1.75h5l3 3V14.25H4z" stroke="currentColor" stroke-width="1.2"/><path d="M9 1.75v3h3" stroke="currentColor" stroke-width="1.2"/></svg>';
const REFERENCE_SESSION_GLYPH_SVG = '<svg viewBox="0 0 16 16" fill="none"><path d="M2.25 3.25h11.5v8H8.75l-3.5 3v-3h-3z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';

class ReferenceNode extends DecoratorNode<null> {
  __referenceId: string;
  __referenceType: ComposerReferenceSegment['referenceType'];
  __label: string;
  __kind: 'file' | 'session' | undefined;

  static override getType(): string {
    return 'composer-reference';
  }

  static override clone(node: ReferenceNode): ReferenceNode {
    return new ReferenceNode(node.__referenceId, node.__referenceType, node.__label, node.__kind, node.__key);
  }

  static override importJSON(serialized: SerializedReferenceNode): ReferenceNode {
    return $createReferenceNode({
      id: serialized.referenceId,
      referenceType: serialized.referenceType,
      label: serialized.label,
      ...(serialized.kind === 'file' || serialized.kind === 'session' ? { kind: serialized.kind } : {}),
    }).updateFromJSON(serialized);
  }

  constructor(
    referenceId: string,
    referenceType: ComposerReferenceSegment['referenceType'],
    label: string,
    kind?: 'file' | 'session',
    key?: NodeKey,
  ) {
    super(key);
    this.__referenceId = referenceId;
    this.__referenceType = referenceType;
    this.__label = label;
    this.__kind = kind;
  }

  override afterCloneFrom(previous: this): void {
    super.afterCloneFrom(previous);
    this.__referenceId = previous.__referenceId;
    this.__referenceType = previous.__referenceType;
    this.__label = previous.__label;
    this.__kind = previous.__kind;
  }

  override updateFromJSON(serialized: LexicalUpdateJSON<SerializedReferenceNode>): this {
    return super.updateFromJSON(serialized);
  }

  override exportJSON(): SerializedReferenceNode {
    return {
      ...super.exportJSON(),
      type: 'composer-reference',
      version: 1,
      referenceId: this.__referenceId,
      referenceType: this.__referenceType,
      label: this.__label,
      ...(this.__kind ? { kind: this.__kind } : {}),
    };
  }

  override createDOM(): HTMLElement {
    const element = document.createElement('span');
    element.className = 'composer-inline-reference';
    element.dataset.referenceId = this.__referenceId;
    element.dataset.referenceType = this.__referenceType;
    if (this.__kind) element.dataset.referenceKind = this.__kind;
    element.setAttribute('role', 'button');
    element.setAttribute('aria-label', this.__label);
    element.setAttribute('contenteditable', 'false');
    const label = document.createElement('span');
    label.className = 'cir-label';
    label.textContent = this.__label;
    // Plain context chips get their '@' glyph from CSS ::before so the
    // editor's text content stays clean; attachments and file/session
    // references carry a real icon (their chip CSS suppresses the '@').
    if (this.__referenceType === 'attachment' || this.__kind === 'file' || this.__kind === 'session') {
      const glyph = document.createElement('span');
      glyph.className = 'cir-glyph';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.innerHTML = this.__kind === 'session' ? REFERENCE_SESSION_GLYPH_SVG : REFERENCE_FILE_GLYPH_SVG;
      element.append(glyph, label);
    } else {
      element.append(label);
    }
    return element;
  }

  override updateDOM(previous: ReferenceNode, element: HTMLElement): boolean {
    if (previous.__kind !== this.__kind) return true;
    if (
      previous.__label !== this.__label
      || previous.__referenceId !== this.__referenceId
      || previous.__referenceType !== this.__referenceType
    ) {
      element.dataset.referenceId = this.__referenceId;
      element.dataset.referenceType = this.__referenceType;
      element.setAttribute('aria-label', this.__label);
      const labelEl = element.querySelector('.cir-label');
      if (labelEl) labelEl.textContent = this.__label;
      else element.textContent = this.__label;
    }
    return false;
  }

  override decorate(): null {
    return null;
  }

  override isInline(): true {
    return true;
  }

  override isKeyboardSelectable(): true {
    return true;
  }

  override getTextContent(): string {
    return `"${this.__label}"`;
  }

  reference(): ComposerReferenceSegment {
    const latest = this.getLatest();
    return {
      type: 'reference',
      id: latest.__referenceId,
      referenceType: latest.__referenceType,
      label: latest.__label,
      ...(latest.__kind ? { kind: latest.__kind } : {}),
    };
  }
}

function $createReferenceNode(reference: Omit<ComposerReferenceSegment, 'type'>): ReferenceNode {
  return $applyNodeReplacement(new ReferenceNode(
    reference.id,
    reference.referenceType,
    reference.label,
    reference.kind,
  ));
}

function $isReferenceNode(node: LexicalNode | null | undefined): node is ReferenceNode {
  return node instanceof ReferenceNode;
}

// In-scope markdown only: headings, bold/italic, inline code, lists,
// blockquote, and code fences. Tables, math, mermaid, checklists,
// strikethrough, highlight, and horizontal rules stay out of the composer.
const COMPOSER_TRANSFORMERS: Transformer[] = [
  HEADING,
  QUOTE,
  UNORDERED_LIST,
  ORDERED_LIST,
  CODE,
  INLINE_CODE,
  BOLD_ITALIC_STAR,
  BOLD_ITALIC_UNDERSCORE,
  BOLD_STAR,
  BOLD_UNDERSCORE,
  ITALIC_STAR,
  ITALIC_UNDERSCORE,
  LINK,
];

const COMPOSER_ELEMENT_TRANSFORMERS = COMPOSER_TRANSFORMERS.filter(
  (transformer): transformer is ElementTransformer => transformer.type === 'element',
);

type DocPart =
  | { kind: 'text'; text: string }
  | { kind: 'reference'; reference: ComposerReferenceSegment };

function textPart(text: string): DocPart {
  return { kind: 'text', text };
}

function inlineCodeMarkdown(text: string): string {
  const runs = text.match(/`+/g);
  const longest = runs ? Math.max(...runs.map(run => run.length)) : 0;
  const fence = '`'.repeat(longest + 1);
  // CommonMark: a span that starts or ends with a backtick needs padding.
  const content = text.startsWith('`') || text.endsWith('`') ? ` ${text} ` : text;
  return fence + content + fence;
}

function textNodeMarkdown(node: TextNode): string {
  const text = node.getTextContent();
  if (!text) return '';
  if (node.hasFormat('code')) return inlineCodeMarkdown(text);
  const markers = (node.hasFormat('bold') ? '**' : '') + (node.hasFormat('italic') ? '*' : '');
  if (!markers) return text;
  // CommonMark flanking: markers must hug non-whitespace, so leading and
  // trailing spaces stay outside them.
  const match = text.match(/^(\s*)(\S(?:[\s\S]*\S)?)(\s*)$/);
  if (!match) return text;
  return match[1] + markers + match[2] + markers + match[3];
}

function appendInlineParts(node: ElementNode, parts: DocPart[]): void {
  for (const child of node.getChildren()) {
    if ($isReferenceNode(child)) {
      parts.push({ kind: 'reference', reference: child.reference() });
      continue;
    }
    if ($isLineBreakNode(child)) {
      parts.push(textPart('\n'));
      continue;
    }
    if ($isTextNode(child)) {
      parts.push(textPart(textNodeMarkdown(child)));
      continue;
    }
    if ($isLinkNode(child)) {
      const inner: DocPart[] = [];
      appendInlineParts(child, inner);
      const label = inner.map(part => (
        part.kind === 'text' ? part.text : `"${part.reference.label}"`
      )).join('');
      parts.push(textPart(`[${label}](${child.getURL()})`));
      continue;
    }
    if ($isElementNode(child)) {
      appendInlineParts(child, parts);
      continue;
    }
    parts.push(textPart(child.getTextContent()));
  }
}

// Applies `first` at the start of the parts and `next` after every soft
// newline inside text parts, so a chip keeps sitting between prefixed lines.
function prefixParts(parts: DocPart[], first: string, next: string): DocPart[] {
  const out: DocPart[] = [textPart(first)];
  for (const part of parts) {
    if (part.kind === 'reference') out.push(part);
    else out.push(textPart(part.text.replace(/\n/g, `\n${next}`)));
  }
  return out;
}

function listParts(list: ListNode, depth: number): DocPart[] {
  const parts: DocPart[] = [];
  const ordered = list.getListType() === 'number';
  const start = list.getStart();
  let index = 0;
  for (const item of list.getChildren()) {
    if (!$isListItemNode(item)) continue;
    if (parts.length > 0) parts.push(textPart('\n'));
    const marker = ordered ? `${start + index}. ` : '- ';
    index += 1;
    const indent = '  '.repeat(depth);
    const inline: DocPart[] = [];
    const nested: ListNode[] = [];
    for (const child of item.getChildren()) {
      if ($isListNode(child)) nested.push(child);
      else if ($isReferenceNode(child)) inline.push({ kind: 'reference', reference: child.reference() });
      else if ($isLineBreakNode(child)) inline.push(textPart('\n'));
      else if ($isTextNode(child)) inline.push(textPart(textNodeMarkdown(child)));
      else if ($isElementNode(child)) appendInlineParts(child, inline);
    }
    parts.push(...prefixParts(inline, indent + marker, indent + ' '.repeat(marker.length)));
    for (const nestedList of nested) {
      parts.push(textPart('\n'));
      parts.push(...listParts(nestedList, depth + 1));
    }
  }
  return parts;
}

function codeParts(node: CodeNode): DocPart[] {
  const inner: DocPart[] = [];
  for (const child of node.getChildren()) {
    if ($isReferenceNode(child)) inner.push({ kind: 'reference', reference: child.reference() });
    else if ($isLineBreakNode(child)) inner.push(textPart('\n'));
    else inner.push(textPart(child.getTextContent()));
  }
  const text = inner.map(part => part.kind === 'text' ? part.text : '').join('');
  const runs = text.match(/`{3,}/g);
  const longest = runs ? Math.max(...runs.map(run => run.length)) : 2;
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return [textPart(fence + (node.getLanguage() ?? '') + '\n'), ...inner, textPart('\n' + fence)];
}

function blockParts(node: LexicalNode): DocPart[] {
  if ($isHeadingNode(node)) {
    const inline: DocPart[] = [];
    appendInlineParts(node, inline);
    return [textPart('#'.repeat(Number(node.getTag().slice(1))) + ' '), ...inline];
  }
  if ($isQuoteNode(node)) {
    const inline: DocPart[] = [];
    appendInlineParts(node, inline);
    return prefixParts(inline, '> ', '> ');
  }
  if ($isCodeNode(node)) return codeParts(node);
  if ($isListNode(node)) return listParts(node, 0);
  if ($isElementNode(node)) {
    const inline: DocPart[] = [];
    appendInlineParts(node, inline);
    return inline;
  }
  if ($isReferenceNode(node)) return [{ kind: 'reference', reference: node.reference() }];
  return [textPart(node.getTextContent())];
}

function appendTextSegments(
  segments: ComposerDocument['segments'],
  text: string,
): void {
  if (!text) return;
  const previous = segments[segments.length - 1];
  if (previous?.type === 'text') previous.text += text;
  else segments.push({ type: 'text', text });
}

// Serializes the editor tree back to literal markdown so text segments carry
// the exact syntax the user typed (`# `, `- `, `**bold**`). Reference chips
// keep splitting text segments at their position, exactly as before.
function readDocument(): ComposerDocument {
  const parts: DocPart[] = [];
  const children = $getRoot().getChildren();
  children.forEach((child, index) => {
    if (index > 0) parts.push(textPart('\n\n'));
    parts.push(...blockParts(child));
  });
  const segments: ComposerDocument['segments'] = [];
  for (const part of parts) {
    if (part.kind === 'reference') segments.push(part.reference);
    else appendTextSegments(segments, part.text);
  }
  return normalizeComposerDocument({ version: 1, segments }) ?? { version: 1, segments: [] };
}

// The deepest trailing node that can hold inline content (where a restored
// chip belongs). Code blocks are excluded: chips there would corrupt the fence
// on the next export, so they fall back to a fresh paragraph instead.
function $trailingInlineContainer(): ElementNode | null {
  let node: LexicalNode | null = $getRoot().getLastChild();
  while (node) {
    if ($isListNode(node)) {
      node = node.getLastChild();
      continue;
    }
    if ($isQuoteNode(node)) return node;
    if ($isParagraphNode(node) || $isHeadingNode(node) || $isListItemNode(node)) return node;
    return null;
  }
  return null;
}

function writeDocument(documentValue: ComposerDocument): void {
  const root = $getRoot();
  root.clear();
  // True while the trailing block may still accept inline content: a chip or a
  // text segment without a leading newline continues it. Block separators live
  // inside text segments (`\n\n`), so a leading or trailing newline closes it.
  let openContainer = false;
  for (const segment of documentValue.segments) {
    if (segment.type === 'reference') {
      let target = openContainer ? $trailingInlineContainer() : null;
      if (!target) {
        target = $createParagraphNode();
        root.append(target);
      }
      target.append($createReferenceNode(segment));
      openContainer = true;
      continue;
    }
    const target = openContainer && !segment.text.startsWith('\n')
      ? $trailingInlineContainer()
      : null;
    // Markdown parsing drops whitespace-only runs, but a run between chips
    // (or the caret space after one) is part of the structured draft.
    if (/^[ \t]+$/.test(segment.text)) {
      const container = target ?? $createParagraphNode();
      if (!target) root.append(container);
      container.append($createTextNode(segment.text));
      openContainer = true;
      continue;
    }
    const nodes = $generateNodesFromMarkdownString(segment.text, COMPOSER_TRANSFORMERS);
    nodes.forEach((node, index) => {
      if (index === 0 && target && $isParagraphNode(node)) {
        target.append(...node.getChildren());
      } else {
        root.append(node);
      }
    });
    openContainer = segment.text.length > 0
      && !segment.text.startsWith('\n')
      && !segment.text.endsWith('\n');
  }
  if (root.getChildrenSize() === 0) root.append($createParagraphNode());
}

export interface InlineComposerEditorHandle {
  focus(): void;
  rootElement(): HTMLElement | null;
  setDocument(document: ComposerDocument): void;
  clear(): void;
  insertText(text: string): void;
  insertReference(reference: Omit<ComposerReferenceSegment, 'type'>): void;
  removeReference(id: string): void;
  deleteBackward(): void;
}

interface CommandPluginProps {
  onKeyDown?: (event: KeyboardEvent) => boolean;
  onPaste?: (event: ClipboardEvent) => boolean;
  /** True while the `@` file popover is open: arrow/Enter/Escape belong to
   *  the typeahead menu (registered at LOW priority), so the HIGH-priority
   *  handlers here must step aside by returning false. */
  fileMenuOpenRef: MutableRefObject<boolean>;
}

function lexicalClipboardReference(dataTransfer: DataTransfer): { namespace: string | null } | null {
  if (typeof dataTransfer.getData !== 'function') return null;
  const raw = dataTransfer.getData('application/x-lexical-editor');
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw) as { namespace?: unknown; nodes?: unknown };
    if (!Array.isArray(payload.nodes)) return null;
    const containsReference = (value: unknown): boolean => {
      if (!value || typeof value !== 'object') return false;
      const node = value as { type?: unknown; children?: unknown };
      return node.type === 'composer-reference'
        || (Array.isArray(node.children) && node.children.some(containsReference));
    };
    if (!payload.nodes.some(containsReference)) return null;
    return { namespace: typeof payload.namespace === 'string' ? payload.namespace : null };
  } catch {
    return null;
  }
}

function nativeClipboardData(event: ClipboardEvent | KeyboardEvent | null): DataTransfer | null {
  return event && 'clipboardData' in event ? event.clipboardData : null;
}

// Inline formats the caret must be able to escape at a segment boundary.
// Lexical syncs selection.format from the anchor text node on every native
// selection change, so a caret parked at the edge of a bold/italic/code run
// inherits its bits and typed text extends the run forever (the reported
// bold/inline-code stickiness). When the caret sits at a boundary whose
// neighbor does not continue the run (plain text, a reference chip, or the
// block edge), strip the ending bits from selection.format: the next
// insertion then takes Lexical's format-mismatch path and starts a plain
// sibling node instead of splicing into the formatted one. Interior carets
// keep the format; a caret at the very start of a block (no previous
// sibling) also keeps it, since the run deliberately begins there. Code
// fences own their text, so they are excluded.
const BOUNDARY_ESCAPABLE_FORMAT = IS_BOLD | IS_ITALIC | IS_CODE;

function BoundaryFormatPlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => editor.registerCommand(
    SELECTION_CHANGE_COMMAND,
    () => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
      const anchor = selection.anchor;
      if (anchor.type !== 'text') return false;
      const node = anchor.getNode();
      const nodeMask = node.getFormat() & BOUNDARY_ESCAPABLE_FORMAT;
      if (nodeMask === 0 || $isCodeNode(node.getParent())) return false;
      let ending = 0;
      if (anchor.offset === node.getTextContentSize()) {
        const next = node.getNextSibling();
        const nextMask = $isTextNode(next) ? next.getFormat() & BOUNDARY_ESCAPABLE_FORMAT : 0;
        ending |= nodeMask & ~nextMask;
      }
      if (anchor.offset === 0 && node.getPreviousSibling() !== null) {
        const prev = node.getPreviousSibling();
        const prevMask = $isTextNode(prev) ? prev.getFormat() & BOUNDARY_ESCAPABLE_FORMAT : 0;
        ending |= nodeMask & ~prevMask;
      }
      if (ending !== 0 && (selection.format & ending) !== 0) {
        selection.setFormat(selection.format & ~ending);
      }
      return false;
    },
    COMMAND_PRIORITY_LOW,
  ), [editor]);
  return null;
}

// MarkdownShortcutPlugin only converts a trigger typed at the start of a
// BLOCK (its element pass requires the anchor to be the block's first
// child). The composer's editing newline is Shift+Enter — a soft line break
// INSIDE the block — so a heading/quote/list trigger typed on a later visual
// line stayed literal text (owner report: `# 1` … `###### 6` on Shift+Enter
// lines never converted). This mirrors registerMarkdownShortcuts' typed-
// character guards and, when the caret sits at the start of a soft-wrapped
// line (the anchor's previous sibling is the line break), splits that line
// into its own block and runs the same element-transformer replace ritual.
function SoftLineElementMarkdownPlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => editor.registerUpdateListener(({ tags, dirtyLeaves, editorState, prevEditorState }) => {
    if (tags.has(COLLABORATION_TAG) || tags.has(HISTORIC_TAG)) return;
    if (editor.isComposing()) return;
    const isCompositionEnd = tags.has(COMPOSITION_END_TAG);
    const selection = editorState.read($getSelection);
    const prevSelection = prevEditorState.read($getSelection);
    if (
      !$isRangeSelection(prevSelection)
      || !$isRangeSelection(selection)
      || !selection.isCollapsed()
      || (selection.is(prevSelection) && !isCompositionEnd)
    ) return;
    const anchorKey = selection.anchor.key;
    const anchorOffset = selection.anchor.offset;
    const anchorNode = editorState._nodeMap.get(anchorKey);
    if (
      !$isTextNode(anchorNode)
      || !dirtyLeaves.has(anchorKey)
      || (!isCompositionEnd && anchorOffset !== 1 && anchorOffset > prevSelection.anchor.offset + 1)
    ) return;
    editor.update(() => {
      if ($convertSoftLineElement(anchorNode, anchorOffset)) {
        $addUpdateTag(HISTORY_PUSH_TAG);
      }
    });
  }), [editor]);
  return null;
}

function $convertSoftLineElement(anchorNode: TextNode, anchorOffset: number): boolean {
  if (anchorNode.hasFormat('code')) return false;
  const parentNode = anchorNode.getParent();
  if (parentNode === null || $isCodeNode(parentNode)) return false;
  if (!$isRootOrShadowRoot(parentNode.getParent())) return false;
  // Only soft-wrapped line starts; block starts are MarkdownShortcutPlugin's
  // job, and its listener is registered first.
  const lineBreak = anchorNode.getPreviousSibling();
  if (!$isLineBreakNode(lineBreak)) return false;
  const textContent = anchorNode.getTextContent();
  if (textContent[anchorOffset - 1] !== ' ') return false;
  for (const { regExp, replace } of COMPOSER_ELEMENT_TRANSFORMERS) {
    const match = textContent.match(regExp);
    const expectedMatchLength = match && match[0].endsWith(' ')
      ? anchorOffset
      : anchorOffset - 1;
    if (!match || match[0].length !== expectedMatchLength) continue;
    const lineBlock = $createParagraphNode();
    parentNode.insertAfter(lineBlock);
    lineBlock.append(anchorNode, ...anchorNode.getNextSiblings());
    lineBreak.remove();
    const nextSiblings = anchorNode.getNextSiblings();
    const [leadingNode, remainderNode] = anchorNode.splitText(anchorOffset);
    const siblings = remainderNode ? [remainderNode, ...nextSiblings] : nextSiblings;
    if (replace(lineBlock, siblings, match, false) === false) return false;
    leadingNode?.remove();
    return true;
  }
  return false;
}

function CommandPlugin({ onKeyDown, onPaste, namespace, fileMenuOpenRef }: CommandPluginProps & { namespace: string }) {
  const [editor] = useLexicalComposerContext();
  const keyRef = useRef(onKeyDown);
  const pasteRef = useRef(onPaste);
  const highlightedRef = useRef<Set<NodeKey>>(new Set());
  keyRef.current = onKeyDown;
  pasteRef.current = onPaste;

  useEffect(() => {
    const unregister = [
      KEY_ARROW_UP_COMMAND,
      KEY_ARROW_DOWN_COMMAND,
      KEY_ESCAPE_COMMAND,
      // Tab is forwarded so the `/` menu can accept a row without focus ever
      // leaving the editor; the handler returns false when no menu is open,
      // keeping Lexical's default Tab behavior.
      KEY_TAB_COMMAND,
    ].map(command => editor.registerCommand(
      command,
      event => {
        if (fileMenuOpenRef.current) return false;
        return event instanceof KeyboardEvent ? (keyRef.current?.(event) ?? false) : false;
      },
      COMMAND_PRIORITY_HIGH,
    ));
    unregister.push(editor.registerCommand(
      KEY_ENTER_COMMAND,
      event => {
        if (fileMenuOpenRef.current) return false;
        if (!(event instanceof KeyboardEvent)) return false;
        // Shift+Enter is the editing newline — it inherits what plain Enter
        // used to do inside markdown blocks: in a list item it opens the NEXT
        // item (INSERT_PARAGRAPH keeps the marker/numbering and the
        // exit-on-empty escape), in a code fence it inserts a code line, and
        // anywhere else Lexical's default Shift+Enter line break applies.
        // IME compositions keep ownership of the key.
        if (
          event.shiftKey
          && !event.metaKey
          && !event.ctrlKey
        ) {
          // IME compositions keep ownership of the key — no continuation, no
          // forwarding; Lexical's own composition layer handles the rest.
          if (event.isComposing) return false;
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return false;
          const anchor = selection.anchor.getNode();
          const chain = [anchor, ...anchor.getParents()];
          if (chain.some($isListItemNode)) {
            event.preventDefault();
            return editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
          }
          if (chain.some($isCodeNode)) {
            event.preventDefault();
            return editor.dispatchCommand(INSERT_LINE_BREAK_COMMAND, false);
          }
          return false;
        }
        // Enter submits from ANYWHERE — lists and code fences included (owner
        // contract); ⌘/Ctrl+Enter reaches onKeyDown the same way and the
        // container decides steer vs. send. onKeyDown owns the plain-Enter
        // IME guard.
        return keyRef.current?.(event) ?? false;
      },
      COMMAND_PRIORITY_HIGH,
    ));
    // Once a chip is selected (NodeSelection), ← / → collapse the caret to
    // the corresponding side of it so the cursor never gets stuck on a chip.
    for (const [command, forward] of [[KEY_ARROW_LEFT_COMMAND, false], [KEY_ARROW_RIGHT_COMMAND, true]] as const) {
      unregister.push(editor.registerCommand(
        command,
        event => {
          const selection = $getSelection();
          if (!$isNodeSelection(selection)) return false;
          const nodes = selection.getNodes();
          if (nodes.length !== 1 || !$isReferenceNode(nodes[0])) return false;
          event?.preventDefault();
          if (forward) nodes[0].selectNext();
          else nodes[0].selectPrevious();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ));
    }
    // MD-editor style two-step delete: the first Backspace/Delete next to a
    // reference SELECTS the chip (highlighted via `.is-selected`), the second
    // one actually removes it. Never a one-stroke atomic delete.
    unregister.push(editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      event => {
        const selection = $getSelection();
        if ($isNodeSelection(selection)) {
          const nodes = selection.getNodes();
          if (nodes.length === 0 || !nodes.every($isReferenceNode)) return false;
          event?.preventDefault();
          for (const node of nodes) node.remove();
          return true;
        }
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
        const anchor = selection.anchor.getNode();
        if (!$isTextNode(anchor)) return false;
        const previous = anchor.getPreviousSibling();
        if (!$isReferenceNode(previous)) return false;
        if (selection.anchor.offset > 0) {
          const before = anchor.getTextContent().slice(0, selection.anchor.offset);
          if (!/^\s+$/.test(before)) { console.log('[bs] before not ws'); return false; }
          anchor.spliceText(0, selection.anchor.offset, '');
        }
        event?.preventDefault();
        const nodeSelection = $createNodeSelection();
        nodeSelection.add(previous.getKey());
        $setSelection(nodeSelection);
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    ));
    unregister.push(editor.registerCommand(
      KEY_DELETE_COMMAND,
      event => {
        const selection = $getSelection();
        if ($isNodeSelection(selection)) {
          const nodes = selection.getNodes();
          if (nodes.length === 0 || !nodes.every($isReferenceNode)) return false;
          event?.preventDefault();
          for (const node of nodes) node.remove();
          return true;
        }
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
        const anchor = selection.anchor.getNode();
        if (!$isTextNode(anchor)) return false;
        const next = anchor.getNextSibling();
        if (!$isReferenceNode(next)) return false;
        if (selection.anchor.offset < anchor.getTextContentSize()) {
          const after = anchor.getTextContent().slice(selection.anchor.offset);
          if (!/^\s+$/.test(after)) return false;
          anchor.spliceText(selection.anchor.offset, after.length, '');
        }
        event?.preventDefault();
        const nodeSelection = $createNodeSelection();
        nodeSelection.add(next.getKey());
        $setSelection(nodeSelection);
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    ));
    // Sync the `.is-selected` highlight onto reference chip DOM elements so
    // the first delete/arrow step is visible (MD-editor selected-block look).
    unregister.push(editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const selection = $getSelection();
        const selected = new Set<NodeKey>();
        if ($isNodeSelection(selection)) {
          for (const node of selection.getNodes()) {
            if ($isReferenceNode(node)) selected.add(node.getKey());
          }
        }
        for (const key of highlightedRef.current) {
          if (!selected.has(key)) editor.getElementByKey(key)?.classList.remove('is-selected');
        }
        for (const key of selected) {
          editor.getElementByKey(key)?.classList.add('is-selected');
        }
        highlightedRef.current = selected;
      });
    }));
    unregister.push(editor.registerCommand(
      COPY_COMMAND,
      event => {
        const selection = $getSelection();
        const clipboardData = nativeClipboardData(event);
        if (!selection || selection.isCollapsed() || !clipboardData) return false;
        event?.preventDefault();
        setLexicalClipboardDataTransfer(
          clipboardData,
          $getClipboardDataFromSelection(selection),
        );
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    ));
    unregister.push(editor.registerCommand(
      CUT_COMMAND,
      event => {
        const selection = $getSelection();
        const clipboardData = nativeClipboardData(event);
        if (!$isRangeSelection(selection) || selection.isCollapsed() || !clipboardData) return false;
        event?.preventDefault();
        setLexicalClipboardDataTransfer(
          clipboardData,
          $getClipboardDataFromSelection(selection),
        );
        selection.removeText();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    ));
    unregister.push(editor.registerCommand(
      PASTE_COMMAND,
      event => {
        if (!event) return false;
        const clipboardEvent = event as ClipboardEvent;
        const clipboardData = nativeClipboardData(clipboardEvent);
        const selection = $getSelection();
        if (clipboardData && $isRangeSelection(selection)) {
          const referencePayload = lexicalClipboardReference(clipboardData);
          if (referencePayload) {
            clipboardEvent.preventDefault();
            if (referencePayload.namespace === namespace) {
              $insertDataTransferForRichText(clipboardData, selection, editor);
            } else {
              // A chip copied from another composer points at context items
              // this composer doesn't own; paste the quoted-label plain text
              // instead of a dangling reference.
              selection.insertText(clipboardData.getData('text/plain'));
            }
            return true;
          }
        }
        return pasteRef.current?.(clipboardEvent) ?? false;
      },
      COMMAND_PRIORITY_HIGH,
    ));
    return () => unregister.forEach(dispose => dispose());
  }, [editor, namespace, fileMenuOpenRef]);
  return null;
}

function $appendTarget(): ElementNode {
  const container = $trailingInlineContainer();
  if (container) return container;
  const paragraph = $createParagraphNode();
  $getRoot().append(paragraph);
  return paragraph;
}

// ── `@` file-reference typeahead ────────────────────────────────────────────

// The default typeahead punctuation set terminates the query on `/`, `.`,
// `-` and `_` — all common in file paths — so use a reduced set here.
const FILE_TRIGGER_PUNCTUATION = "\\,\\+\\*\\?\\$\\@\\|#{}\\(\\)\\^\\[\\]\\\\!%'\"~=<>_:;";

// Mirrors the `.cmp-file-pop` CSS max-width; used for right-edge clamping.
const FILE_POPOVER_MAX_WIDTH = 420;

class FileTypeaheadOption extends MenuOption {
  readonly file: ComposerFileOption;

  constructor(file: ComposerFileOption) {
    super(file.path);
    this.file = file;
  }
}

function ellipsizeMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

const FILE_ROW_ICON = (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M4 1.75h5l3 3V14.25H4z" stroke="currentColor" strokeWidth="1.2" />
    <path d="M9 1.75v3h3" stroke="currentColor" strokeWidth="1.2" />
  </svg>
);

interface FileMenuItemProps {
  selectedIndex: number | null;
  selectOptionAndCleanUp: (option: FileTypeaheadOption) => void;
  setHighlightedIndex: (index: number) => void;
  options: FileTypeaheadOption[];
}

function FileMentionMenu({
  loading,
  itemProps,
  matchingString,
  loadingLabel,
  emptyLabel,
  hintLabel,
  style,
}: {
  loading: boolean;
  itemProps: FileMenuItemProps;
  matchingString: string;
  loadingLabel: string;
  emptyLabel: string;
  hintLabel: string;
  style: CSSProperties;
}) {
  const { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex, options } = itemProps;
  // Repair the highlight after async loads: the library preselects only when
  // the query changes, which clamps the index to -1 while options are still
  // empty and never recovers once they arrive.
  useEffect(() => {
    if (options.length > 0 && (selectedIndex === null || selectedIndex < 0 || selectedIndex >= options.length)) {
      setHighlightedIndex(0);
    }
  }, [options, selectedIndex, setHighlightedIndex]);

  return (
    <div className="cmp-file-pop" role="listbox" style={style}>
      {loading ? (
        <div className="cmp-file-empty">{loadingLabel}</div>
      ) : options.length === 0 ? (
        <div className="cmp-file-empty">{emptyLabel}</div>
      ) : (
        options.map((option, index) => {
          const dir = option.file.relPath.includes('/')
            ? option.file.relPath.slice(0, option.file.relPath.lastIndexOf('/'))
            : '';
          return (
            <button
              key={option.key}
              type="button"
              ref={option.setRefElement}
              role="option"
              aria-selected={selectedIndex === index}
              className={`cmp-file-row${selectedIndex === index ? ' active' : ''}`}
              onPointerDown={event => {
                event.preventDefault();
                selectOptionAndCleanUp(option);
              }}
              onMouseEnter={() => setHighlightedIndex(index)}
            >
              <span className="cmp-file-icon" aria-hidden="true">{FILE_ROW_ICON}</span>
              <span className="cmp-file-name">{highlightMatch(option.file.name, matchingString)}</span>
              {dir && (
                <span className="cmp-file-path" title={option.file.relPath}>
                  {ellipsizeMiddle(dir, 48)}
                </span>
              )}
            </button>
          );
        })
      )}
      <div className="cmp-file-hint">{hintLabel}</div>
    </div>
  );
}

export interface ComposerFileReference {
  id: string;
  path: string;
  name: string;
}

function FileMentionPlugin({
  onFileQuery,
  onFileReference,
  menuOpenRef,
}: {
  onFileQuery: (query: string) => Promise<ComposerFileOption[]>;
  onFileReference: (file: ComposerFileReference) => void;
  menuOpenRef: MutableRefObject<boolean>;
}) {
  const [editor] = useLexicalComposerContext();
  const t = useT();
  const [query, setQuery] = useState<string | null>(null);
  // null = the query is in flight (loading row); [] = no matches (empty row).
  const [results, setResults] = useState<ComposerFileOption[] | null>(null);
  const queryRef = useRef(onFileQuery);
  queryRef.current = onFileQuery;
  const referenceRef = useRef(onFileReference);
  referenceRef.current = onFileReference;

  const triggerFn = useBasicTypeaheadTriggerMatch('@', {
    minLength: 0,
    maxLength: 100,
    punctuation: FILE_TRIGGER_PUNCTUATION,
  });

  useEffect(() => () => {
    menuOpenRef.current = false;
  }, [menuOpenRef]);

  useEffect(() => {
    if (query === null) {
      setResults(null);
      return;
    }
    let alive = true;
    void Promise.resolve()
      .then(() => queryRef.current(query))
      .then(list => { if (alive) setResults(list); })
      .catch(() => { if (alive) setResults([]); });
    return () => {
      alive = false;
    };
  }, [query]);

  const options = useMemo(
    () => (results ?? []).map(file => new FileTypeaheadOption(file)),
    [results],
  );

  const selectOption = useCallback((
    option: FileTypeaheadOption,
    nodeToRemove: TextNode | null,
    closeMenu: () => void,
  ) => {
    const id = crypto.randomUUID();
    editor.update(() => {
      const chip = $createReferenceNode({
        id,
        referenceType: 'context',
        label: option.file.name,
        kind: 'file',
      });
      const trailing = $createTextNode(' ');
      if (nodeToRemove) {
        nodeToRemove.replace(chip);
        chip.insertAfter(trailing);
      } else {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) selection.insertNodes([chip, trailing]);
        else $appendTarget().append(chip, trailing);
      }
      trailing.selectEnd();
    });
    closeMenu();
    referenceRef.current({ id, path: option.file.path, name: option.file.name });
  }, [editor]);

  return (
    <LexicalTypeaheadMenuPlugin<FileTypeaheadOption>
      onQueryChange={setQuery}
      onSelectOption={selectOption}
      onOpen={() => {
        menuOpenRef.current = true;
      }}
      onClose={() => {
        menuOpenRef.current = false;
      }}
      triggerFn={triggerFn}
      options={options}
      menuRenderFn={(anchorElementRef, itemProps, matchingString) => {
        const anchor = anchorElementRef.current;
        if (!anchor) return null;
        // The plugin parks its anchor div at the caret and would open the
        // menu DOWNWARD from it (its built-in flip compares against the
        // small contenteditable rect, so it never triggers for a composer
        // pinned to the window bottom). Instead portal to the body and
        // anchor UPWARD like the `+` and `/` menus: bottom edge just above
        // the composer box top, left edge at the caret, height clamped to
        // the space above. Read the caret from the live selection — the
        // plugin positions its anchor div in a post-render effect, so its
        // rect is stale on the first frame; fall back to it anyway.
        const selection = window.getSelection();
        const caretRect = selection && selection.rangeCount > 0
          ? selection.getRangeAt(0).getBoundingClientRect()
          : anchor.getBoundingClientRect();
        const composer = editor.getRootElement()?.closest('.composer');
        const composerTop = composer?.getBoundingClientRect().top ?? caretRect.top;
        const layout = upwardPopoverLayout({
          caretLeft: caretRect.left,
          composerTop,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          popoverWidth: FILE_POPOVER_MAX_WIDTH,
        });
        return createPortal(
          <FileMentionMenu
            loading={results === null}
            itemProps={itemProps}
            matchingString={matchingString}
            loadingLabel={t('composer.fileMention.loading')}
            emptyLabel={t('composer.fileMention.empty')}
            hintLabel={t('composer.fileMention.hint')}
            style={{ left: layout.left, bottom: layout.bottom, maxHeight: layout.maxHeight }}
          />,
          document.body,
        );
      }}
    />
  );
}

// A selection is only a live caret while the editor holds focus. Unfocused,
// jsdom and some browsers collapse it to the document start, which would
// silently insert chips/text at the wrong end of a restored draft.
function hasLiveCaret(editor: LexicalEditor): boolean {
  const rootElement = editor.getRootElement();
  const active = document.activeElement;
  return rootElement !== null && active !== null
    && (rootElement === active || rootElement.contains(active));
}

function EditorBridge({
  handleRef,
  disabled,
}: {
  handleRef: MutableRefObject<InlineComposerEditorHandle | null>;
  disabled: boolean;
}) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => editor.setEditable(!disabled), [disabled, editor]);
  useEffect(() => {
    const handle: InlineComposerEditorHandle = {
      focus: () => editor.focus(undefined, { defaultSelection: 'rootEnd' }),
      rootElement: () => editor.getRootElement(),
      setDocument: documentValue => editor.update(() => writeDocument(documentValue), { discrete: true }),
      clear: () => editor.update(() => writeDocument({ version: 1, segments: [] }), { discrete: true }),
      insertText: text => {
        editor.update(() => {
          const selection = $getSelection();
          if (hasLiveCaret(editor) && $isRangeSelection(selection)) {
            const node = $createTextNode(text);
            selection.insertNodes([node]);
            node.selectEnd();
            return;
          }
          const node = $createTextNode(text);
          $appendTarget().append(node);
          node.selectEnd();
        }, { discrete: true });
      },
      insertReference: reference => {
        editor.update(() => {
          const node = $createReferenceNode(reference);
          const trailing = $createTextNode(' ');
          const selection = $getSelection();
          if (hasLiveCaret(editor) && $isRangeSelection(selection)) {
            selection.insertNodes([node, trailing]);
          } else {
            $appendTarget().append(node, trailing);
          }
          trailing.selectEnd();
        }, { discrete: true });
      },
      removeReference: id => {
        editor.update(() => {
          const visit = (node: LexicalNode): boolean => {
            if ($isReferenceNode(node) && node.reference().id === id) {
              node.remove();
              return true;
            }
            if ($isElementNode(node)) {
              for (const child of node.getChildren()) {
                if (visit(child)) return true;
              }
            }
            return false;
          };
          visit($getRoot());
        }, { discrete: true });
      },
      deleteBackward: () => {
        editor.dispatchCommand(KEY_BACKSPACE_COMMAND, new KeyboardEvent('keydown', { key: 'Backspace' }));
      },
    };
    handleRef.current = handle;
    return () => {
      if (handleRef.current === handle) handleRef.current = null;
    };
  }, [editor, handleRef]);
  return null;
}

export interface InlineComposerEditorProps {
  initialDocument: ComposerDocument;
  disabled?: boolean;
  autoFocus?: boolean;
  placeholder: string;
  ariaLabel?: string;
  testId?: string;
  onChange: (document: ComposerDocument, userText: string) => void;
  onKeyDown?: (event: KeyboardEvent) => boolean;
  onPaste?: (event: ClipboardEvent) => boolean;
  onReferenceActivate?: (id: string, referenceType: ComposerReferenceSegment['referenceType'], anchorEl: HTMLElement) => void;
  /** Data source for the `@` file-reference popover. When omitted (or the
   *  editor is disabled), `@` stays plain text. */
  onFileQuery?: (query: string) => Promise<ComposerFileOption[]>;
  /** Called after the editor inserted a file chip: the container adds the
   *  matching `file` context item under the same id. */
  onFileReference?: (file: ComposerFileReference) => void;
}

export const InlineComposerEditor = forwardRef<InlineComposerEditorHandle, InlineComposerEditorProps>(
  function InlineComposerEditor({
    initialDocument,
    disabled = false,
    autoFocus = false,
    placeholder,
    ariaLabel,
    testId,
    onChange,
    onKeyDown,
    onPaste,
    onReferenceActivate,
    onFileQuery,
    onFileReference,
  }, forwardedRef) {
    const handleRef = useRef<InlineComposerEditorHandle | null>(null);
    const fileMenuOpenRef = useRef(false);
    useImperativeHandle(forwardedRef, () => ({
      focus: () => handleRef.current?.focus(),
      rootElement: () => handleRef.current?.rootElement() ?? null,
      setDocument: value => handleRef.current?.setDocument(value),
      clear: () => handleRef.current?.clear(),
      insertText: text => handleRef.current?.insertText(text),
      insertReference: reference => handleRef.current?.insertReference(reference),
      removeReference: id => handleRef.current?.removeReference(id),
      deleteBackward: () => handleRef.current?.deleteBackward(),
    }), []);
    const changeRef = useRef(onChange);
    changeRef.current = onChange;
    const namespaceRef = useRef(`GianComposer-${crypto.randomUUID()}`);

    const initialConfig = {
      namespace: namespaceRef.current,
      nodes: [
        ReferenceNode,
        HeadingNode,
        QuoteNode,
        ListNode,
        ListItemNode,
        LinkNode,
        CodeNode,
        CodeHighlightNode,
      ],
      editable: !disabled,
      editorState: () => writeDocument(initialDocument),
      onError(error: Error) {
        throw error;
      },
      theme: {
        paragraph: 'composer-rich-paragraph',
        heading: {
          h1: 'composer-md-h composer-md-h1',
          h2: 'composer-md-h composer-md-h2',
          h3: 'composer-md-h composer-md-h3',
          h4: 'composer-md-h composer-md-h4',
          h5: 'composer-md-h composer-md-h5',
          h6: 'composer-md-h composer-md-h6',
        },
        quote: 'composer-md-quote',
        code: 'composer-md-codeblock',
        list: {
          ul: 'composer-md-ul',
          ol: 'composer-md-ol',
          listitem: 'composer-md-li',
          nested: {
            listitem: 'composer-md-li-nested',
          },
        },
        link: 'composer-md-link',
        text: {
          bold: 'composer-md-bold',
          italic: 'composer-md-italic',
          code: 'composer-md-inline-code',
        },
      },
    };

    function activateReference(event: ReactMouseEvent<HTMLElement>): void {
      const target = event.target instanceof Element
        ? event.target.closest<HTMLElement>('[data-reference-id]')
        : null;
      const id = target?.dataset.referenceId;
      const referenceType = target?.dataset.referenceType;
      if (id && target && (referenceType === 'attachment' || referenceType === 'context')) {
        event.preventDefault();
        onReferenceActivate?.(id, referenceType, target);
      }
    }

    return (
      <LexicalComposer initialConfig={initialConfig}>
        <div className="composer-rich-wrap">
          <RichTextPlugin
            contentEditable={(
              <ContentEditable
                className="composer-rich-editor"
                data-testid={testId}
                aria-label={ariaLabel ?? placeholder}
                aria-placeholder={placeholder}
                placeholder={<div className="composer-rich-placeholder">{placeholder}</div>}
                onClick={activateReference}
              />
            )}
            ErrorBoundary={LexicalErrorBoundary}
          />
        </div>
        <HistoryPlugin />
        <ListPlugin />
        <MarkdownShortcutPlugin transformers={COMPOSER_TRANSFORMERS} />
        <SoftLineElementMarkdownPlugin />
        <BoundaryFormatPlugin />
        <OnChangePlugin
          ignoreSelectionChange
          onChange={(state: EditorState, _editor: LexicalEditor) => {
            state.read(() => {
              const documentValue = readDocument();
              changeRef.current(documentValue, composerDocumentUserText(documentValue));
            });
          }}
        />
        <CommandPlugin
          namespace={namespaceRef.current}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          fileMenuOpenRef={fileMenuOpenRef}
        />
        <EditorBridge handleRef={handleRef} disabled={disabled} />
        {!disabled && onFileQuery && onFileReference && (
          <FileMentionPlugin
            onFileQuery={onFileQuery}
            onFileReference={onFileReference}
            menuOpenRef={fileMenuOpenRef}
          />
        )}
        {autoFocus && <AutoFocusPlugin />}
      </LexicalComposer>
    );
  },
);

function AutoFocusPlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => editor.focus(undefined, { defaultSelection: 'rootEnd' }), [editor]);
  return null;
}
