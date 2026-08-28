import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { MessageContextItem } from '@gian/shared';
import { fmtBytes } from '../../attachments.js';
import { useT } from '../../i18n/index.js';
import { MarkdownText } from '../../transcript/items.js';

const PREVIEW_LINES = 30;

/** Anchor rectangle for a reference chip (a DOMRect satisfies this). */
export interface ReferenceAnchor {
  left: number;
  top: number;
  bottom: number;
}

/**
 * Floating card anchored to an inline reference chip. Portaled to <body>,
 * positioned above the chip when there is room, below otherwise. Closes on
 * outside pointer-down (clicks on the anchor chip itself are left to the
 * chip's own toggle handler), Escape, scroll, and resize.
 */
export function ReferencePopover({
  anchor,
  anchorEl,
  onClose,
  width = 340,
  children,
}: {
  anchor: ReferenceAnchor;
  anchorEl?: Element | null;
  onClose: () => void;
  width?: number;
  children: ReactNode;
}) {
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const pop = popRef.current;
    if (!pop) return;
    const reposition = () => {
      const rect = pop.getBoundingClientRect();
      const left = Math.max(8, Math.min(anchor.left, window.innerWidth - rect.width - 8));
      const aboveTop = anchor.top - 6 - rect.height;
      const top = aboveTop >= 8
        ? aboveTop
        : Math.max(8, Math.min(anchor.bottom + 6, window.innerHeight - rect.height - 8));
      setPos(previous => (previous && previous.left === left && previous.top === top)
        ? previous
        : { left, top });
    };
    reposition();
    // Content arrives async (image thumbnails, markdown reflow): re-anchor
    // whenever the popover's size changes, or the first open lands wrong.
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(reposition);
    observer.observe(pop);
    return () => observer.disconnect();
  }, [anchor]);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (popRef.current?.contains(target)) return;
      if (anchorEl?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    // Scrolls INSIDE the popover (e.g. a long preview's own scroll area)
    // must not close it — only scrolls of the page behind it do.
    const onScroll = (event: Event) => {
      if (popRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [anchorEl, onClose]);

  return createPortal(
    <div
      ref={popRef}
      className="ref-pop"
      role="dialog"
      style={pos
        ? { left: pos.left, top: pos.top, width }
        : { left: -9999, top: -9999, width, visibility: 'hidden' }}
    >
      {children}
    </div>,
    document.body,
  );
}

export function ReferencePopoverHead({
  icon,
  title,
  onRemove,
  removeLabel,
  onClose,
}: {
  icon: ReactNode;
  title: string;
  onRemove?: () => void;
  removeLabel?: string;
  onClose: () => void;
}) {
  const t = useT();
  const removeText = removeLabel ?? t('composer.context.remove');
  return (
    <div className="ref-pop-head">
      <span className="ref-pop-icon" aria-hidden="true">{icon}</span>
      <span className="ref-pop-title">{title}</span>
      {onRemove && (
        <button type="button" className="ref-pop-remove" onClick={() => { onRemove(); onClose(); }}>
          {removeText}
        </button>
      )}
      <button
        type="button"
        className="ref-pop-close"
        onClick={onClose}
        aria-label={t('common.close')}
      >
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="m4.5 4.5 7 7m0-7-7 7" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

export const REFERENCE_ICONS = {
  folder: (
    <svg viewBox="0 0 16 16" fill="none">
      <path d="M1.75 4.25h4l1.2 1.5h7.3v7.5H1.75z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M1.75 5.75v-3h4l1.2 1.5h3" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  ),
  browserElement: (
    <svg viewBox="0 0 16 16" fill="none">
      <path d="M2.25 6V2.25H6M10 2.25h3.75V6M13.75 10v3.75H10M6 13.75H2.25V10M5.25 5.25h5.5v5.5h-5.5z" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  pastedText: (
    <svg viewBox="0 0 16 16" fill="none">
      <path d="M3 1.75h10v12.5H3zM5.25 5h5.5M5.25 7.75h5.5M5.25 10.5h3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  ),
  file: (
    <svg viewBox="0 0 16 16" fill="none">
      <path d="M4 1.75h5l3 3V14.25H4z" stroke="currentColor" strokeWidth="1.2" />
      <path d="M9 1.75v3h3" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  ),
};

function clipLines(text: string): string {
  return text.split(/\r\n|\r|\n/).slice(0, PREVIEW_LINES).join('\n');
}

/** Floating detail card for a context reference (browser element, pasted
 *  text, folder). Used by the composer, the transcript, and the queue. */
export function ContextReferencePopover({
  item,
  anchor,
  anchorEl,
  onClose,
  onRemove,
}: {
  item: MessageContextItem;
  anchor: ReferenceAnchor;
  anchorEl?: Element | null;
  onClose: () => void;
  onRemove?: (id: string) => void;
}) {
  const t = useT();
  const title = item.type === 'folder'
    ? item.name
    : item.type === 'browserElement'
      ? t('composer.context.browserElement')
      : item.origin === 'selection'
        ? t('composer.context.quote')
        : t('composer.context.pastedText');
  return (
    <ReferencePopover anchor={anchor} anchorEl={anchorEl} onClose={onClose}>
      <ReferencePopoverHead
        icon={REFERENCE_ICONS[item.type]}
        title={title}
        onRemove={onRemove ? () => onRemove(item.id) : undefined}
        onClose={onClose}
      />
      <div className="ref-pop-body">
        {item.type === 'browserElement' && (
          <>
            {item.pageTitle && <span className="ref-pop-page">{item.pageTitle}</span>}
            <span className="ref-pop-url" title={item.pageUrl}>{item.pageUrl}</span>
            <code className="ref-pop-selector" title={item.selector}>{item.selector}</code>
            {item.snippet && <pre className="ref-pop-snippet">{clipLines(item.snippet)}</pre>}
          </>
        )}
        {item.type === 'pastedText' && (
          <>
            <span className="ref-pop-url">
              {t('composer.context.pastedMeta')
                .replace('{lines}', String(item.lineCount))
                .replace('{size}', fmtBytes(item.byteSize))}
            </span>
            <div className="ref-pop-snippet ref-pop-md msg-text md">
              <MarkdownText>{item.text}</MarkdownText>
            </div>
          </>
        )}
        {item.type === 'folder' && (
          <span className="ref-pop-url" title={item.path}>{item.path}</span>
        )}
      </div>
    </ReferencePopover>
  );
}
