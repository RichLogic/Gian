// Coverage for traceability row SES-001 (Web form payload dimension):
//   The new-session composer collects workspace, agent (executor), an
//   optional title, capability chips (model / thinking / mode / Codex Fast,
//   v2), and a
//   first message. `buildSessionCreatePayload` emits workspaceId / name /
//   executor plus ONLY the chip values the user explicitly picked — unset
//   chips stay out so the host's configured defaults apply, and Kimi never
//   carries approvalMode (executor-native configuration). The first message
//   (issue #57) deliberately rides App's pendingFirstMessage channel instead
//   of the session.create wire payload.

import { describe, it, expect } from 'vitest';
import type { ConfigOption } from '@gian/shared';
import { buildSessionCreatePayload, type SessionCreateFormState } from '../src/views/CodingView.js';
import { overlayExplicitCatalogChoices } from '../src/views/new-session-view.js';

function formState(overrides: Partial<SessionCreateFormState> = {}): SessionCreateFormState {
  return {
    workspaceId: 'ws-1',
    sessionName: 'demo',
    executor: 'claude',
    ...overrides,
  };
}

describe('SES-001: minimal session payload from form state', () => {
  it('emits exactly workspaceId, name, and executor', () => {
    const payload = buildSessionCreatePayload(formState());
    expect(payload).toEqual({
      workspaceId: 'ws-1',
      name: 'demo',
      executor: 'claude',
    });
  });

  it('trims the session name', () => {
    const payload = buildSessionCreatePayload(formState({ sessionName: '  spaces around  ' }));
    expect(payload.name).toBe('spaces around');
  });

  it('keeps a blank name blank (App omits `name` from session:create when empty)', () => {
    const payload = buildSessionCreatePayload(formState({ sessionName: '   ' }));
    expect(payload.name).toBe('');
  });

  it('every executor round-trips', () => {
    for (const exec of ['claude', 'codex', 'kimi', 'grok'] as const) {
      const payload = buildSessionCreatePayload(formState({ executor: exec }));
      expect(payload.executor).toBe(exec);
    }
  });

  it('never carries approval / worktree / first-message fields', () => {
    const payload = buildSessionCreatePayload(formState()) as Record<string, unknown>;
    for (const key of ['approvalMode', 'mode', 'baseBranch', 'branch', 'firstMessage']) {
      expect(payload[key]).toBeUndefined();
    }
  });

  it('carries explicitly picked chip values (v2 composer)', () => {
    const payload = buildSessionCreatePayload(formState({
      executor: 'codex',
      model: 'gpt-5',
      thinkingEffort: 'high',
      approvalMode: 'auto',
      serviceTier: 'fast',
    }));
    expect(payload).toEqual({
      workspaceId: 'ws-1',
      name: 'demo',
      executor: 'codex',
      model: 'gpt-5',
      thinkingEffort: 'high',
      approvalMode: 'auto',
      serviceTier: 'fast',
    });
  });

  it('drops Fast for non-Codex executors', () => {
    const payload = buildSessionCreatePayload(formState({
      executor: 'claude',
      serviceTier: 'fast',
    })) as Record<string, unknown>;
    expect(payload.serviceTier).toBeUndefined();
  });

  it('drops approvalMode for kimi even when set (executor-native configuration)', () => {
    const payload = buildSessionCreatePayload(formState({
      executor: 'kimi',
      approvalMode: 'auto',
    })) as Record<string, unknown>;
    expect(payload.approvalMode).toBeUndefined();
  });

  it('drops approvalMode for grok even when set (executor-native configuration)', () => {
    const payload = buildSessionCreatePayload(formState({
      executor: 'grok',
      approvalMode: 'auto',
    })) as Record<string, unknown>;
    expect(payload.approvalMode).toBeUndefined();
  });

  it('drops leftover thinkingEffort that the current catalog does not advertise', () => {
    const payload = buildSessionCreatePayload(formState({
      executor: 'kimi',
      thinkingEffort: 'low',
      catalogOptions: [{
        id: 'thinking',
        displayName: 'Thinking',
        binding: 'turn',
        role: 'effort',
        control: 'select',
        required: false,
        defaultValue: 'on',
        choices: [{ value: 'on', displayName: 'On' }],
      }],
      catalogValues: { thinking: 'low' },
    })) as Record<string, unknown>;
    expect(payload.thinkingEffort).toBeUndefined();
    expect(payload.turnConfig).toBeUndefined();
  });

  it('sends session-bound catalog values as sessionConfig', () => {
    const payload = buildSessionCreatePayload(formState({
      executor: 'kimi',
      catalogOptions: [{
        id: 'mode',
        displayName: 'Mode',
        binding: 'session',
        role: 'approval_mode',
        control: 'select',
        required: false,
        defaultValue: 'default',
      }],
      catalogValues: { mode: 'yolo' },
    }));
    expect(payload.approvalMode).toBeUndefined();
    expect(payload.sessionConfig).toEqual({ mode: 'yolo' });
  });

  it.each([
    { executor: 'grok', binding: 'turn', initial: 'default' },
    { executor: 'grok', binding: 'session', initial: 'default' },
    { executor: 'kimi', binding: 'turn', initial: 'manual' },
    { executor: 'codex', binding: 'turn', initial: 'ask' },
    { executor: 'claude', binding: 'session', initial: 'ask' },
  ] as const)('replaces a resolved $executor $binding mode without losing Sandbox or Thinking', ({ executor, binding, initial }) => {
    const options: ConfigOption[] = [{
      id: 'mode_choice', displayName: 'Mode', binding, role: 'approval_mode',
      control: 'select', required: false, defaultValue: initial,
      choices: [{ value: initial, displayName: initial }, { value: 'auto', displayName: 'Auto' }],
    }, {
      id: 'sandbox_profile', displayName: 'Sandbox', binding: 'session',
      control: 'select', required: false, defaultValue: 'workspace',
      choices: [{ value: 'workspace', displayName: 'Workspace' }, { value: 'off', displayName: 'Off' }],
    }, {
      id: 'reasoning_effort', displayName: 'Thinking', binding: 'turn', role: 'effort',
      control: 'select', required: false, defaultValue: 'high',
      choices: [{ value: 'low', displayName: 'Low' }, { value: 'high', displayName: 'High' }],
    }];
    const values = { mode_choice: initial, sandbox_profile: 'off', reasoning_effort: 'low' };
    const next = overlayExplicitCatalogChoices(options, values, {
      mode: 'auto',
      configuredOptions: { sandbox_profile: 'workspace' },
    });
    expect(next).toEqual({ ...values, mode_choice: 'auto' });
    expect(values.mode_choice).toBe(initial);
    const payload = buildSessionCreatePayload(formState({ executor, catalogOptions: options, catalogValues: next }));
    expect((binding === 'turn' ? payload.turnConfig : payload.sessionConfig)?.mode_choice).toBe('auto');
    expect(payload.sessionConfig?.sandbox_profile).toBe('off');
    expect(payload.turnConfig?.reasoning_effort).toBe('low');
    expect(payload.thinkingEffort).toBe('low');
    expect(payload.approvalMode).toBe(executor === 'grok' || executor === 'kimi' ? undefined : 'auto');
  });

  it('does not replace an advertised mode with an invalid remembered chip value', () => {
    const options: ConfigOption[] = [{
      id: 'permission_mode', displayName: 'Mode', binding: 'turn', role: 'approval_mode',
      control: 'select', required: false, defaultValue: 'default',
      choices: [{ value: 'default', displayName: 'Default' }, { value: 'auto', displayName: 'Auto' }],
    }];
    const values = { permission_mode: 'default' };
    expect(overlayExplicitCatalogChoices(options, values, { mode: 'full-access' })).toEqual(values);
    expect(overlayExplicitCatalogChoices(options, {}, { mode: 'full-access' })).toEqual({});
    expect(overlayExplicitCatalogChoices(options, values, { mode: null })).toEqual(values);
  });
});
