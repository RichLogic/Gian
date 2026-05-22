// Coverage for traceability rows (Web form payload dimension):
//   WT-001 — Worktree session must create with default branch
//             `worktree/<short-id>`, with support for base_branch and a
//             user-supplied branch suffix. The Web new-session form
//             must construct the right `session:create` WS payload —
//             host policy is already covered in the host suite, but the
//             FORM must produce the right shape.
//   SES-001 — New session form must expose workspace, executor,
//             approval mode, regular/worktree, session name, first
//             message, and emit `session:create` with the right payload.
//
// The `buildSessionCreatePayload` helper extracted from CodingView's
// inline submit() captures the full contract; we test every branch.

import { describe, it, expect } from 'vitest';
import { buildSessionCreatePayload, type SessionCreateFormState } from '../src/views/CodingView.js';

function formState(overrides: Partial<SessionCreateFormState> = {}): SessionCreateFormState {
  return {
    workspaceId: 'ws-1',
    sessionName: 'demo',
    executor: 'claude',
    approvalMode: 'ask',
    mode: 'regular',
    baseBranch: '',
    composedBranch: '',
    firstMessage: '',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// SES-001 — regular session form (mode='regular')
// ---------------------------------------------------------------------------

describe('SES-001: regular-session payload from form state', () => {
  it('emits a minimal payload with mode=regular and no worktree fields', () => {
    const payload = buildSessionCreatePayload(formState());
    expect(payload).toEqual({
      workspaceId: 'ws-1',
      name: 'demo',
      executor: 'claude',
      approvalMode: 'ask',
      mode: 'regular',
    });
    // worktree-only fields must NOT appear.
    expect((payload as Record<string, unknown>).baseBranch).toBeUndefined();
    expect((payload as Record<string, unknown>).branch).toBeUndefined();
  });

  it('SES-001: trims the session name', () => {
    const payload = buildSessionCreatePayload(formState({ sessionName: '  spaces around  ' }));
    expect(payload.name).toBe('spaces around');
  });

  it('SES-001: includes firstMessage only when non-empty (after trim)', () => {
    expect(buildSessionCreatePayload(formState({ firstMessage: 'hi' })).firstMessage).toBe('hi');
    expect(buildSessionCreatePayload(formState({ firstMessage: '  hi  ' })).firstMessage).toBe('hi');
    expect(buildSessionCreatePayload(formState({ firstMessage: '   ' })).firstMessage).toBeUndefined();
    expect(buildSessionCreatePayload(formState({ firstMessage: '' })).firstMessage).toBeUndefined();
  });

  it('SES-001: every executor + approval mode combination round-trips', () => {
    for (const exec of ['claude', 'codex'] as const) {
      for (const mode of ['plan', 'ask', 'auto'] as const) {
        const payload = buildSessionCreatePayload(
          formState({ executor: exec, approvalMode: mode }),
        );
        expect(payload.executor).toBe(exec);
        expect(payload.approvalMode).toBe(mode);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// WT-001 — worktree session form (mode='worktree')
// ---------------------------------------------------------------------------

describe('WT-001: worktree-session payload from form state', () => {
  it('emits mode=worktree with the composed branch and the base branch', () => {
    const payload = buildSessionCreatePayload(formState({
      mode: 'worktree',
      baseBranch: 'main',
      composedBranch: 'worktree/feature-x',
    }));
    expect(payload).toEqual({
      workspaceId: 'ws-1',
      name: 'demo',
      executor: 'claude',
      approvalMode: 'ask',
      mode: 'worktree',
      baseBranch: 'main',
      branch: 'worktree/feature-x',
    });
  });

  it('WT-001: omits `branch` when composedBranch is empty (host auto-generates)', () => {
    // User cleared the suffix → form passes empty composedBranch → host
    // falls back to `worktree/<short-id>` server-side. Verify the
    // payload genuinely lacks the field (vs. having it as empty string).
    const payload = buildSessionCreatePayload(formState({
      mode: 'worktree',
      baseBranch: 'main',
      composedBranch: '',
    }));
    expect((payload as Record<string, unknown>).branch).toBeUndefined();
    expect(payload.baseBranch).toBe('main');
  });

  it('WT-001: omits `baseBranch` when not selected (host auto-detects default branch)', () => {
    const payload = buildSessionCreatePayload(formState({
      mode: 'worktree',
      baseBranch: '',
      composedBranch: 'worktree/feature-y',
    }));
    expect(payload.branch).toBe('worktree/feature-y');
    expect((payload as Record<string, unknown>).baseBranch).toBeUndefined();
  });

  it('WT-001: omits both `baseBranch` and `branch` when neither is supplied', () => {
    const payload = buildSessionCreatePayload(formState({
      mode: 'worktree',
      baseBranch: '',
      composedBranch: '',
    }));
    expect((payload as Record<string, unknown>).baseBranch).toBeUndefined();
    expect((payload as Record<string, unknown>).branch).toBeUndefined();
    expect(payload.mode).toBe('worktree');
  });

  it('WT-001: trims baseBranch (whitespace-only is treated as empty)', () => {
    const payload = buildSessionCreatePayload(formState({
      mode: 'worktree',
      baseBranch: '   ',
      composedBranch: 'worktree/y',
    }));
    expect((payload as Record<string, unknown>).baseBranch).toBeUndefined();

    const trimmed = buildSessionCreatePayload(formState({
      mode: 'worktree',
      baseBranch: '  main  ',
      composedBranch: 'worktree/y',
    }));
    expect(trimmed.baseBranch).toBe('main');
  });

  it('WT-001: worktree-only fields are NEVER attached when mode=regular even if state contains them', () => {
    // Defensive: if a user types in the BranchPicker, then switches back
    // to regular mode, the stale baseBranch/composedBranch state must
    // NOT leak into the payload.
    const payload = buildSessionCreatePayload(formState({
      mode: 'regular',
      baseBranch: 'main',
      composedBranch: 'worktree/leftover',
    }));
    expect(payload.mode).toBe('regular');
    expect((payload as Record<string, unknown>).baseBranch).toBeUndefined();
    expect((payload as Record<string, unknown>).branch).toBeUndefined();
  });

  it('WT-001: firstMessage applies to worktree mode as well', () => {
    const payload = buildSessionCreatePayload(formState({
      mode: 'worktree',
      baseBranch: 'main',
      composedBranch: 'worktree/feature-z',
      firstMessage: 'kick off the feature',
    }));
    expect(payload.firstMessage).toBe('kick off the feature');
  });
});
