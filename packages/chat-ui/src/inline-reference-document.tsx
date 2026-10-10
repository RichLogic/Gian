import { useCallback, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ComposerDocument, ComposerReferenceSegment, MessageContextItem } from '@gian/shared';
import {
  ContextReferencePopover,
  ReferencePopover,
  ReferencePopoverHead,
  REFERENCE_ICONS,
  useHoverPreview,
} from './reference-popover.js';
import type { ReferenceAnchor } from './reference-popover.js';
import { formatBytes, isNativeImageMime } from './utils.js';
import { useChatUiT } from './i18n.js';
import { MarkdownText, inlineSlotToken } from './markdown.js';

export interface InlineReferenceAttachment {
  name: string;
  mime?: string;
  size?: number;
  url?: string;
}

function contextTitle(item: MessageContextItem | undefined, fallback: string): string {
  if (!item) return fallback;
  if (item.type === 'folder') return item.path;
  if (item.type === 'file') return item.path;
  if (item.type === 'session') return item.workspaceName ?? item.title;
  if (item.type === 'browserElement') {
    return [item.name, item.selector, item.pageUrl].filter(Boolean).join(' - ');
  }
  return `${item.lineCount} lines`;
}

export function InlineReferenceDocument({
  document,
  attachments = [],
  contextItems = [],
  className,
  onAttachmentActivate,
}: {
  document: ComposerDocument;
  attachments?: InlineReferenceAttachment[];
  contextItems?: MessageContextItem[];
  className?: string;
  onAttachmentActivate?: (attachment: InlineReferenceAttachment) => boolean;
}) {
  const t = useChatUiT();
  // Chips preview on hover AND click (2026-09-09 owner call): hover opens
  // after a short delay and closes when the pointer leaves both chip and
  // popover; clicking pins the popover open (click again toggles).
  const hover = useHoverPreview();
  // Clicking a chip opens a floating detail card anchored to it — context
  // chips get the context popover, attachment chips the same file popover the
  // composer uses (icon + name + Close, image thumbnail, size, download).
  const [preview, setPreview] = useState<{
    id: string;
    anchor: ReferenceAnchor;
    anchorEl: Element;
  } | null>(null);
  const [attachmentPreview, setAttachmentPreview] = useState<{
    key: string;
    attachment: InlineReferenceAttachment;
    label: string;
    /** Document-order attachment number (1-based) — the same N the compiled
     *  prompt's [Attached resource N] uses. */
    index: number;
    anchor: ReferenceAnchor;
    anchorEl: Element;
  } | null>(null);
  const previewItem = preview
    ? contextItems.find(item => item.id === preview.id) ?? null
    : null;
  const attachmentIndexes = new Map<string, number>();
  const renderChip = (segment: ComposerReferenceSegment, index: number): ReactNode => {
        if (segment.referenceType === 'context') {
          const contextItem = contextItems.find(item => item.id === segment.id);
          const referenceGlyph = (kind: 'file' | 'session') => (
            <span className="mir-glyph" aria-hidden="true">{REFERENCE_ICONS[kind]}</span>
          );
          if (!contextItem) {
            const kind = segment.kind === 'file' || segment.kind === 'session' ? segment.kind : null;
            return (
              <span
                key={`${segment.id}-${index}`}
                className="message-inline-reference"
                data-reference-id={segment.id}
                data-reference-type="context"
                {...(kind ? { 'data-reference-kind': kind } : {})}
                title={segment.label}
              >
                {kind && referenceGlyph(kind)}
                <span className="mir-label">{segment.label}</span>
              </span>
            );
          }
          const itemKind = contextItem.type === 'file' || contextItem.type === 'session'
            ? contextItem.type
            : null;
          return (
            <button
              key={`${segment.id}-${index}`}
              type="button"
              className="message-inline-reference"
              data-reference-id={segment.id}
              data-reference-type="context"
              {...(itemKind ? { 'data-reference-kind': itemKind } : {})}
              title={contextTitle(contextItem, segment.label)}
              onMouseEnter={event => {
                const el = event.currentTarget;
                hover.scheduleOpen(() => setPreview({ id: segment.id, anchor: el.getBoundingClientRect(), anchorEl: el }));
              }}
              onMouseLeave={() => hover.scheduleClose(() => setPreview(null))}
              // 2026-09-10 owner call: hover (or keyboard focus) previews;
              // a plain click does nothing.
              onFocus={event => {
                const el = event.currentTarget;
                hover.scheduleOpen(() => setPreview({ id: segment.id, anchor: el.getBoundingClientRect(), anchorEl: el }));
              }}
              onBlur={() => hover.scheduleClose(() => setPreview(null))}
            >
              {itemKind && referenceGlyph(itemKind)}
              <span className="mir-label">{segment.label}</span>
            </button>
          );
        }
        let attachmentIndex = attachmentIndexes.get(segment.id);
        if (attachmentIndex === undefined) {
          attachmentIndex = attachmentIndexes.size;
          attachmentIndexes.set(segment.id, attachmentIndex);
        }
        const attachment = attachments[attachmentIndex];
        const glyph = (
          <span className="mir-glyph" aria-hidden="true">{REFERENCE_ICONS.file}</span>
        );
        if (attachment?.url) {
          const key = `${segment.id}-${index}`;
          // Image chips (2026-09-10 owner call): hover shows the preview
          // popover; a CLICK goes straight to the lightbox. Non-image chips
          // preview on hover/focus only — a plain click does nothing (the
          // download link lives inside the hover popover).
          const image = isNativeImageMime(attachment.mime ?? '');
          return (
            <button
              key={key}
              type="button"
              className="message-inline-reference"
              data-reference-id={segment.id}
              data-reference-type="attachment"
              title={attachment.name}
              onMouseEnter={event => {
                const el = event.currentTarget;
                hover.scheduleOpen(() => setAttachmentPreview({ key, attachment, label: segment.label, index: attachmentIndex, anchor: el.getBoundingClientRect(), anchorEl: el }));
              }}
              onMouseLeave={() => hover.scheduleClose(() => setAttachmentPreview(null))}
              onFocus={event => {
                const el = event.currentTarget;
                hover.scheduleOpen(() => setAttachmentPreview({ key, attachment, label: segment.label, index: attachmentIndex, anchor: el.getBoundingClientRect(), anchorEl: el }));
              }}
              onBlur={() => hover.scheduleClose(() => setAttachmentPreview(null))}
              onClick={() => {
                if (image && onAttachmentActivate?.(attachment)) return;
              }}
            >
              {glyph}
              <span className="mir-label">{segment.label}</span>
            </button>
          );
        }
        return (
          <span
            key={`${segment.id}-${index}`}
            className="message-inline-reference"
            data-reference-id={segment.id}
            data-reference-type="attachment"
            title={attachment?.name ?? segment.label}
          >
            {glyph}
            <span className="mir-label">{segment.label}</span>
          </span>
        );
  };

  // The composer document renders as ONE markdown source: reference chips and
  // whitespace-only runs become inline slot tokens that the pipeline swaps
  // back for the real chip widgets, so block constructs (lists, headings,
  // quotes) spanning a chip stay intact (2026-10-09 owner report: a "1. "
  // before an image chip parsed as an empty list item and wrapped onto its
  // own line). Pure whitespace runs never touch the parser — leading
  // spaces/tabs could otherwise read as an indented code block.
  const slots = new Map<number, ReactNode>();
  const source = document.segments.map((segment, index) => {
    if (segment.type === 'text' && !/^[ \t]+$/.test(segment.text)) return segment.text;
    slots.set(index, segment.type === 'text' ? segment.text : renderChip(segment, index));
    return inlineSlotToken(index);
  }).join('');
  // renderSlot must stay referentially stable (paired with the memoized
  // components map in MarkdownText): read the latest slots through a ref so
  // re-renders never change the md-slot component identity.
  const slotsRef = useRef<Map<number, ReactNode>>(new Map());
  slotsRef.current = slots;
  const renderSlot = useCallback((index: number) => slotsRef.current.get(index) ?? null, []);
  return (
    <span className={className ? `inline-reference-document ${className}` : 'inline-reference-document'}>
      <span className="user-md-seg">
        <MarkdownText preserveBoundarySpaces renderSlot={renderSlot}>
          {source}
        </MarkdownText>
      </span>
      {preview && previewItem && (
        <ContextReferencePopover
          item={previewItem}
          anchor={preview.anchor}
          anchorEl={preview.anchorEl}
          onClose={() => setPreview(null)}
          onMouseEnter={hover.cancelClose}
          onMouseLeave={() => hover.scheduleClose(() => setPreview(null))}
        />
      )}
      {attachmentPreview && (
        <ReferencePopover
          anchor={attachmentPreview.anchor}
          anchorEl={attachmentPreview.anchorEl}
          onClose={() => setAttachmentPreview(null)}
          onMouseEnter={hover.cancelClose}
          onMouseLeave={() => hover.scheduleClose(() => setAttachmentPreview(null))}
        >
          <ReferencePopoverHead
            icon={REFERENCE_ICONS.file}
            title={attachmentPreview.attachment.name || attachmentPreview.label}
            onClose={() => setAttachmentPreview(null)}
          />
          <div className="ref-pop-body">
            {isNativeImageMime(attachmentPreview.attachment.mime ?? '') && attachmentPreview.attachment.url && (
              <span className="ref-pop-thumb-wrap">
                <img
                  className="ref-pop-thumb"
                  src={attachmentPreview.attachment.url}
                  alt={attachmentPreview.attachment.name}
                  onClick={() => onAttachmentActivate?.(attachmentPreview.attachment)}
                />
                <span className="ref-pop-badge" aria-hidden="true">{attachmentPreview.index + 1}</span>
              </span>
            )}
            {attachmentPreview.attachment.size !== undefined && (
              <span className="ref-pop-meta">{formatBytes(attachmentPreview.attachment.size)}</span>
            )}
            {!isNativeImageMime(attachmentPreview.attachment.mime ?? '') && attachmentPreview.attachment.url && (
              <a
                className="ref-pop-download"
                href={attachmentPreview.attachment.url}
                download={attachmentPreview.attachment.name}
              >
                {t('message.attachment.download')}
              </a>
            )}
          </div>
        </ReferencePopover>
      )}
    </span>
  );
}
