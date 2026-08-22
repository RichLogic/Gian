import { describe, expect, it } from 'vitest';
import type { ConfigOption, NativeConfigOption } from '@gian/shared';
import {
  composerModeLabel,
  composerModeOptions,
  effortLabel,
  modesFromCapabilities,
  modelsFromCatalog,
  nativeChoiceDisplayLabel,
  nativeChoiceLabel,
  nativeOptionRole,
  optionByRole,
  steerAdvertised,
} from '../src/components/composer/capabilities.js';

const approval: ConfigOption = {
  id: 'approval_mode',
  displayName: 'Mode',
  binding: 'session',
  role: 'approval_mode',
  control: 'select',
  required: false,
  defaultValue: 'ask',
  choices: [
    { value: 'ask', displayName: 'Ask', description: 'ask desc' },
    { value: 'auto', displayName: 'Auto' },
  ],
};

describe('modesFromCapabilities / steerAdvertised / optionByRole', () => {
  it('prefers approval_mode catalog choices over legacy modes', () => {
    const modes = modesFromCapabilities({
      modes: [{ id: 'legacy', label: 'Legacy', description: '', isDefault: true }],
      configOptions: [approval],
    });
    expect(modes).toEqual([
      { id: 'ask', label: 'Ask', description: 'ask desc', isDefault: true },
      { id: 'auto', label: 'Auto', description: '', isDefault: false },
    ]);
  });

  it('falls back to advertised modes and treats junk steer as undefined', () => {
    expect(modesFromCapabilities({
      modes: [{ id: 'ask', label: 'Ask', description: '', isDefault: true }],
    })).toHaveLength(1);
    expect(steerAdvertised(null)).toBeUndefined();
    expect(steerAdvertised({ capabilities: { 'turn.steer': {} } })).toBe(true);
    expect(steerAdvertised({ capabilities: {} })).toBe(false);
    expect(optionByRole([approval], 'approval_mode')).toBe(approval);
    expect(optionByRole([approval], 'model')).toBeUndefined();
  });
});

describe('modelsFromCatalog / labels', () => {
  it('maps catalog choices to composer models', () => {
    const models = modelsFromCatalog({
      ...approval,
      role: 'model',
      defaultValue: 'gpt-5',
      choices: [{ value: 'gpt-5', displayName: 'GPT-5' }],
    });
    expect(models[0]).toMatchObject({ model: 'gpt-5', displayName: 'GPT-5', isDefault: true });
    expect(modelsFromCatalog(undefined)).toEqual([]);
  });

  it('labels efforts and composer modes', () => {
    expect(effortLabel('codex', 'low')).toBe('Light');
    expect(effortLabel('claude', 'extra_high')).toBe('Extra High');
    expect(effortLabel('claude', null)).toBe('');
    expect(composerModeLabel('claude', 'ask', undefined, key => key.toUpperCase())).toBe('MODE.ASK');
    expect(composerModeLabel('kimi', 'yolo', [{ id: 'yolo', label: 'Yolo', description: '', isDefault: true }], key => key))
      .toBe('Yolo');
    expect(composerModeOptions('kimi', undefined)).toEqual([]);
    expect(composerModeOptions('claude', undefined).map(row => row.mode)).toEqual(['plan', 'ask', 'auto']);
  });
});

describe('nativeOptionRole / nativeChoiceLabel', () => {
  it('classifies options by category or id', () => {
    expect(nativeOptionRole({
      id: 'model', name: 'Model', type: 'select', currentValue: 'k', scope: 'session',
    })).toBe('model');
    expect(nativeOptionRole({
      id: 'x', name: 'Think', category: 'thinking', type: 'select', currentValue: 'low', scope: 'session',
    })).toBe('effort');
    expect(nativeOptionRole({
      id: 'permission_mode', name: 'Mode', type: 'select', currentValue: 'auto', scope: 'session',
    })).toBe('mode');
    expect(nativeOptionRole({
      id: 'other', name: 'Other', type: 'text', currentValue: 'x', scope: 'session',
    })).toBeNull();
  });

  it('uses the matching choice label, with mode value shortcuts', () => {
    const option: NativeConfigOption = {
      id: 'mode',
      name: 'Mode',
      type: 'select',
      currentValue: 'plan',
      scope: 'session',
      choices: [{ value: 'plan', label: 'Plan mode' }],
    };
    expect(nativeChoiceLabel(option, 'mode')).toBe('plan');
    expect(nativeChoiceLabel({ ...option, currentValue: 'missing', choices: [] }, 'mode')).toBe('missing');
  });

  it('nativeChoiceDisplayLabel keeps mode shortcuts and otherwise uses the label', () => {
    expect(nativeChoiceDisplayLabel('mode', { value: 'YOLO', label: 'Full access' })).toBe('yolo');
    expect(nativeChoiceDisplayLabel('effort', { value: 'high', label: 'High thinking' })).toBe('High thinking');
  });
});
