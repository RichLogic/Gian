import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { MAX_PASTED_TEXT_BYTES } from '@gian/shared';

import { useT } from '../i18n/index.js';
import {
  selectedTextByteSize,
  type TranscriptTextSelection,
} from './selection-context.js';

export interface TranscriptSelectionAction {
  enabled: boolean;
  reason?: string;
  run: (selection: TranscriptTextSelection) => void;
}

export interface TranscriptSelectionActionsConfig {
  addToChat: TranscriptSelectionAction;
  askInSideChat: TranscriptSelectionAction;
}

interface VisibleSelection extends TranscriptTextSelection {
  left: number;
  top: number;
  below: boolean;
}

const SELECTABLE = '[data-transcript-selectable="true"]';
const VIEWPORT_EDGE = 12;
const TOOLBAR_CLEARANCE = 8;
const TOOLBAR_HEIGHT_ESTIMATE = 42;
const TOOLBAR_HALF_WIDTH_ESTIMATE = 150;

function selectableAncestor(node: Node | null, root: HTMLElement): HTMLElement | null {
  if (!node) return null;
  const element = node.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement;
  const selectable = element?.closest<HTMLElement>(SELECTABLE) ?? null;
  return selectable && root.contains(selectable) ? selectable : null;
}

function readSelection(root: HTMLElement): VisibleSelection | null {
  const nativeSelection = window.getSelection();
  if (!nativeSelection || nativeSelection.isCollapsed || nativeSelection.rangeCount === 0) return null;
  const start = selectableAncestor(nativeSelection.anchorNode, root);
  const end = selectableAncestor(nativeSelection.focusNode, root);
  if (!start || start !== end) return null;

  const text = nativeSelection.toString();
  if (text.trim().length === 0) return null;
  const sourceId = start.dataset.transcriptSourceId;
  const sourceKind = start.dataset.transcriptSourceKind;
  const turn = Number(start.dataset.transcriptTurn);
  if (!sourceId || (sourceKind !== 'user' && sourceKind !== 'assistant') || !Number.isFinite(turn)) {
    return null;
  }

  const range = nativeSelection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top)) return null;
  const below = rect.top < TOOLBAR_HEIGHT_ESTIMATE + TOOLBAR_CLEARANCE;
  const halfWidth = Math.min(
    TOOLBAR_HALF_WIDTH_ESTIMATE,
    Math.max(0, (window.innerWidth - VIEWPORT_EDGE * 2) / 2),
  );
  return {
    text,
    sourceId,
    sourceKind,
    turn,
    left: Math.min(
      window.innerWidth - VIEWPORT_EDGE - halfWidth,
      Math.max(VIEWPORT_EDGE + halfWidth, rect.left + rect.width / 2),
    ),
    top: below ? rect.bottom + TOOLBAR_CLEARANCE : rect.top - TOOLBAR_CLEARANCE,
    below,
  };
}

function clearNativeSelection(): void {
  window.getSelection()?.removeAllRanges();
}

export function TranscriptSelectionActions({
  rootRef,
  actions,
  validSourceIds,
}: {
  rootRef: RefObject<HTMLDivElement | null>;
  actions: TranscriptSelectionActionsConfig;
  validSourceIds: ReadonlySet<string>;
}) {
  const t = useT();
  const toolbarRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | null>(null);
  const [visible, setVisible] = useState<VisibleSelection | null>(null);

  const refresh = useCallback(() => {
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      const root = rootRef.current;
      setVisible(root ? readSelection(root) : null);
    });
  }, [rootRef]);

  useEffect(() => {
    document.addEventListener('selectionchange', refresh);
    return () => {
      document.removeEventListener('selectionchange', refresh);
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    };
  }, [refresh]);

  useEffect(() => {
    if (!visible) return;
    const close = () => setVisible(null);
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && toolbarRef.current?.contains(event.target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
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
  }, [visible]);

  useEffect(() => {
    if (visible && !validSourceIds.has(visible.sourceId)) setVisible(null);
  }, [validSourceIds, visible]);

  if (!visible) return null;
  const tooLarge = selectedTextByteSize(visible.text) > MAX_PASTED_TEXT_BYTES;
  const placement = visible.below ? 'below' : 'above';
  const run = (action: TranscriptSelectionAction) => {
    if (!action.enabled || tooLarge) return;
    action.run(visible);
    clearNativeSelection();
    setVisible(null);
  };
  const titleFor = (action: TranscriptSelectionAction): string | undefined =>
    tooLarge ? t('transcript.selection.tooLarge') : action.reason;

  return createPortal(
    <div
      ref={toolbarRef}
      className={`transcript-selection-actions is-${placement}`}
      role="toolbar"
      aria-label={t('transcript.selection.actions')}
      data-testid="transcript-selection-actions"
      style={{ left: visible.left, top: visible.top }}
      onMouseDown={event => event.preventDefault()}
    >
      <button
        type="button"
        disabled={!actions.addToChat.enabled || tooLarge}
        title={titleFor(actions.addToChat)}
        onClick={() => run(actions.addToChat)}
      >
        {t('transcript.selection.addToChat')}
      </button>
      <span className="transcript-selection-divider" aria-hidden="true" />
      <button
        type="button"
        disabled={!actions.askInSideChat.enabled || tooLarge}
        title={titleFor(actions.askInSideChat)}
        onClick={() => run(actions.askInSideChat)}
      >
        {t('transcript.selection.askInSideChat')}
      </button>
    </div>,
    document.body,
  );
}
