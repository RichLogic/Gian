import { describe, expect, it } from 'vitest';
import type { ConfigOption, Session } from '@gian/shared';

import {
  applyResolvedDefaults,
  catalogFromCapabilities,
  composerConfigValues,
  conditionsMatch,
  createConfigsFromCatalog,
  inputTypeAdvertised,
  mergeTurnCatalog,
  optionEnabled,
  optionVisible,
} from '../src/components/composer/capabilities.js';

const vision: ConfigOption = {
  id: 'vision',
  displayName: 'Vision',
  binding: 'turn',
  role: 'custom_vision',
  control: 'boolean',
  required: false,
  defaultValue: false,
  visibleWhen: [{ optionId: 'model', oneOf: ['vision-model'] }],
};

const model: ConfigOption = {
  id: 'model',
  displayName: 'Model',
  binding: 'turn',
  role: 'model',
  control: 'select',
  required: true,
  defaultValue: 'base',
  choices: [
    { value: 'base', displayName: 'Base' },
    { value: 'vision-model', displayName: 'Vision' },
  ],
};

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    name: 't',
    type: 'coding',
    task_id: null,
    workspace_id: 'w1',
    executor: 'claude',
    model: 'base',
    approval_mode: 'ask',
    executor_config: { schemaVersion: 1, values: {} },
    native_config_options: [],
    thinking_effort: 'high',
    service_tier: null,
    active_channel: 'web',
    status: 'done',
    archived: 0,
    pinned_at: null,
    unread: 0,
    worktree_path: null,
    branch: null,
    base_branch: null,
    worktree_outcome: null,
    native_session_id: 'n1',
    created_at: '2026-08-18T00:00:00.000Z',
    updated_at: '2026-08-18T00:00:00.000Z',
    ...overrides,
  } as Session;
}

