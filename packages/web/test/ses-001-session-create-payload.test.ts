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
import { buildSessionCreatePayload, type SessionCreateFormState } from '../src/views/CodingView.js';

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
});
