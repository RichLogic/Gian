import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session, Workspace } from '@gian/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../src/i18n/index.js';
import { SessionMain } from '../src/views/SessionMain.js';
import type { QueueEntry, TranscriptItem } from '../src/types.js';
import { sessionContractFixture } from './fixtures/ws-contract.js';

vi.mock('../src/api.js', () => {
  const never = () => new Promise<never>(() => {});
  return {
    loadChanged: never,
    loadProxyModels: never,
    loadProxyCapabilities: never,
    loadSlashCommands: never,
    loadSessionSlashCommands: never,
    loadNativeConfig: never,
  };
});

const workspace: Workspace = {
  id: 'workspace-contract',
  name: 'Contract workspace',
  path: '/tmp/contract-workspace',
  sort_order: 0,
  hidden: 0,
  pinned: 0,
  created_at: '2026-08-08T00:00:00.000Z',
  updated_at: '2026-08-08T00:00:00.000Z',
};

const queuedFollowUp: QueueEntry[] = [{ id: 'queue-closed-session', text: 'queued follow-up' }];

function sessionCallbacks() {
  return {
    onSend: vi.fn(),
    onSendSkill: vi.fn(),
    onStop: vi.fn(),
    onApprove: vi.fn(),
    onQueueAdd: vi.fn(),
    onQueueRemove: vi.fn(),
    onQueueUpdate: vi.fn(),
    onQueueClear: vi.fn(),
    onQueueSendNow: vi.fn(),
    onSteer: vi.fn(),
    onSetMode: vi.fn(),
    onSetModel: vi.fn(),
    onSetEffort: vi.fn(),
    onSetServiceTier: vi.fn(),
    onSetNativeConfig: vi.fn(),
    onDelete: vi.fn(),
    onReopen: vi.fn(),
    onShowChanges: vi.fn(),
    onShowLastTurnChanges: vi.fn(),
  };
}

function sessionMainElement(
  session: Session,
  items: TranscriptItem[],
  queue: QueueEntry[],
  callbacks: ReturnType<typeof sessionCallbacks>,
) {
  return (
    <LocaleProvider locale="en">
      <SessionMain
        session={session}
        workspace={workspace}
        items={items}
        hydrated
        pending={false}
        queue={queue}
        workingTreeId={null}
        branch={null}
        {...callbacks}
      />
    </LocaleProvider>
  );
}

function expectReadOnlyQueue(): void {
  const drawer = screen.getByText('queued follow-up').closest('.queue-drawer');
  expect(drawer).not.toBeNull();
  expect(drawer!.querySelector('.qd-count')).toHaveTextContent('1');
  const queueUi = within(drawer as HTMLElement);
  expect(queueUi.queryByRole('button', { name: 'Send now' })).not.toBeInTheDocument();
  expect(queueUi.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
  expect(queueUi.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  expect(queueUi.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
}

function renderSession(session: Session, queue: QueueEntry[] = []) {
  const callbacks = sessionCallbacks();
  render(sessionMainElement(session, [], queue, callbacks));
  return callbacks;
}

describe('Session transcript isolation', () => {
  beforeEach(() => localStorage.clear());

  it('remounts transcript-local card state when the session changes', async () => {
    const callbacks = sessionCallbacks();
    const sessionA = sessionContractFixture({ id: 'session-a', status: 'done' });
    const sessionB = sessionContractFixture({ id: 'session-b', status: 'done' });
    const reasoning = (text: string): TranscriptItem => ({
      kind: 'reasoning', id: 'provider-reused-id', variant: 'full',
      text, ts: 1_000, turn: 1,
    });
    const view = render(sessionMainElement(sessionA, [reasoning('thought from A')], [], callbacks));

    await userEvent.click(screen.getByText('thought from A'));
    expect(view.container.querySelector('.trow-detail')).toHaveTextContent('thought from A');

    view.rerender(sessionMainElement(sessionB, [reasoning('thought from B')], [], callbacks));
    expect(screen.queryByText('thought from A')).not.toBeInTheDocument();
    expect(screen.getByText('thought from B')).toBeInTheDocument();
    expect(view.container.querySelector('.trow-detail')).toBeNull();
  });
});

describe('SES-COMPLETE-001: completed Session composer', () => {
  beforeEach(() => localStorage.clear());

  it('hard-disables input, exposes the reason, and offers the reopen action', async () => {
    const callbacks = renderSession(sessionContractFixture({
      status: 'done',
      completed_at: '2026-08-08T01:00:00.000Z',
    }), queuedFollowUp);

    expect(screen.getByText('This session is completed. Reopen it to send more messages.'))
      .toBeVisible();
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Attach files' })).toBeDisabled();
    expectReadOnlyQueue();

    await userEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    expect(callbacks.onReopen).toHaveBeenCalledTimes(1);
    expect(callbacks.onSend).not.toHaveBeenCalled();
    expect(callbacks.onQueueAdd).not.toHaveBeenCalled();
  });

  it('keeps an ordinary completed turn editable when the user completion flag is absent', () => {
    renderSession(sessionContractFixture({ status: 'done', completed_at: null }));

    expect(screen.getByRole('textbox')).toBeEnabled();
    expect(screen.queryByText('This session is completed. Reopen it to send more messages.'))
      .not.toBeInTheDocument();
  });
});

describe('WT-003: finalized worktree Session composer', () => {
  beforeEach(() => localStorage.clear());

  for (const outcome of ['merged', 'discarded'] as const) {
    it(`hard-disables input after the worktree is ${outcome}`, () => {
      const callbacks = renderSession(sessionContractFixture({
        status: 'done',
        branch: 'worktree/finalized',
        base_branch: 'main',
        worktree_path: null,
        worktree_outcome: outcome,
      }), queuedFollowUp);

      expect(document.querySelector(`.session-banner.${outcome}`)).toBeVisible();
      expect(screen.getByRole('textbox')).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Attach files' })).toBeDisabled();
      expectReadOnlyQueue();
      expect(callbacks.onSend).not.toHaveBeenCalled();
      expect(callbacks.onQueueAdd).not.toHaveBeenCalled();
    });
  }
});
