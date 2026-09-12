import { useState } from 'react';
import type { ComposerDocument, MessageContextItem } from '@gian/shared';
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

export interface InlineReferenceAttachment {
  name: string;
  mime?: string;
  size?: number;
  url?: string;
}

function contextTitle(item: MessageContextItem | undefined, fallback: string): string {
  if (!item) return fallback;
  if (item.type === 'folder') return item.path;
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
    anchor: ReferenceAnchor;
    anchorEl: Element;
  } | null>(null);
  const previewItem = preview
    ? contextItems.find(item => item.id === preview.id) ?? null
    : null;
  const attachmentIndexes = new Map<string, number>();
  return (
    <span className={className ? `inline-reference-document ${className}` : 'inline-reference-document'}>
      {document.segments.map((segment, index) => {
        if (segment.type === 'text') return <span key={index}>{segment.text}</span>;
        if (segment.referenceType === 'context') {
          const contextItem = contextItems.find(item => item.id === segment.id);
          if (!contextItem) {
            return (
              <span
                key={`${segment.id}-${index}`}
                className="message-inline-reference"
                data-reference-id={segment.id}
                data-reference-type="context"
                title={segment.label}
              >
                <span className="mir-label">{segment.label}</span>
              </span>
            );
          }
          return (
            <button
              key={`${segment.id}-${index}`}
              type="button"
              className="message-inline-reference"
              data-reference-id={segment.id}
              data-reference-type="context"
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
                hover.scheduleOpen(() => setAttachmentPreview({ key, attachment, label: segment.label, anchor: el.getBoundingClientRect(), anchorEl: el }));
              }}
              onMouseLeave={() => hover.scheduleClose(() => setAttachmentPreview(null))}
              onFocus={event => {
                const el = event.currentTarget;
                hover.scheduleOpen(() => setAttachmentPreview({ key, attachment, label: segment.label, anchor: el.getBoundingClientRect(), anchorEl: el }));
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
      })}
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
              <img
                className="ref-pop-thumb"
                src={attachmentPreview.attachment.url}
                alt={attachmentPreview.attachment.name}
                onClick={() => onAttachmentActivate?.(attachmentPreview.attachment)}
              />
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
