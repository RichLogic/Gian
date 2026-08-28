import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
} from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin';
import {
  $getClipboardDataFromSelection,
  $insertDataTransferForRichText,
  setLexicalClipboardDataTransfer,
} from '@lexical/clipboard';
import {
  $applyNodeReplacement,
  $createNodeSelection,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isLineBreakNode,
  $isNodeSelection,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  COMMAND_PRIORITY_HIGH,
  COPY_COMMAND,
  CUT_COMMAND,
  DecoratorNode,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  PASTE_COMMAND,
  type EditorState,
  type LexicalEditor,
  type LexicalNode,
  type LexicalUpdateJSON,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import type {
  ComposerDocument,
  ComposerReferenceSegment,
} from '@gian/shared';
import {
  composerDocumentUserText,
  normalizeComposerDocument,
} from '@gian/shared';

type SerializedReferenceNode = Spread<{
  referenceId: string;
  referenceType: ComposerReferenceSegment['referenceType'];
  label: string;
}, SerializedLexicalNode>;

class ReferenceNode extends DecoratorNode<null> {
  __referenceId: string;
  __referenceType: ComposerReferenceSegment['referenceType'];
  __label: string;

  static override getType(): string {
    return 'composer-reference';
  }

  static override clone(node: ReferenceNode): ReferenceNode {
    return new ReferenceNode(node.__referenceId, node.__referenceType, node.__label, node.__key);
  }

  static override importJSON(serialized: SerializedReferenceNode): ReferenceNode {
    return $createReferenceNode({
      id: serialized.referenceId,
      referenceType: serialized.referenceType,
      label: serialized.label,
    }).updateFromJSON(serialized);
  }

  constructor(
    referenceId: string,
    referenceType: ComposerReferenceSegment['referenceType'],
    label: string,
    key?: NodeKey,
  ) {
    super(key);
    this.__referenceId = referenceId;
    this.__referenceType = referenceType;
    this.__label = label;
  }

  override afterCloneFrom(previous: this): void {
    super.afterCloneFrom(previous);
    this.__referenceId = previous.__referenceId;
    this.__referenceType = previous.__referenceType;
    this.__label = previous.__label;
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
    };
  }

  override createDOM(): HTMLElement {
    const element = document.createElement('span');
    element.className = 'composer-inline-reference';
    element.dataset.referenceId = this.__referenceId;
    element.dataset.referenceType = this.__referenceType;
    element.setAttribute('role', 'button');
    element.setAttribute('aria-label', this.__label);
    element.setAttribute('contenteditable', 'false');
    const label = document.createElement('span');
    label.className = 'cir-label';
    label.textContent = this.__label;
    // Context chips get their '@' glyph from CSS ::before so the editor's
    // text content stays clean; attachments carry a real file icon.
    if (this.__referenceType === 'attachment') {
      const glyph = document.createElement('span');
      glyph.className = 'cir-glyph';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.innerHTML = '<svg viewBox="0 0 16 16" fill="none"><path d="M4 1.75h5l3 3V14.25H4z" stroke="currentColor" stroke-width="1.2"/><path d="M9 1.75v3h3" stroke="currentColor" stroke-width="1.2"/></svg>';
      element.append(glyph, label);
    } else {
      element.append(label);
    }
    return element;
  }

  override updateDOM(previous: ReferenceNode, element: HTMLElement): boolean {
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
    };
  }
}

function $createReferenceNode(reference: Omit<ComposerReferenceSegment, 'type'>): ReferenceNode {
  return $applyNodeReplacement(new ReferenceNode(
    reference.id,
    reference.referenceType,
    reference.label,
  ));
}

