/**
 * Schedule create confirmations (Issue #51, contract L): the pending queue
 * is hydrated from REST, upserted by `schedule:confirmation` frames, and
 * resolved strictly sequentially — one card at a time — with approve/reject,
 * disabled-while-submitting, and retry on failure. Nothing here touches the
 * Provider Approval surface.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { LocaleProvider } from '../src/i18n/index.js';
import { ScheduleConfirmationHost } from '../src/components/ScheduleConfirmations.js';
import {
  __resetScheduleConfirmations,
  getScheduleConfirmationsSnapshot,
  hydrateScheduleConfirmations,
  pendingScheduleConfirmations,
  upsertScheduleConfirmation,
} from '../src/controllers/schedule-confirmations.js';
import { mockFetch } from './setup.js';
import { createOperationHarness } from './operation-test-utils.js';
import { createFetchRouter, jsonResponse, makeConfirmation, scheduleErrorResponse } from './schedule-fixtures.js';

function renderHost(harness: ReturnType<typeof createOperationHarness>) {
  const ui: ReactElement = (
    <LocaleProvider locale="en">
      <ScheduleConfirmationHost />
    </LocaleProvider>
  );
  return render(ui, { wrapper: harness.wrapper });
}

describe('schedule confirmation store', () => {
  beforeEach(() => __resetScheduleConfirmations());
  afterEach(() => __resetScheduleConfirmations());

  it('hydrates pending confirmations from REST (app start / reconnect)', async () => {
    const router = createFetchRouter([{
      match: (url, method) => url.startsWith('/api/schedule-confirmations') && method === 'GET',
      respond: () => jsonResponse({ confirmations: [makeConfirmation()] }),
    }]);
    mockFetch(router.handler);

    await hydrateScheduleConfirmations();
    expect(pendingScheduleConfirmations().map(c => c.id)).toEqual(['conf-1']);
    expect(router.calls[0]!.url).toContain('status=pending');
  });

  it('keeps the last known queue when hydration fails', async () => {
    upsertScheduleConfirmation(makeConfirmation());
    mockFetch(createFetchRouter([]).handler); // every route 404s
    await hydrateScheduleConfirmations();
    expect(pendingScheduleConfirmations()).toHaveLength(1);
    expect(getScheduleConfirmationsSnapshot().hydrated).toBe(true);
  });
});

describe('ScheduleConfirmationHost', () => {
  beforeEach(() => __resetScheduleConfirmations());
  afterEach(() => __resetScheduleConfirmations());

  it('renders name, full prompt, trigger, timezone, next runs, conversation, and risk note', async () => {
    mockFetch(createFetchRouter([]).handler);
    renderHost(createOperationHarness());
    expect(screen.queryByTestId('schedule-confirmation')).toBeNull();

    act(() => upsertScheduleConfirmation(makeConfirmation()));
    const card = await screen.findByTestId('schedule-confirmation');
    expect(card).toHaveTextContent('Approve new schedule');
    expect(screen.getByTestId('schedule-confirmation-name')).toHaveTextContent('Nightly digest');
    // The FULL prompt is visible before approval (expanded by default).
    expect(screen.getByTestId('schedule-confirmation-prompt'))
      .toHaveTextContent('Summarize the overnight CI results and post the digest.');
    expect(screen.getByTestId('schedule-confirmation-trigger')).toHaveTextContent('Cron · 0 9 * * *');
    expect(card).toHaveTextContent('Asia/Shanghai');
    expect(screen.getByTestId('schedule-confirmation-occurrences').children).toHaveLength(3);
    expect(screen.getByTestId('schedule-confirmation-conversation'))
      .toHaveTextContent('Release watch — Claude · Gian');
    expect(screen.getByTestId('schedule-confirmation-risk')).toHaveTextContent('quota');

    // Collapse swaps in the Host's summary.
    await userEvent.click(screen.getByTestId('schedule-confirmation-prompt-toggle'));
    expect(screen.getByTestId('schedule-confirmation-prompt'))
      .toHaveTextContent('Summarize the overnight CI results…');
  });

  it('approves via REST resolve and drops the card', async () => {
    const router = createFetchRouter([{
      match: (url, method) => url === '/api/schedule-confirmations/conf-1/resolve' && method === 'POST',
      respond: () => jsonResponse(makeConfirmation({
        status: 'approved',
        schedule_id: 'sch-9',
        resolved_at: '2026-09-03T04:01:00.000Z',
      })),
    }]);
    mockFetch(router.handler);
    renderHost(createOperationHarness());
    act(() => upsertScheduleConfirmation(makeConfirmation()));

    await userEvent.click(await screen.findByTestId('schedule-confirmation-approve'));
    await waitFor(() => {
      expect(router.calls.some(call => call.url.endsWith('/resolve'))).toBe(true);
    });
    const call = router.calls.find(entry => entry.url.endsWith('/resolve'))!;
    expect(call.body).toEqual({ decision: 'approve' });
    await waitFor(() => {
      expect(screen.queryByTestId('schedule-confirmation')).toBeNull();
    });
    expect(pendingScheduleConfirmations()).toHaveLength(0);
  });

  it('rejects via REST resolve', async () => {
    const router = createFetchRouter([{
      match: (url, method) => url === '/api/schedule-confirmations/conf-1/resolve' && method === 'POST',
      respond: () => jsonResponse(makeConfirmation({ status: 'rejected' })),
    }]);
    mockFetch(router.handler);
    renderHost(createOperationHarness());
    act(() => upsertScheduleConfirmation(makeConfirmation()));

    await userEvent.click(await screen.findByTestId('schedule-confirmation-reject'));
    await waitFor(() => {
      expect(router.calls.some(call => (call.body as { decision?: string })?.decision === 'reject')).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('schedule-confirmation')).toBeNull();
    });
  });

  it('keeps the card with an error on failure and retries', async () => {
    let fail = true;
    const router = createFetchRouter([{
      match: (url, method) => url === '/api/schedule-confirmations/conf-1/resolve' && method === 'POST',
      respond: () => fail
        ? scheduleErrorResponse('INTERNAL_ERROR', 500, 'host busy')
        : jsonResponse(makeConfirmation({ status: 'approved', schedule_id: 'sch-9' })),
    }]);
    mockFetch(router.handler);
    renderHost(createOperationHarness());
    act(() => upsertScheduleConfirmation(makeConfirmation()));

    await userEvent.click(await screen.findByTestId('schedule-confirmation-approve'));
    await screen.findByTestId('schedule-confirmation-error');
    // Card stays actionable.
    expect(screen.getByTestId('schedule-confirmation-approve')).toBeEnabled();

    fail = false;
    await userEvent.click(screen.getByTestId('schedule-confirmation-approve'));
    await waitFor(() => {
      expect(screen.queryByTestId('schedule-confirmation')).toBeNull();
    });
    expect(router.calls.filter(call => call.url.endsWith('/resolve'))).toHaveLength(2);
  });

  it('processes multiple pending confirmations strictly in order', async () => {
    const router = createFetchRouter([{
      match: (url, method) => url.includes('/resolve') && method === 'POST',
      respond: call => {
        const id = call.url.split('/api/schedule-confirmations/')[1]!.split('/')[0]!;
        return jsonResponse(makeConfirmation({ id, status: 'rejected' }));
      },
    }]);
    mockFetch(router.handler);
    renderHost(createOperationHarness());
    act(() => {
      upsertScheduleConfirmation(makeConfirmation({ id: 'conf-1', created_at: '2026-09-03T04:00:00.000Z' }));
      upsertScheduleConfirmation(makeConfirmation({ id: 'conf-2', created_at: '2026-09-03T04:02:00.000Z' }));
    });

    // Only the oldest pending card is shown; the count advertises the rest.
    const card = await screen.findByTestId('schedule-confirmation');
    expect(card).toHaveTextContent('Nightly digest');
    expect(screen.getByTestId('schedule-confirmation-more')).toHaveTextContent('1 more waiting');

    // Each confirmation must start with its full prompt visible, even when the
    // user collapsed the previous card.
    await userEvent.click(screen.getByTestId('schedule-confirmation-prompt-toggle'));
    expect(screen.getByTestId('schedule-confirmation-prompt-toggle')).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(screen.getByTestId('schedule-confirmation-reject'));
    // The second card appears only after the first resolves.
    await waitFor(() => {
      expect(screen.queryByTestId('schedule-confirmation-more')).toBeNull();
      expect(screen.getByTestId('schedule-confirmation')).toBeInTheDocument();
    });
    expect(screen.getByTestId('schedule-confirmation-prompt-toggle')).toHaveAttribute('aria-expanded', 'true');
    expect(router.calls[0]!.url).toContain('conf-1');
  });
});
