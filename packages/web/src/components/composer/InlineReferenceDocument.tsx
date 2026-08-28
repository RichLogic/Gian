import { useState } from 'react';
import type { ComposerDocument, MessageContextItem } from '@gian/shared';
import { ContextReferencePopover, REFERENCE_ICONS } from './reference-popover.js';
import type { ReferenceAnchor } from './reference-popover.js';

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
  // Clicking a context chip opens a floating detail card anchored to it.
  const [preview, setPreview] = useState<{
    id: string;
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
              onClick={event => {
                const el = event.currentTarget;
                setPreview(previous => previous?.id === segment.id
                  ? null
                  : { id: segment.id, anchor: el.getBoundingClientRect(), anchorEl: el });
              }}
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
          return (
            <a
              key={`${segment.id}-${index}`}
              className="message-inline-reference"
              data-reference-id={segment.id}
              data-reference-type="attachment"
              href={attachment.url}
              download={attachment.name}
              title={attachment.name}
              onClick={onAttachmentActivate ? event => {
                if (onAttachmentActivate(attachment)) event.preventDefault();
              } : undefined}
            >
              {glyph}
              <span className="mir-label">{segment.label}</span>
            </a>
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
        />
      )}
    </span>
  );
}
