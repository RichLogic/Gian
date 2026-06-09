// Coverage for the TTY (Beta) Composer read-only redesign:
//   In TTY mode the model / effort / approval-mode controls are owned by the
//   live CLI, so the Composer shows them as a muted, non-interactive readout
//   with a single "Edit in CLI" link (→ onJumpToCli) instead of interactive
//   pills. The slash and attachment buttons are hidden in TTY (the CLI has its
//   own slash UI; the attach picker is a no-op there). Structured mode keeps
//   the full interactive control set.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session } from '@gian/shared';
import { Composer } from '../src/components/Composer.js';
import { LocaleProvider } from '../src/i18n/index.js';

vi.mock('../src/api.js', () => ({
  loadProxyModels: vi.fn().mockResolvedValue([]),
  loadSlashCommands: vi.fn().mockResolvedValue([]),
}));

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    name: 'demo',
    type: 'coding',
    workspace_id: 'ws-1',
    executor: 'claude',
    model: 'claude-opus-4-8',
    approval_mode: 'auto',
    thinking_effort: 'high',
    turns: 1,
    active_channel: 'web',
    status: 'idle',
    archived: 0,
    worktree_path: null,
    branch: null,
    base_branch: null,
    worktree_outcome: null,
    native_session_id: 'cc_abc',
    runtime_mode: 'structured',
    created_at: '2026-05-17T00:00:00.000Z',
    updated_at: '2026-05-17T00:00:00.000Z',
    ...overrides,
  } as Session;
}

function renderComposer(session: Session, onJumpToCli = vi.fn()) {
  render(
    <LocaleProvider locale="en">
      <Composer
        session={session}
        onSend={vi.fn()}
        onSendSkill={vi.fn()}
        onStop={vi.fn()}
        onQueueAdd={vi.fn()}
        onSetMode={vi.fn()}
        onSetModel={vi.fn()}
        onSetEffort={vi.fn()}
        onJumpToCli={onJumpToCli}
        disabled={false}
        executor="claude"
        workspaceId="ws-1"
      />
    </LocaleProvider>,
  );
  return { onJumpToCli };
}

describe('Composer TTY read-only controls', () => {
  beforeEach(() => { localStorage.clear(); });

  it('TTY: renders a read-only readout (model + mode) instead of interactive pills', () => {
    renderComposer(makeSession({ runtime_mode: 'tty' }));

    const meta = document.querySelector('.composer-tty-meta');
    expect(meta).not.toBeNull();
    // Model id (no proxy list → label falls back to the id) and the mode show.
    expect(meta!.querySelector('.ctm-model')?.textContent).toContain('claude-opus-4-8');
    expect(meta!.querySelector('.ctm-mode')?.textContent?.trim()).toBeTruthy();
    // Effort is shown as a text label (the session's thinking_effort).
    expect(meta!.querySelector('.ctm-effort-label')?.textContent).toContain('high');

    // The interactive controls are gone in TTY.
    expect(document.querySelector('.cmp-model-wrap')).toBeNull(); // model button
    expect(document.querySelector('.composer-mode')).toBeNull();  // PLAN/ASK/AUTO segment
    expect(document.querySelector('.slash-box')).toBeNull();      // slash button
    // No non-primary action buttons (slash / attachment / remote) — only Send.
    expect(document.querySelectorAll('.composer-act:not(.primary)').length).toBe(0);
    expect(document.querySelector('.composer-act.primary')).not.toBeNull(); // Send stays
  });

  it('TTY: the "Jump to CLI" link jumps to the CLI', async () => {
    const user = userEvent.setup();
    const { onJumpToCli } = renderComposer(makeSession({ runtime_mode: 'tty' }));

    await user.click(screen.getByRole('button', { name: /Jump to CLI/i }));
    expect(onJumpToCli).toHaveBeenCalledTimes(1);
  });

  it('structured: keeps the interactive model / mode / slash controls and no read-only readout', () => {
    renderComposer(makeSession({ runtime_mode: 'structured' }));

    expect(document.querySelector('.composer-tty-meta')).toBeNull();
    expect(document.querySelector('.cmp-model-wrap')).not.toBeNull();
    expect(document.querySelector('.composer-mode')).not.toBeNull();
    expect(document.querySelector('.slash-box')).not.toBeNull();
    // slash + attachment are present (no remote handler wired here).
    expect(document.querySelectorAll('.composer-act:not(.primary)').length).toBe(2);
  });
});
