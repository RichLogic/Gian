import { useEffect, useRef, useState } from 'react';
import { useChatUiT } from './i18n.js';

export function CopyButton({ text, title, className }: { text: string; title?: string; className?: string }) {
  const t = useChatUiT();
  const defaultTitle = title ?? t('transcript.copyMessage');
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => { if (timerRef.current) window.clearTimeout(timerRef.current); };
  }, []);
  const onClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 1200);
    }).catch(() => {});
  };
  return (
    <button
      type="button"
      className={`msg-copy${className ? ` ${className}` : ''}${copied ? ' copied' : ''}`}
      title={copied ? t('common.copied') : defaultTitle}
      aria-label={defaultTitle}
      onClick={onClick}
    >
      {copied ? (
        <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
          <path d="M3 8l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
          <rect x="5" y="3" width="8" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M3 5v7.5A1.5 1.5 0 0 0 4.5 14H10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}
