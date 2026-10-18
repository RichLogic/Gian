/**
 * Deep-link focus for schedule confirmations (0.6.7): an OS/Inbox deep link
 * surfaces the EXACT confirmation card (over older pending ones) and the
 * resolve binds the observed Inbox ref. Without a focus the queue keeps
 * oldest-first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ScheduleConfirmationHost } from '../src/components/ScheduleConfirmations.js';
import {
  __resetScheduleConfirmations,
  focusScheduleConfirmation,
  getScheduleConfirmationsSnapshot,
  upsertScheduleConfirmation,
} from '../src/controllers/schedule-confirmations.js';
import { OperationDispatcherProvider } from '../src/operations/use-operations.js';
import type { OperationDispatcher } from '../src/operations/dispatcher.js';
import { makeConfirmation } from './schedule-fixtures.js';

const OLDER = makeConfirmation({
  id: 'conf-A',
  created_at: '2026-10-01T00:00:00.000Z',
  payload: { ...makeConfirmation().payload, name: 'Alpha schedule' },
});
const NEWER = makeConfirmation({
  id: 'conf-B',
  created_at: '2026-10-02T00:00:00.000Z',
  payload: { ...makeConfirmation().payload, name: 'Beta schedule' },
});

function fakeDispatcher() {
  const dispatch = vi.fn((name: string, input: unknown) => ({ id: `run-${(input as { confirmationId: string }).confirmationId}` }));
  return { dispatch } as unknown as OperationDispatcher;
}

function seed() {
  upsertScheduleConfirmation(OLDER);
  upsertScheduleConfirmation(NEWER);
}

describe('schedule confirmation deep-link focus', () => {
  beforeEach(() => __resetScheduleConfirmations());
  afterEach(() => __resetScheduleConfirmations());

  it('without a focus the oldest pending card leads', () => {
    seed();
    render(<OperationDispatcherProvider dispatcher={fakeDispatcher()}><ScheduleConfirmationHost /></OperationDispatcherProvider>);
    expect(screen.getByTestId('schedule-confirmation-name').textContent).toBe('Alpha schedule');
  });

  it('a deep link surfaces the exact confirmation and resolves it with the observed ref', async () => {
    seed();
    focusScheduleConfirmation('conf-B', { id: 'inbox-7', generation: 4 });
    const dispatcher = fakeDispatcher();
    const user = userEvent.setup();
    render(<OperationDispatcherProvider dispatcher={dispatcher}><ScheduleConfirmationHost /></OperationDispatcherProvider>);
    // B shows, not the older A — the deep link chose it.
    expect(screen.getByTestId('schedule-confirmation-name').textContent).toBe('Beta schedule');
    await user.click(screen.getByTestId('schedule-confirmation-approve'));
    expect(dispatcher.dispatch).toHaveBeenCalledWith('schedule.resolveConfirmation', {
      confirmationId: 'conf-B',
      decision: 'approve',
      expectedInbox: { id: 'inbox-7', generation: 4 },
    });
  });

  it('a focus whose id left pending clears itself and the queue leads again', async () => {
    seed();
    focusScheduleConfirmation('conf-B');
    // B resolves elsewhere: the upsert flips its status.
    upsertScheduleConfirmation({ ...NEWER, status: 'rejected' });
    render(<OperationDispatcherProvider dispatcher={fakeDispatcher()}><ScheduleConfirmationHost /></OperationDispatcherProvider>);
    expect(screen.getByTestId('schedule-confirmation-name').textContent).toBe('Alpha schedule');
    expect(getScheduleConfirmationsSnapshot().focus).toBeNull();
  });
});