function $isReferenceNode(node: LexicalNode | null | undefined): node is ReferenceNode {
  return node instanceof ReferenceNode;
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

function readNode(node: LexicalNode, segments: ComposerDocument['segments']): void {
  if ($isReferenceNode(node)) {
    segments.push(node.reference());
    return;
  }
  if ($isLineBreakNode(node)) {
    appendTextSegments(segments, '\n');
    return;
  }
  if ($isElementNode(node)) {
    for (const child of node.getChildren()) readNode(child, segments);
    return;
  }
  appendTextSegments(segments, node.getTextContent());
}

function readDocument(): ComposerDocument {
  const segments: ComposerDocument['segments'] = [];
  const children = $getRoot().getChildren();
  children.forEach((child, index) => {
    if (index > 0) appendTextSegments(segments, '\n');
    readNode(child, segments);
  });
  return normalizeComposerDocument({ version: 1, segments }) ?? { version: 1, segments: [] };
}

function writeDocument(documentValue: ComposerDocument): void {
  const root = $getRoot();
  root.clear();
  let paragraph = $createParagraphNode();
  root.append(paragraph);
  for (const segment of documentValue.segments) {
    if (segment.type === 'reference') {
      paragraph.append($createReferenceNode(segment));
      continue;
    }
    const lines = segment.text.split('\n');
    lines.forEach((line, index) => {
      if (index > 0) {
        paragraph = $createParagraphNode();
        root.append(paragraph);
      }
      if (line) paragraph.append($createTextNode(line));
    });
  }
  paragraph.selectEnd();
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
}

function lexicalClipboardContainsReference(dataTransfer: DataTransfer, namespace: string): boolean {
  if (typeof dataTransfer.getData !== 'function') return false;
  const raw = dataTransfer.getData('application/x-lexical-editor');
  if (!raw) return false;
  try {
    const payload = JSON.parse(raw) as { namespace?: unknown; nodes?: unknown };
    if (payload.namespace !== namespace || !Array.isArray(payload.nodes)) return false;
    const containsReference = (value: unknown): boolean => {
      if (!value || typeof value !== 'object') return false;
      const node = value as { type?: unknown; children?: unknown };
      return node.type === 'composer-reference'
        || (Array.isArray(node.children) && node.children.some(containsReference));
    };
    return payload.nodes.some(containsReference);
  } catch {
    return false;
  }
}

function nativeClipboardData(event: ClipboardEvent | KeyboardEvent | null): DataTransfer | null {
  return event && 'clipboardData' in event ? event.clipboardData : null;
}

function CommandPlugin({ onKeyDown, onPaste, namespace }: CommandPluginProps & { namespace: string }) {
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
    ].map(command => editor.registerCommand(
      command,
      event => event instanceof KeyboardEvent ? (keyRef.current?.(event) ?? false) : false,
      COMMAND_PRIORITY_HIGH,
    ));
    unregister.push(editor.registerCommand(
      KEY_ENTER_COMMAND,
      event => event instanceof KeyboardEvent ? (keyRef.current?.(event) ?? false) : false,
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
        if (
          clipboardData
          && $isRangeSelection(selection)
          && lexicalClipboardContainsReference(clipboardData, namespace)
        ) {
          clipboardEvent.preventDefault();
          $insertDataTransferForRichText(clipboardData, selection, editor);
          return true;
        }
        return pasteRef.current?.(clipboardEvent) ?? false;
      },
      COMMAND_PRIORITY_HIGH,
    ));
    return () => unregister.forEach(dispose => dispose());
  }, [editor, namespace]);
  return null;
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
      focus: () => editor.focus(),
      rootElement: () => editor.getRootElement(),
      setDocument: documentValue => editor.update(() => writeDocument(documentValue), { discrete: true }),
      clear: () => editor.update(() => writeDocument({ version: 1, segments: [] }), { discrete: true }),
      insertText: text => {
        editor.update(() => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            const node = $createTextNode(text);
            selection.insertNodes([node]);
            node.selectEnd();
            return;
          }
          const last = $getRoot().getLastChild();
          const paragraph = $isElementNode(last) ? last : $createParagraphNode();
          if (!$isElementNode(last)) $getRoot().append(paragraph);
          const node = $createTextNode(text);
          paragraph.append(node);
          node.selectEnd();
        }, { discrete: true });
      },
      insertReference: reference => {
        editor.update(() => {
          const node = $createReferenceNode(reference);
          const trailing = $createTextNode(' ');
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.insertNodes([node, trailing]);
            trailing.selectEnd();
          } else {
            const last = $getRoot().getLastChild();
            const paragraph = $isElementNode(last) ? last : $createParagraphNode();
            if (!$isElementNode(last)) {
              $getRoot().append(paragraph);
            }
            paragraph.append(node, trailing);
            trailing.selectEnd();
          }
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
  }, forwardedRef) {
    const handleRef = useRef<InlineComposerEditorHandle | null>(null);
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
      nodes: [ReferenceNode],
      editable: !disabled,
      editorState: () => writeDocument(initialDocument),
      onError(error: Error) {
        throw error;
      },
      theme: {
        paragraph: 'composer-rich-paragraph',
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
          <PlainTextPlugin
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
        />
        <EditorBridge handleRef={handleRef} disabled={disabled} />
        {autoFocus && <AutoFocusPlugin />}
      </LexicalComposer>
    );
  },
);

function AutoFocusPlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => editor.focus(), [editor]);
  return null;
}
