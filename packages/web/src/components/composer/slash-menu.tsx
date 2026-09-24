import type { SlashCommand, SlashCommandSource } from '@gian/shared';
import { useT } from '../../i18n/index.js';
import { highlightMatch } from './highlight-match.js';

export interface SlashCommandGroup {
  source: SlashCommandSource;
  items: SlashCommand[];
}

const SLASH_ROW_ICON = (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M10.75 2.5 5.25 13.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);

/**
 * `/` slash-command menu content. Shares the `@` file popover's row anatomy
 * (`.cmp-file-*`): a tinted family icon, the command name with the matched
 * substring bolded, and a one-line muted description, grouped under small
 * muted source headers with a keyboard-hint footer. The popover frame,
 * portaled positioning, and keyboard handling stay in Composer.
 */
export function SlashCommandMenu({
  groups,
  loading,
  query,
  activeIndex,
  onHover,
  onPick,
}: {
  groups: SlashCommandGroup[];
  loading: boolean;
  /** Typed filter including the leading `/`; '' bolds nothing. */
  query: string;
  /** Flat index across all groups. */
  activeIndex: number;
  onHover: (index: number) => void;
  onPick: (command: SlashCommand) => void;
}) {
  const t = useT();
  let baseIndex = 0;
  return (
    <>
      {loading ? (
        <div className="cmp-file-empty">{t('composer.slash.loading')}</div>
      ) : groups.length === 0 ? (
        <div className="cmp-file-empty">{t('composer.slash.empty')}</div>
      ) : (
        groups.map(group => {
          const start = baseIndex;
          baseIndex += group.items.length;
          return (
            <div key={group.source}>
              <div className="cmp-slash-section">{t(`composer.slash.source.${group.source}`)}</div>
              {group.items.map((item, localIndex) => {
                const flatIndex = start + localIndex;
                const disabled = item.disabled === true;
                return (
                  <button
                    key={item.name}
                    type="button"
                    role="option"
                    aria-selected={flatIndex === activeIndex}
                    aria-disabled={disabled || undefined}
                    className={`cmp-file-row cmp-slash-row${flatIndex === activeIndex ? ' active' : ''}${disabled ? ' disabled' : ''}`}
                    data-source={item.source}
                    title={item.filePath}
                    onPointerDown={event => { event.preventDefault(); if (!disabled) onPick(item); }}
                    onMouseEnter={() => onHover(flatIndex)}
                  >
                    <span className="cmp-file-icon cmp-slash-icon" aria-hidden="true">{SLASH_ROW_ICON}</span>
                    <span className="cmp-file-name cmp-slash-cmd">{highlightMatch(item.name, query)}</span>
                    <span className="cmp-file-path cmp-slash-desc">
                      {disabled ? `${item.description} · ${t('composer.slash.disabled')}` : item.description}
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })
      )}
      <div className="cmp-file-hint">{t('composer.slash.hint')}</div>
    </>
  );
}
