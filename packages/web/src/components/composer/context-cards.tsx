import { useState } from 'react';
import type { MessageContextItem } from '@gian/shared';
import { fmtBytes } from '../../attachments.js';
import { useT } from '../../i18n/index.js';

const PREVIEW_LINES = 30;

export function ContextCards({
  items,
  onRemove,
  className = '',
}: {
  items: MessageContextItem[];
  onRemove?: (id: string) => void;
  className?: string;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  if (items.length === 0) return null;

  return (
    <div className={`context-cards${className ? ` ${className}` : ''}`}>
      {items.map(item => {
        const open = expanded.has(item.id);
        const expandable = item.type !== 'folder';
        const label = item.type === 'folder'
          ? item.name
          : item.type === 'browserElement'
            ? t('composer.context.browserElement')
            : item.origin === 'selection'
              ? t('composer.context.quote')
              : t('composer.context.pastedText');
        const meta = item.type === 'folder'
          ? item.path
          : item.type === 'browserElement'
            ? item.selector
            : t('composer.context.pastedMeta')
                .replace('{lines}', String(item.lineCount))
                .replace('{size}', fmtBytes(item.byteSize));
        const title = item.type === 'browserElement'
          ? `${item.pageTitle || item.pageUrl}\n${item.pageUrl}\n${item.selector}`
          : meta;
        const cardBody = (
          <>
            <span className="context-card-icon" aria-hidden="true">
              {item.type === 'folder' ? (
                <svg viewBox="0 0 16 16" fill="none">
                  <path d="M1.75 4.25h4l1.2 1.5h7.3v7.5H1.75z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                  <path d="M1.75 5.75v-3h4l1.2 1.5h3" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                </svg>
              ) : item.type === 'browserElement' ? (
                <svg viewBox="0 0 16 16" fill="none">
                  <path d="M2.25 6V2.25H6M10 2.25h3.75V6M13.75 10v3.75H10M6 13.75H2.25V10M5.25 5.25h5.5v5.5h-5.5z" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" fill="none">
                  <path d="M3 1.75h10v12.5H3zM5.25 5h5.5M5.25 7.75h5.5M5.25 10.5h3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                </svg>
              )}
            </span>
            <span className="context-card-copy">
              <span className="context-card-label">{label}</span>
              <span className="context-card-meta">{meta}</span>
            </span>
            {expandable && (
              <span className={`context-card-caret${open ? ' is-open' : ''}`} aria-hidden="true">
                <svg viewBox="0 0 16 16" fill="none">
                  <path d="m6 3.5 4.5 4.5L6 12.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            )}
          </>
        );
        return (
          <div key={item.id} className={`context-card is-${item.type}`}>
            {expandable ? (
              <button
                type="button"
                className="context-card-main"
                title={title}
                aria-expanded={open}
                onClick={() => setExpanded(previous => {
                    const next = new Set(previous);
                    if (next.has(item.id)) next.delete(item.id);
                    else next.add(item.id);
                    return next;
                  })}
              >
                {cardBody}
              </button>
            ) : (
              <div className="context-card-main" title={title}>{cardBody}</div>
            )}
            {onRemove && (
              <button
                type="button"
                className="context-card-remove"
                onClick={() => onRemove(item.id)}
                aria-label={t('composer.context.remove')}
              >
                <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="m4.5 4.5 7 7m0-7-7 7" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
                </svg>
              </button>
            )}
            {expandable && open && (
              <pre className="context-card-preview">{
                (item.type === 'browserElement'
                  ? `${item.pageTitle || item.pageUrl}\n${item.pageUrl}\n\n${item.snippet}`
                  : item.text)
                  .split(/\r\n|\r|\n/)
                  .slice(0, PREVIEW_LINES)
                  .join('\n')
              }</pre>
            )}
          </div>
        );
      })}
    </div>
  );
}
