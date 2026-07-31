import { useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { Session } from '@gian/shared';
import { useT } from '../../i18n/index.js';

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    const scaled = value / 1_000_000;
    return `${scaled >= 10 ? scaled.toFixed(0) : scaled.toFixed(1).replace(/\.0$/, '')}m`;
  }
  if (value >= 1_000) {
    const scaled = value / 1_000;
    return `${scaled >= 10 ? scaled.toFixed(0) : scaled.toFixed(1).replace(/\.0$/, '')}k`;
  }
  return String(value);
}

export function ContextUsageIndicator({ session }: { session: Session }) {
  const t = useT();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [tooltipPosition, setTooltipPosition] = useState<{ left: number; top: number } | null>(null);
  const used = typeof session.context_tokens_used === 'number'
    ? session.context_tokens_used
    : null;
  const capacity = typeof session.context_window_tokens === 'number'
    && session.context_window_tokens > 0
    ? session.context_window_tokens
    : null;
  const hasRatio = used !== null && capacity !== null;
  const percent = hasRatio
    ? Math.round(Math.min(1, Math.max(0, used / capacity)) * 100)
    : null;
  const recalculating = used === null && Boolean(session.context_usage_updated_at);
  const conversationVisible = session.conversation_usage_complete === 1
    && typeof session.conversation_total_tokens === 'number';

  const showTooltip = () => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    const preferred = rect.left + rect.width / 2;
    setTooltipPosition({
      left: Math.min(Math.max(preferred, 132), window.innerWidth - 132),
      top: rect.top - 8,
    });
  };

  const ringStyle = {
    '--context-progress': `${(percent ?? 0) * 3.6}deg`,
  } as CSSProperties;
  const stateClass = recalculating
    ? ' is-recalculating'
    : percent !== null && percent >= 90
      ? ' is-danger'
      : percent !== null && percent >= 75
        ? ' is-warning'
        : percent === null
          ? ' is-unknown'
          : '';
  const ariaLabel = percent === null
    ? t(recalculating ? 'composer.context.recalculating' : 'composer.context.afterResponse')
    : `${t('composer.context.title')}: ${percent}% ${t('composer.context.used')}`;

  return (
    <>
      <span
        ref={anchorRef}
        className={`context-usage-anchor${stateClass}`}
        role="img"
        tabIndex={0}
        aria-label={ariaLabel}
        onMouseEnter={showTooltip}
        onMouseLeave={() => setTooltipPosition(null)}
        onFocus={showTooltip}
        onBlur={() => setTooltipPosition(null)}
      >
        <span className="context-usage-ring" style={ringStyle} aria-hidden="true" />
      </span>
      {tooltipPosition && createPortal(
        <div
          className="context-usage-tooltip"
          role="tooltip"
          style={{ left: tooltipPosition.left, top: tooltipPosition.top }}
        >
          <div className="context-usage-tooltip-title">{t('composer.context.title')}</div>
          {hasRatio && percent !== null && (
            <>
              <div className="context-usage-tooltip-primary">
                {percent}% {t('composer.context.used')} ({100 - percent}% {t('composer.context.left')})
              </div>
              <div className="context-usage-tooltip-detail">
                {formatTokenCount(used)} / {formatTokenCount(capacity)} {t('composer.context.tokensUsed')}
              </div>
            </>
          )}
          {!hasRatio && used !== null && (
            <div className="context-usage-tooltip-detail">
              {formatTokenCount(used)} {t('composer.context.tokensUsed')}
            </div>
          )}
          {used === null && (
            <div className="context-usage-tooltip-state">
              {t(recalculating ? 'composer.context.recalculating' : 'composer.context.afterResponse')}
            </div>
          )}
          {conversationVisible && (
            <div className="context-usage-conversation">
              <div className="context-usage-tooltip-title">{t('composer.context.conversationTotal')}</div>
              <div className="context-usage-tooltip-primary">
                {session.conversation_total_tokens!.toLocaleString()} {t('composer.context.tokens')}
              </div>
              <div className="context-usage-breakdown">
                <span>{t('composer.context.input')} {(session.conversation_input_tokens ?? 0).toLocaleString()}</span>
                <span>{t('composer.context.output')} {(session.conversation_output_tokens ?? 0).toLocaleString()}</span>
                {(session.conversation_cached_input_tokens ?? 0) > 0 && (
                  <span>{t('composer.context.cached')} {(session.conversation_cached_input_tokens ?? 0).toLocaleString()}</span>
                )}
              </div>
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
