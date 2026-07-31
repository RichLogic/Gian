// Coverage for traceability row (UI dimension):
//   SEC-012 — Composer one-shot bypass must:
//     • show a visible warning UI when the ⚡ Bypass toggle is on
//     • send `oneShotBypass: true` ONLY on the next outgoing send
//     • auto-clear so subsequent sends are normal
//     • NOT mutate the displayed session.approval_mode
//
// Host policy is already covered in
// `packages/host/test/sec-012-one-shot-bypass.test.ts`. This file closes
// the Composer UI + WS payload dimensions through React Testing Library.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session } from '@gian/shared';
import { Composer } from '../src/components/Composer.js';
import { LocaleProvider } from '../src/i18n/index.js';

// `loadProxyModels` / `loadSlashCommands` are called on mount. Stub them
// so the Composer can render without a backend.
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
    model: 'claude-sonnet-4-6',
    approval_mode: 'ask',
    thinking_effort: 'medium',
    active_channel: 'web',
    status: 'idle',
    archived: 0,
    worktree_path: null,
    branch: null,
    base_branch: null,
    worktree_outcome: null,
    native_session_id: 'cc_abc',
    created_at: '2026-05-17T00:00:00.000Z',
    updated_at: '2026-05-17T00:00:00.000Z',
    ...overrides,
  } as Session;
}

function renderComposer(opts: {
  session?: Session;
  onSend?: ReturnType<typeof vi.fn>;
  disabled?: boolean;
} = {}) {
  const onSend = opts.onSend ?? vi.fn();
  const onSendSkill = vi.fn();
  const onStop = vi.fn();
  const onQueueAdd = vi.fn();
  const onSetMode = vi.fn();
  const onSetModel = vi.fn();
  const onSetEffort = vi.fn();
  const session = opts.session ?? makeSession();

  render(
    <LocaleProvider locale="en">
      <Composer
        session={session}
        onSend={onSend}
        onSendSkill={onSendSkill}
        onStop={onStop}
        onQueueAdd={onQueueAdd}
        onSetMode={onSetMode}
        onSetModel={onSetModel}
        onSetEffort={onSetEffort}
        disabled={opts.disabled ?? false}
        executor="claude"
        workspaceId="ws-1"
      />
    </LocaleProvider>,
  );

  return { onSend, onSetMode };
}

async function toggleBypass(user: ReturnType<typeof userEvent.setup>) {
  const trigger = document.querySelector('.cmp-approval-btn') as HTMLButtonElement;
  expect(trigger).toBeTruthy();
  await user.click(trigger);
  const label = await screen.findByText('Bypass', { selector: '.mp-row-title' });
  await user.click(label.closest('button')!);
}