describe('catalog condition evaluation', () => {
  it('matches every visibleWhen condition by exact scalar equality', () => {
    expect(conditionsMatch(undefined, {})).toBe(true);
    expect(conditionsMatch([], { model: 'base' })).toBe(true);
    expect(optionVisible(vision, { model: 'vision-model' })).toBe(true);
    expect(optionVisible(vision, { model: 'base' })).toBe(false);
    expect(optionEnabled({ enabledWhen: [{ optionId: 'fast', oneOf: [true] }] }, { fast: true })).toBe(true);
    expect(optionEnabled({ enabledWhen: [{ optionId: 'fast', oneOf: [true] }] }, { fast: false })).toBe(false);
  });

  it('prefers turn_config, then role columns, then defaults', () => {
    const values = composerConfigValues(session({
      model: 'sonnet',
      turn_config: { extra: 2 },
    }), [model, vision]);
    expect(values.model).toBe('sonnet');
    expect(values.vision).toBe(false);
    expect(values.extra).toBe(2);
  });

  it('reads configOptions and input descriptors from the capabilities payload', () => {
    const catalog = catalogFromCapabilities({
      catalogRevision: 'r1',
      input: [
        { type: 'text' },
        { type: 'localImage', enabledWhen: [{ optionId: 'model', oneOf: ['vision-model'] }] },
      ],
      configOptions: [model, vision, { id: 'bad' }],
    });
    expect(catalog.configOptions.map(option => option.id)).toEqual(['model', 'vision']);
    expect(inputTypeAdvertised(catalog, 'localImage', { model: 'vision-model' })).toBe(true);
    expect(inputTypeAdvertised(catalog, 'localImage', { model: 'base' })).toBe(false);
    expect(inputTypeAdvertised(catalog, 'localFile', { model: 'base' })).toBe(false);
    expect(catalog.slashCommands).toEqual([]);
  });

  it('maps gian.proxy/2.1 Special Catalog ids into the fixed internal UI slots', () => {
    const catalog = catalogFromCapabilities({
      specialCatalogs: {
        model: 'provider_model',
        thinking: 'reasoning_level',
        fast: 'speed',
        approvalMode: 'permission',
      },
      configOptions: [
        { ...model, id: 'provider_model', role: undefined },
        { ...model, id: 'reasoning_level', role: undefined },
        { id: 'speed', displayName: 'Fast', binding: 'turn', control: 'boolean', required: false, defaultValue: false },
        { ...model, id: 'permission', role: undefined },
      ],
    });
    expect(catalog.specialCatalogs).toEqual({
      model: 'provider_model',
      thinking: 'reasoning_level',
      fast: 'speed',
      approvalMode: 'permission',
    });
    expect(catalog.configOptions.map(option => [option.id, option.role])).toEqual([
      ['provider_model', 'model'],
      ['reasoning_level', 'effort'],
      ['speed', 'fast'],
      ['permission', 'approval_mode'],
    ]);
  });

  it('replaces only the turn-bound subset from session.turn_config_options', () => {
    const sessionBound: ConfigOption = {
      id: 'workspace',
      displayName: 'Workspace',
      binding: 'session',
      control: 'select',
      required: false,
      defaultValue: 'default',
    };
    const merged = mergeTurnCatalog([model, vision, sessionBound], [{
      ...vision,
      id: 'verbosity',
      role: 'custom_verbosity',
      visibleWhen: undefined,
    }]);
    expect(merged.map(option => option.id)).toEqual(['workspace', 'verbosity']);
  });

  it('drops leftover effort values that the current catalog does not advertise', () => {
    const payload = createConfigsFromCatalog('kimi', [
      {
        id: 'thinking',
        displayName: 'Thinking',
        binding: 'turn',
        role: 'effort',
        control: 'select',
        required: false,
        defaultValue: 'on',
        choices: [{ value: 'on', displayName: 'On' }],
      },
    ], { thinking: 'low' });
    expect(payload.thinkingEffort).toBeUndefined();
    expect(payload.turn_config).toEqual({});
  });

  it('maps catalog values into session_config / turn_config without writing unknown approval modes', () => {
    const payload = createConfigsFromCatalog('kimi', [
      {
        id: 'mode',
        displayName: 'Mode',
        binding: 'session',
        role: 'approval_mode',
        control: 'select',
        required: false,
        defaultValue: 'default',
      },
      model,
    ], { mode: 'yolo', model: 'vision-model' });
    expect(payload.approvalMode).toBeUndefined();
    expect(payload.session_config).toEqual({ mode: 'yolo' });
    expect(payload.turn_config).toEqual({ model: 'vision-model' });
    expect(payload.model).toBe('vision-model');
  });

  it('omits Fast when the selected model does not satisfy its catalog condition', () => {
    const fast: ConfigOption = {
      id: 'service_tier',
      displayName: 'Fast',
      binding: 'turn',
      role: 'fast',
      control: 'boolean',
      required: false,
      defaultValue: false,
      enabledWhen: [{ optionId: 'model', oneOf: ['vision-model'] }],
    };
    const payload = createConfigsFromCatalog('codex', [model, fast], {
      model: 'base',
      service_tier: true,
    });
    expect(payload.serviceTier).toBeUndefined();
    expect(payload.turn_config).toEqual({ model: 'base' });
  });

  it('fills only missing values from catalog.resolve defaults', () => {
    expect(applyResolvedDefaults({ model: 'base' }, { model: 'other', verbosity: 'quiet' }))
      .toEqual({ model: 'base', verbosity: 'quiet' });
  });
});

describe('catalog actions parsing (proposal §9.4)', () => {
  it('parses supported/unsupported descriptors and passes reason through', () => {
    const catalog = catalogFromCapabilities({
      actions: [
        { id: 'sidechat.create', supported: true },
        { id: 'session.fork', supported: false, reason: '当前 Runtime 不提供持久上下文分叉。' },
        { id: 'session.fork.atTurn', supported: false },
      ],
    });
    expect(catalog.actions).toEqual([
      { id: 'sidechat.create', supported: true },
      { id: 'session.fork', supported: false, reason: '当前 Runtime 不提供持久上下文分叉。' },
      { id: 'session.fork.atTurn', supported: false },
    ]);
  });

  it('leaves actions undefined when the catalog omits the field (legacy proxy)', () => {
    const catalog = catalogFromCapabilities({ configOptions: [] });
    expect(catalog.actions).toBeUndefined();
    expect(catalogFromCapabilities(null).actions).toBeUndefined();
  });

  it('parses an explicitly empty actions array as an empty (declared) directory', () => {
    expect(catalogFromCapabilities({ actions: [] }).actions).toEqual([]);
  });

  it('drops malformed descriptors and non-string reasons defensively', () => {
    const catalog = catalogFromCapabilities({
      actions: [
        { id: 'sidechat.create', supported: true, reason: 42 },
        { id: 'missing-supported' },
        { supported: true },
        'not-an-object',
        { id: 'session.fork', supported: 'yes' },
        null,
      ],
    });
    expect(catalog.actions).toEqual([{ id: 'sidechat.create', supported: true }]);
  });

  it('treats a non-array actions field as an empty declared directory', () => {
    expect(catalogFromCapabilities({ actions: 'bogus' }).actions).toEqual([]);
  });
});
