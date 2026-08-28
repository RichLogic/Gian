import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NativeConfigOption, NativeConfigValue } from '@gian/shared';
import {
  nativeChoiceDisplayLabel,
  nativeChoiceLabel,
} from './capabilities.js';
import type { NativeOptionRole } from './capabilities.js';

export function useUpDrop(popoverWidth: number, options: { align?: 'left' | 'right' } = {}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const align = options.align ?? 'left';

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const button = btnRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    // Measure the real popover width once mounted (CSS min/max-width can
    // override the assumed popoverWidth — e.g. the + menu is 220 by param
    // but .popover's 320 min-width wins, which broke the right edge).
    const measured = popRef.current?.getBoundingClientRect().width;
    const width = measured && measured > 0 ? measured : popoverWidth;
    const fittedWidth = Math.min(width, window.innerWidth - 16);
    // Right-aligned drops anchor their right edge to the button's right
    // edge — used by triggers on the composer's right side so the popover
    // stays over the composer instead of spilling into (and under) the
    // panels beside it.
    const rawLeft = align === 'right' ? rect.right - fittedWidth : rect.left;
    const left = Math.max(8, Math.min(rawLeft, window.innerWidth - fittedWidth - 8));
    const bottom = window.innerHeight - rect.top + 6;
    setPos(previous => (previous && previous.left === left && previous.bottom === bottom)
      ? previous
      : { left, bottom });
  }, [open, pos, popoverWidth, align]);

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
  const drop = useUpDrop(260, { align: role === 'mode' ? 'right' : 'left' });
  const currentLabel = nativeChoiceLabel(option, role);
  const specialClass = role === 'model'
    ? 'cmp-model-btn'
    : role === 'effort' ? 'cmp-think-btn' : 'cmp-approval-btn';
  return (
    <>
      <button
        ref={drop.btnRef}
        type="button"
        className={`composer-opt ${specialClass} cmp-native-${role}${drop.open ? ' open' : ''}`}
        title={option.description ?? option.name}
        disabled={disabled}
        onClick={() => drop.setOpen(open => !open)}
      >
        <span className="name">{currentLabel}</span>
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
