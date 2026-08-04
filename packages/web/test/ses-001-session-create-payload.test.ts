// Coverage for traceability row SES-001 (Web form payload dimension):
//   The new-session form collects only workspace, agent (executor), and an
//   optional name. `buildSessionCreatePayload` must emit exactly that
//   contract — approval mode / worktree fields / first message were removed
//   from the form on 2026-08-01 and must never leak back into the payload.

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
    for (const exec of ['claude', 'codex', 'kimi'] as const) {
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
});