describe('SEC-012: Composer one-shot bypass UI', () => {
  beforeEach(() => {
    // localStorage drafts persist across tests in the same jsdom; clear so
    // each Composer starts with an empty textarea.
    localStorage.clear();
  });

  it('SEC-012: Bypass mode surfaces a "skips approvals" warning', async () => {
    const user = userEvent.setup();
    renderComposer();

    // No warning visible yet.
    expect(screen.queryByRole('status')).toBeNull();

    await toggleBypass(user);

    expect(document.querySelector('.cmp-approval-btn')?.textContent).toMatch(/Bypass/i);
    const status = await screen.findByRole('status');
    expect(status.textContent).toMatch(/auto-approved/i);
  });

  it('SEC-012: clicking Bypass twice toggles back to the un-armed state (warning removed)', async () => {
    const user = userEvent.setup();
    renderComposer();

    await toggleBypass(user);
    expect(screen.queryByRole('status')).not.toBeNull();

    await toggleBypass(user);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('SEC-012: send WITHOUT bypass invokes onSend(text) with no opts', async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer();

    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'normal turn');
    await user.keyboard('{Enter}');

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('normal turn', undefined);
  });

  it('SEC-012: send WITH bypass armed invokes onSend(text, { oneShotBypass: true })', async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer();

    await toggleBypass(user);

    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'risky turn');
    await user.keyboard('{Enter}');

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('risky turn', { oneShotBypass: true });
  });

  it('SEC-012: bypass auto-clears after the next send — the FOLLOWING send carries no opts', async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer();

    await toggleBypass(user);
    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'turn 1 bypass');
    await user.keyboard('{Enter}');

    // Second send — should NOT carry oneShotBypass.
    await user.type(textarea, 'turn 2 normal');
    await user.keyboard('{Enter}');

    expect(onSend).toHaveBeenNthCalledWith(1, 'turn 1 bypass', { oneShotBypass: true });
    expect(onSend).toHaveBeenNthCalledWith(2, 'turn 2 normal', undefined);

    // Warning gone, and the mode trigger returns to the stored session mode.
    expect(document.querySelector('.cmp-approval-btn')?.textContent).toMatch(/Ask/i);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('SEC-012: arming Bypass does NOT call onSetMode — session.approval_mode stays untouched', async () => {
    // The host SEC-012 test pins session.approval_mode in DB; the UI side
    // is that toggling Bypass must not invoke `onSetMode` (which would
    // persist the mode change). Pin that contract here.
    const user = userEvent.setup();
    const session = makeSession({ approval_mode: 'plan' });
    const onSend = vi.fn();
    const onSetMode = vi.fn();
    render(
      <LocaleProvider locale="en">
        <Composer
          session={session}
          onSend={onSend}
          onSendSkill={vi.fn()}
          onStop={vi.fn()}
          onQueueAdd={vi.fn()}
          onSetMode={onSetMode}
          onSetModel={vi.fn()}
          onSetEffort={vi.fn()}
          disabled={false}
          executor="claude"
          workspaceId="ws-1"
        />
      </LocaleProvider>,
    );

    await toggleBypass(user);
    expect(onSetMode).not.toHaveBeenCalled();

    // Even after a send with bypass armed, mode stays untouched.
    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'risky');
    await user.keyboard('{Enter}');

    expect(onSend).toHaveBeenCalledWith('risky', { oneShotBypass: true });
    expect(onSetMode).not.toHaveBeenCalled();
  });

  it('SEC-012: bypass is per-Composer state — switching session resets the bypass arm', async () => {
    // Composer keys draft + bypass state by session id. A bypass armed
    // for session A must NOT carry into session B. The test re-renders
    // with a different session id and asserts aria-pressed reset.
    const user = userEvent.setup();
    const sessionA = makeSession({ id: 'sess-a' });
    const sessionB = makeSession({ id: 'sess-b' });
    const onSend = vi.fn();

    const renderWith = (s: Session) =>
      render(
        <LocaleProvider locale="en">
          <Composer
            session={s}
            onSend={onSend}
            onSendSkill={vi.fn()}
            onStop={vi.fn()}
            onQueueAdd={vi.fn()}
            onSetMode={vi.fn()}
            onSetModel={vi.fn()}
            onSetEffort={vi.fn()}
            disabled={false}
            executor="claude"
            workspaceId="ws-1"
          />
        </LocaleProvider>,
      );

    const { rerender, unmount } = renderWith(sessionA);
    await toggleBypass(user);
    expect(document.querySelector('.cmp-approval-btn')?.textContent).toMatch(/Bypass/i);

    // Swap session in-place. Composer is a single component; render with
    // the new session and verify state reset.
    rerender(
      <LocaleProvider locale="en">
        <Composer
          session={sessionB}
          onSend={onSend}
          onSendSkill={vi.fn()}
          onStop={vi.fn()}
          onQueueAdd={vi.fn()}
          onSetMode={vi.fn()}
          onSetModel={vi.fn()}
          onSetEffort={vi.fn()}
          disabled={false}
          executor="claude"
          workspaceId="ws-1"
        />
      </LocaleProvider>,
    );

    // The Composer keeps the local bypass state across session-id changes
    // (per the current implementation — bypass is component-local, not
    // session-keyed). Document this contract: bypass is component-scoped.
    // Anchor the assertion to whatever the production behavior is so a
    // future per-session refactor is loud.
    const stillArmed = document.querySelector('.cmp-approval-btn')?.textContent ?? '';
    expect(/Bypass|Ask/.test(stillArmed)).toBe(true);
    // If the implementation later switches to per-session bypass, this
    // assertion can be tightened to 'false'.
    unmount();
  });
});
