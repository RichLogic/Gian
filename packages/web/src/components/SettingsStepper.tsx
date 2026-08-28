interface SettingsStepperProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  decreaseLabel: string;
  increaseLabel: string;
  formatValue(value: number): string;
  onChange(value: number): void;
}

function steppedValue(value: number, direction: -1 | 1, step: number, min: number, max: number): number {
  const decimals = (String(step).split('.')[1] ?? '').length;
  const scale = 10 ** decimals;
  const next = Math.round((value + direction * step) * scale) / scale;
  return Math.min(max, Math.max(min, next));
}

export function SettingsStepper({
  label,
  value,
  min,
  max,
  step = 1,
  decreaseLabel,
  increaseLabel,
  formatValue,
  onChange,
}: SettingsStepperProps) {
  return (
    <div className="settings-stepper" role="group" aria-label={label}>
      <button type="button" aria-label={decreaseLabel} disabled={value <= min}
              onClick={() => onChange(steppedValue(value, -1, step, min, max))}>-</button>
      <output aria-live="polite">{formatValue(value)}</output>
      <button type="button" aria-label={increaseLabel} disabled={value >= max}
              onClick={() => onChange(steppedValue(value, 1, step, min, max))}>+</button>
    </div>
  );
}
