import { Fragment, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ConfigOption, ConfigValue, Executor, AgentColor } from '@gian/shared';
import { useT } from '../../i18n/index.js';
import { ExecutorMark, useUpDrop } from './option-drops.js';

export interface CatalogMenuChoice {
  value: string;
  label: string;
  description?: string;
}

export interface CatalogMenuChoiceSection {
  label: string;
  value: string;
  choices: CatalogMenuChoice[];
  disabled?: boolean;
  onChange: (value: string) => void;
}

export interface CatalogMenuToggle {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

export function CatalogOptionsMenu({
  executor,
  summary,
  model,
  effort,
  fast,
  options,
  values,
  optionDisabled,
  onOptionChange,
  testId,
  agentColor = null,
}: {
  executor: Executor;
  /** Owning Agent's color — renders instead of the kind mark when set. */
  agentColor?: AgentColor | null;
  summary: string[];
  model?: CatalogMenuChoiceSection;
  effort?: CatalogMenuChoiceSection;
  fast?: CatalogMenuToggle;
  options: ConfigOption[];
  values: Record<string, ConfigValue>;
  optionDisabled: (option: ConfigOption) => boolean;
  onOptionChange: (option: ConfigOption, value: ConfigValue) => void;
  testId?: string;
}) {
  const t = useT();
  const drop = useUpDrop(320);
  const [editingOption, setEditingOption] = useState<string | null>(null);
  const hasSections = Boolean(model || effort || fast || options.length > 0);
  const visibleSummary = summary.filter(part => part.trim().length > 0);
  if (!hasSections) return null;

  function closeAfterPick(action: () => void) {
    action();
    setEditingOption(null);
    drop.setOpen(false);
  }

  return (
    <>
      <button
        ref={drop.btnRef}
        type="button"
        className={`composer-opt cmp-options-btn${drop.open ? ' open' : ''}`}
        data-testid={testId}
        title={t('composer.options.section')}
        aria-haspopup="dialog"
        aria-expanded={drop.open}
        onClick={() => drop.setOpen(open => !open)}
      >
        {agentColor
          ? <span className="exec-dot" style={{ background: `var(--agent-${agentColor})` }} aria-hidden="true" />
          : <ExecutorMark executor={executor} />}
        {visibleSummary.length > 0 ? visibleSummary.map((part, index) => (
          <Fragment key={`${part}:${index}`}>
            {index > 0 && <span className="cmp-opt-sep" aria-hidden="true">|</span>}
            <span className="name">{part}</span>
          </Fragment>
        )) : (
          <span className="name">{t('composer.options.section')}</span>
        )}
        <span className="caret cmp-caret" aria-hidden="true">▴</span>
      </button>

      {drop.open && drop.pos && createPortal(
        <div
          ref={drop.popRef}
          className="popover options-pop catalog-options-pop"
          role="dialog"
          aria-label={t('composer.options.section')}
          style={{ left: drop.pos.left, bottom: drop.pos.bottom }}
        >
          <div className="catalog-options-title">{t('composer.options.section')}</div>

          {options.map(option => (
            <CatalogOptionSection
              key={option.id}
              option={option}
              value={values[option.id] ?? option.defaultValue}
              disabled={optionDisabled(option)}
              editing={editingOption === option.id}
              onEditingChange={editing => setEditingOption(editing ? option.id : null)}
              onChange={value => onOptionChange(option, value)}
              onPick={value => closeAfterPick(() => onOptionChange(option, value))}
            />
          ))}

          {fast && (
            <div className="mp-section">
              <div className="mp-row cmp-switch-row">
                <span className="mp-row-body">
                  <span className="mp-row-title">{fast.label}</span>
                  {fast.description && <span className="mp-row-hint">{fast.description}</span>}
                </span>
                <label className="switch">
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={fast.label}
                    aria-checked={fast.checked}
                    checked={fast.checked}
                    disabled={fast.disabled}
                    onChange={event => fast.onChange(event.target.checked)}
                  />
                </label>
              </div>
            </div>
          )}

          {effort && (
            <ChoiceSection
              section={effort}
              onPick={value => closeAfterPick(() => effort.onChange(value))}
            />
          )}

          {model && (
            <ChoiceSection
              section={model}
              onPick={value => closeAfterPick(() => model.onChange(value))}
            />
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

function ChoiceSection({
  section,
  onPick,
}: {
  section: CatalogMenuChoiceSection;
  onPick: (value: string) => void;
}) {
  return (
    <div className="mp-section">
      <div className="mp-section-head">
        <span className="mp-section-title">{section.label}</span>
      </div>
      <div className="mp-list">
        {section.choices.map(choice => {
          const active = choice.value === section.value;
          return (
            <button
              key={choice.value}
              type="button"
              className={`mp-row${active ? ' active' : ''}`}
              disabled={section.disabled}
              onClick={() => onPick(choice.value)}
            >
              <span className="mp-check">{active ? '✓' : ''}</span>
              <span className="mp-row-body">
                <span className="mp-row-title">{choice.label}</span>
                {choice.description && <span className="mp-row-hint">{choice.description}</span>}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CatalogOptionSection({
  option,
  value,
  disabled,
  editing,
  onEditingChange,
  onChange,
  onPick,
}: {
  option: ConfigOption;
  value: ConfigValue | undefined;
  disabled: boolean;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  onChange: (value: ConfigValue) => void;
  onPick: (value: ConfigValue) => void;
}) {
  if (option.control === 'boolean') {
    return (
      <div className="mp-section" data-testid={`catalog-option-${option.id}`}>
        <div className="mp-row cmp-switch-row">
          <span className="mp-row-body">
            <span className="mp-row-title">{option.displayName}</span>
            {option.description && <span className="mp-row-hint">{option.description}</span>}
          </span>
          <label className="switch">
            <input
              type="checkbox"
              role="switch"
              aria-label={option.displayName}
              aria-checked={value === true}
              checked={value === true}
              disabled={disabled}
              onChange={event => onChange(event.target.checked)}
            />
          </label>
        </div>
      </div>
    );
  }

  if (option.control === 'select') {
    return (
      <div className="mp-section" data-testid={`catalog-option-${option.id}`}>
        <div className="mp-section-head">
          <span className="mp-section-title">{option.displayName}</span>
        </div>
        <div className="mp-list">
          {(option.choices ?? []).map(choice => {
            const choiceValue = String(choice.value ?? '');
            const active = choiceValue === String(value ?? '');
            return (
              <button
                key={choiceValue}
                type="button"
                className={`mp-row${active ? ' active' : ''}`}
                data-testid={`catalog-option-${option.id}-${choiceValue}`}
                disabled={disabled}
                onClick={() => onPick(choice.value)}
              >
                <span className="mp-check">{active ? '✓' : ''}</span>
                <span className="mp-row-body">
                  <span className="mp-row-title">{choice.displayName}</span>
                  {choice.description && <span className="mp-row-hint">{choice.description}</span>}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  const inputType = option.presentation?.sensitive
    ? 'password'
    : option.control === 'number' ? 'number' : 'text';
  return (
    <div className="mp-section" data-testid={`catalog-option-${option.id}`}>
      <div className="mp-section-head">
        <span className="mp-section-title">{option.displayName}</span>
      </div>
      <div className="catalog-option-field">
        <input
          key={`${option.id}:${String(value)}`}
          type={inputType}
          defaultValue={String(value ?? '')}
          disabled={disabled}
          aria-label={option.displayName}
          placeholder={option.presentation?.placeholder}
          min={option.constraints?.minimum}
          max={option.constraints?.maximum}
          step={option.constraints?.step}
          onFocus={() => onEditingChange(true)}
          onBlur={event => {
            onEditingChange(false);
            onChange(option.control === 'number' ? Number(event.target.value) : event.target.value);
          }}
          onKeyDown={event => {
            if (event.key === 'Enter' && editing) event.currentTarget.blur();
          }}
        />
      </div>
    </div>
  );
}
