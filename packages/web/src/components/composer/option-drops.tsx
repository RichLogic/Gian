import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Executor, NativeConfigOption, NativeConfigValue } from '@gian/shared';
import {
  nativeChoiceDisplayLabel,
  nativeChoiceLabel,
} from './capabilities.js';
import type { NativeOptionRole } from './capabilities.js';

export function BulbIcon() {
  return (
    <svg
      className="cmp-bulb"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 18h6" />
      <path d="M10 22h4" />
      <path d="M8.5 14.5A6 6 0 1 1 15.5 14.5c-.9.7-1.5 1.5-1.5 2.5h-4c0-1-.6-1.8-1.5-2.5Z" />
    </svg>
  );
}

export function ExecutorMark({ executor }: { executor: Executor }) {
  return <span className={`cmp-executor-mark ${executor}`} aria-hidden="true" />;
}

export function useUpDrop(popoverWidth: number) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const button = btnRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const fittedWidth = Math.min(popoverWidth, window.innerWidth - 16);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - fittedWidth - 8));
    setPos({ left, bottom: window.innerHeight - rect.top + 6 });
  }, [open, popoverWidth]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (
        popRef.current && !popRef.current.contains(event.target as Node)
        && btnRef.current && !btnRef.current.contains(event.target as Node)
      ) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return { open, setOpen, pos, btnRef, popRef };
}

export function NativeOptionDrop({
  option,
  role,
  disabled,
  onChange,
}: {
  option: NativeConfigOption;
  role: NativeOptionRole;
  disabled: boolean;
  onChange: (value: NativeConfigValue) => void;
}) {
  const drop = useUpDrop(260);
  const currentLabel = nativeChoiceLabel(option, role);
  return (
    <>
      <button
        ref={drop.btnRef}
        type="button"
        className={`composer-opt cmp-native-${role}${drop.open ? ' open' : ''}`}
        title={option.description ?? option.name}
        disabled={disabled}
        onClick={() => drop.setOpen(open => !open)}
      >
        {role === 'model' && <ExecutorMark executor="kimi" />}
        {role === 'effort' && <BulbIcon />}
        <span className="name">{currentLabel}</span>
        <span className="caret cmp-caret" aria-hidden="true">▾</span>
      </button>
      {drop.open && drop.pos && createPortal(
        <div
          ref={drop.popRef}
          className={`popover native-option-pop native-option-${role}-pop`}
          role="dialog"
          style={{ left: drop.pos.left, bottom: drop.pos.bottom }}
        >
          <div className="mp-section-head">
            <span className="mp-section-title">{option.name}</span>
          </div>
          <div className="mp-list">
            {(option.choices ?? []).map(choice => {
              const active = String(choice.value ?? '') === String(option.currentValue ?? '');
              return (
                <button
                  key={String(choice.value)}
                  type="button"
                  className={`mp-row${active ? ' active' : ''}`}
                  onClick={() => {
                    onChange(choice.value);
                    drop.setOpen(false);
                  }}
                >
                  <span className="mp-check">{active ? '✓' : ''}</span>
                  <span className="mp-row-body">
                    <span className="mp-row-title">{nativeChoiceDisplayLabel(role, choice)}</span>
                    {choice.description && <span className="mp-row-hint">{choice.description}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
