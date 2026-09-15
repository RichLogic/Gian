/**
 * Schedule detail (Issue #51): Definition editing through the Codex-style
 * structured frequency card (2026-09-15 owner: Repeat = once/interval/custom,
 * custom compiles to cron — no raw cron input, no timezone field, system
 * timezone on save), the read-only "Runs in" row with the Open chat jump,
 * expected_revision + Idempotency-Key on save, the 409 conflict notice +
 * canonical reload, the paginated run log covering every status, bound-run
 * Turn navigation, and the hidden Fork transcript opening inline without
 * touching the session list.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { Session } from '@gian/shared';
import { LocaleProvider } from '../src/i18n/index.js';
import { ScheduleDetail } from '../src/views/ScheduleDetail.js';
import { notifyScheduleChanged } from '../src/presentation/schedule-sync.js';
import { mockFetch } from './setup.js';
import { createOperationHarness } from './operation-test-utils.js';
import {
  createFetchRouter,
  jsonResponse,
  makeRun,
  makeSchedule,
  scheduleErrorResponse,
} from './schedule-fixtures.js';

const CONTROL_SESSION = {
  id: 'session-1',
  executor: 'claude',
  status: 'done',
} as unknown as Session;

function renderDetail(
  harness: ReturnType<typeof createOperationHarness>,
  props: Partial<Parameters<typeof ScheduleDetail>[0]> = {},
) {
  const ui: ReactElement = (
    <LocaleProvider locale="en">
      <ScheduleDetail
        scheduleId="sch-1"
        sessions={[CONTROL_SESSION]}
        onBack={() => undefined}
        onOpenScheduledTurn={() => undefined}
        onOpenConversation={() => undefined}
        {...props}
      />
    </LocaleProvider>
  );
  return render(ui, { wrapper: harness.wrapper });
}

/** Standard routes: definition GET + runs GET; extra routes prepend. */
function detailRouter(options: {
  schedule?: ReturnType<typeof makeSchedule>;
  runs?: ReturnType<typeof makeRun>[];
  runsCursor?: string | null;
  patch?: (call: { body: unknown }) => Response;
} = {}) {
  const schedule = options.schedule ?? makeSchedule();
  return createFetchRouter([
    {
      match: (url, method) => url === '/api/schedules/sch-1' && method === 'PATCH',
      respond: call => options.patch
        ? options.patch(call)
        : jsonResponse({ ...schedule, revision: schedule.revision + 1 }),
    },
    {
      match: (url, method) => url.startsWith('/api/schedules/sch-1/runs') && method === 'GET',
      respond: () => jsonResponse({
        runs: options.runs ?? [],
        next_cursor: options.runsCursor ?? null,
      }),
    },
    {
      match: (url, method) => url === '/api/schedules/sch-1' && method === 'GET',
      respond: () => jsonResponse(schedule),
    },
  ]);
}

describe('ScheduleDetail Definition tab', () => {
  it('fills the shared panel-2 shell: Close deselects, Back only in the narrow swap', async () => {
    const router = detailRouter();
    mockFetch(router.handler);
    const onBack = vi.fn();
    renderDetail(createOperationHarness(), { onBack });
    await screen.findByTestId('schedule-field-name');

    // Wide layout: no Back button, the Close (X) is the dismiss affordance.
    expect(screen.queryByTestId('schedule-back')).toBeNull();
    await userEvent.click(screen.getByTestId('schedule-close'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('shows the Back chevron alongside Close when showBack (narrow swap)', async () => {
    const router = detailRouter();
    mockFetch(router.handler);
    const onBack = vi.fn();
    renderDetail(createOperationHarness(), { onBack, showBack: true });
    await screen.findByTestId('schedule-field-name');

    await userEvent.click(screen.getByTestId('schedule-back'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('loads the definition, edits fields, and saves with expected_revision', async () => {
    const router = detailRouter();
    mockFetch(router.handler);
    renderDetail(createOperationHarness());

    const nameInput = await screen.findByTestId('schedule-field-name');
    expect(nameInput).toHaveValue('Nightly digest');
    // Immutable binding is rendered read-only in the "Runs in" row, next to
    // the Open chat jump — never as an input.
    expect(screen.getByTestId('schedule-conversation')).toHaveTextContent('Release watch — Claude · Gian');
    expect(screen.getByTestId('schedule-open-chat')).toBeEnabled();
    // No timezone field (2026-09-15 owner): saves pin the system timezone.
    expect(screen.queryByTestId('schedule-field-timezone')).toBeNull();

    const save = screen.getByTestId('schedule-save');
    expect(save).toBeDisabled();
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Morning digest');
    expect(save).toBeEnabled();
    await userEvent.click(save);

    await waitFor(() => {
      expect(router.calls.some(call => call.method === 'PATCH')).toBe(true);
    });
    const patch = router.calls.find(call => call.method === 'PATCH')!;
    expect(patch.headers['idempotency-key']).toBeTruthy();
    expect(patch.body).toMatchObject({
      expected_revision: 3,
      name: 'Morning digest',
      trigger: { kind: 'cron', expression: '0 9 * * *' },
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      misfire_policy: 'skip',
    });
    // Canonical reload follows the confirmed save.
    await waitFor(() => {
      expect(router.calls.filter(call => call.url === '/api/schedules/sch-1' && call.method === 'GET').length)
        .toBeGreaterThan(1);
    });
  });

  it('opens the control conversation from the Runs in row', async () => {
    const router = detailRouter();
    mockFetch(router.handler);
    const onOpenConversation = vi.fn();
    renderDetail(createOperationHarness(), { onOpenConversation });
    await screen.findByTestId('schedule-field-name');

    await userEvent.click(screen.getByTestId('schedule-open-chat'));
    expect(onOpenConversation).toHaveBeenCalledWith('session-1');
  });

  it('disables Open chat when the control conversation is gone', async () => {
    const router = detailRouter();
    mockFetch(router.handler);
    renderDetail(createOperationHarness(), { sessions: [] });
    await screen.findByTestId('schedule-field-name');

    expect(screen.getByTestId('schedule-open-chat')).toBeDisabled();
  });

  it('edits all three repeat modes (custom compiles to cron)', async () => {
    const router = detailRouter();
    mockFetch(router.handler);
    renderDetail(createOperationHarness());
    await screen.findByTestId('schedule-field-name');

    // interval: value + unit → every_ms (2 hours).
    await userEvent.selectOptions(screen.getByTestId('schedule-repeat'), 'interval');
    const value = screen.getByTestId('schedule-trigger-interval-value');
    await userEvent.clear(value);
    await userEvent.type(value, '2');
    await userEvent.selectOptions(screen.getByTestId('schedule-trigger-interval-unit'), 'hours');
    await userEvent.click(screen.getByTestId('schedule-save'));
    await waitFor(() => {
      const patch = router.calls.find(call => call.method === 'PATCH');
      expect(patch?.body).toMatchObject({
        trigger: { kind: 'interval', every_ms: 7_200_000 },
      });
    });

    // once: datetime-local → RFC3339 instant.
    await userEvent.selectOptions(screen.getByTestId('schedule-repeat'), 'once');
    const at = screen.getByTestId('schedule-trigger-once-at');
    await userEvent.clear(at);
    await userEvent.type(at, '2026-10-01T08:30');
    await userEvent.click(screen.getByTestId('schedule-save'));
    await waitFor(() => {
      const patches = router.calls.filter(call => call.method === 'PATCH');
      const last = patches[patches.length - 1]!;
      expect((last.body as { trigger: { kind: string; at: string } }).trigger.kind).toBe('once');
      expect((last.body as { trigger: { at: string } }).trigger.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    // custom daily: structured time row → compiled cron expression.
    await userEvent.selectOptions(screen.getByTestId('schedule-repeat'), 'custom');
    await userEvent.selectOptions(screen.getByTestId('schedule-repeats'), 'daily');
    // jsdom sanitizes <input type="time"> per keystroke, so set the final
    // valid value in one change event instead of typing.
    fireEvent.change(screen.getByTestId('schedule-custom-time'), { target: { value: '09:30' } });
    await userEvent.click(screen.getByTestId('schedule-save'));
    await waitFor(() => {
      const patches = router.calls.filter(call => call.method === 'PATCH');
      expect(patches[patches.length - 1]!.body).toMatchObject({
        trigger: { kind: 'cron', expression: '30 9 * * *' },
      });
    });

    // custom hourly: every 2 hours at minute 5.
    await userEvent.selectOptions(screen.getByTestId('schedule-repeats'), 'hourly');
    // The onChange clamps empty strings back to the minimum while typing, so
    // set the final values with single change events.
    fireEvent.change(screen.getByTestId('schedule-custom-every'), { target: { value: '2' } });
    fireEvent.change(screen.getByTestId('schedule-custom-minute'), { target: { value: '5' } });
    await userEvent.click(screen.getByTestId('schedule-save'));
    await waitFor(() => {
      const patches = router.calls.filter(call => call.method === 'PATCH');
      expect(patches[patches.length - 1]!.body).toMatchObject({
        trigger: { kind: 'cron', expression: '5 */2 * * *' },
      });
    });
  });

  it('shows an unparseable cron read-only until converted to structured editing', async () => {
    const router = detailRouter({
      schedule: makeSchedule({ trigger: { kind: 'cron', expression: '0 9 * * 1-5' } }),
    });
    mockFetch(router.handler);
    renderDetail(createOperationHarness());
    await screen.findByTestId('schedule-field-name');

    // The raw expression renders read-only; the structured rows stay hidden.
    expect(screen.getByTestId('schedule-cron-raw')).toHaveTextContent('0 9 * * 1-5');
    expect(screen.queryByTestId('schedule-repeats')).toBeNull();

    await userEvent.click(screen.getByTestId('schedule-cron-convert'));
    expect(screen.getByTestId('schedule-repeats')).toBeInTheDocument();

    // Saving after the conversion compiles the default structured spec.
    await userEvent.click(screen.getByTestId('schedule-save'));
    await waitFor(() => {
      const patch = router.calls.find(call => call.method === 'PATCH');
      expect(patch?.body).toMatchObject({
        trigger: { kind: 'cron', expression: '0 9 * * *' },
      });
    });
  });

  it('preserves an interval anchor when editing unrelated fields', async () => {
    const anchor = '2026-09-01T00:00:00.000Z';
    const router = detailRouter({
      schedule: makeSchedule({
        trigger: { kind: 'interval', every_ms: 3_600_000, anchor_at: anchor },
      }),
    });
    mockFetch(router.handler);
    renderDetail(createOperationHarness());

    const nameInput = await screen.findByTestId('schedule-field-name');
    await userEvent.type(nameInput, ' updated');
    await userEvent.click(screen.getByTestId('schedule-save'));

    await waitFor(() => {
      const patch = router.calls.find(call => call.method === 'PATCH');
      expect(patch?.body).toMatchObject({
        trigger: { kind: 'interval', every_ms: 3_600_000, anchor_at: anchor },
      });
    });
  });

  it('blocks an interval below the 5-minute floor', async () => {
    const router = detailRouter();
    mockFetch(router.handler);
    renderDetail(createOperationHarness());
    await screen.findByTestId('schedule-field-name');

    await userEvent.selectOptions(screen.getByTestId('schedule-repeat'), 'interval');
    const value = screen.getByTestId('schedule-trigger-interval-value');
    await userEvent.clear(value);
    await userEvent.type(value, '1');
    expect(screen.getByTestId('schedule-interval-hint')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('schedule-save'));
    expect(screen.getByTestId('schedule-form-error')).toHaveTextContent('minimum interval is 5 minutes');
    expect(router.calls.some(call => call.method === 'PATCH')).toBe(false);
  });

  it('shows the conflict notice and reloads canonical state on a 409', async () => {
    const router = detailRouter({
      patch: () => scheduleErrorResponse('SCHEDULE_REVISION_CONFLICT', 409, 'stale revision'),
    });
    mockFetch(router.handler);
    renderDetail(createOperationHarness());

    const nameInput = await screen.findByTestId('schedule-field-name');
    await userEvent.type(nameInput, 'x');
    await userEvent.click(screen.getByTestId('schedule-save'));

    await screen.findByTestId('schedule-conflict');
    expect(screen.getByTestId('schedule-conflict'))
      .toHaveTextContent('changed elsewhere');
    // The conflict reloads the canonical definition.
    await waitFor(() => {
      expect(router.calls.filter(call => call.url === '/api/schedules/sch-1' && call.method === 'GET').length)
        .toBeGreaterThan(1);
    });
  });

  it('renders archived schedules read-only', async () => {
    const router = detailRouter({
      schedule: makeSchedule({ status: 'archived', archived_at: '2026-09-02T00:00:00.000Z' }),
    });
    mockFetch(router.handler);
    renderDetail(createOperationHarness());
    const nameInput = await screen.findByTestId('schedule-field-name');
    expect(nameInput).toBeDisabled();
    expect(screen.queryByTestId('schedule-save')).toBeNull();
  });
});

describe('ScheduleDetail Runs tab', () => {
  const ALL_STATUSES = [
    'scheduled', 'starting', 'running', 'waiting_interaction', 'succeeded',
    'failed', 'interrupted', 'skipped_overlap', 'missed', 'unknown',
  ] as const;

  it('renders every run status with timing, mode, and result', async () => {
    const runs = ALL_STATUSES.map((status, index) => makeRun({
      id: `run-${status}`,
      status,
      execution_mode: index % 2 === 0 ? 'bound_session' : 'fork',
      ...(status === 'failed' ? { error_code: 'SCHEDULE_FORK_FAILED', summary: null } : {}),
    }));
    const router = detailRouter({ runs });
    mockFetch(router.handler);
    renderDetail(createOperationHarness());

    await userEvent.click(await screen.findByTestId('schedule-tab-runs'));
    await screen.findByTestId('schedule-runs');
    for (const status of ALL_STATUSES) {
      expect(screen.getByTestId(`schedule-run-run-${status}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('schedule-run-run-failed')).toHaveTextContent('Fork failed');
    expect(screen.getByTestId('schedule-run-run-succeeded')).toHaveTextContent('Posted the digest.');
  });

  it('paginates the run log with the cursor', async () => {
    const router = createFetchRouter([
      {
        match: (url, method) => url.startsWith('/api/schedules/sch-1/runs') && method === 'GET',
        respond: call => call.url.includes('cursor=rc-2')
          ? jsonResponse({ runs: [makeRun({ id: 'run-old' })], next_cursor: null })
          : jsonResponse({ runs: [makeRun({ id: 'run-new' })], next_cursor: 'rc-2' }),
      },
      {
        match: (url, method) => url === '/api/schedules/sch-1' && method === 'GET',
        respond: () => jsonResponse(makeSchedule()),
      },
    ]);
    mockFetch(router.handler);
    renderDetail(createOperationHarness());

    await userEvent.click(await screen.findByTestId('schedule-tab-runs'));
    await screen.findByTestId('schedule-run-run-new');
    await userEvent.click(screen.getByTestId('schedule-runs-load-more'));
    await screen.findByTestId('schedule-run-run-old');
    expect(screen.getByTestId('schedule-run-run-new')).toBeInTheDocument();
  });

  it('opens a bound_session Run in its control conversation', async () => {
    const router = detailRouter({ runs: [makeRun()] });
    mockFetch(router.handler);
    const onOpenScheduledTurn = vi.fn();
    renderDetail(createOperationHarness(), { onOpenScheduledTurn });

    await userEvent.click(await screen.findByTestId('schedule-tab-runs'));
    await userEvent.click(await screen.findByTestId('schedule-run-open-run-1'));
    expect(onOpenScheduledTurn).toHaveBeenCalledWith('session-1', 'run-1');
  });

  it('opens a fork Run transcript inline and returns to the run log', async () => {
    const forkRun = makeRun({
      id: 'run-fork',
      execution_mode: 'fork',
      target_session_id: 'fork-session-9',
      fork_anchor: { turn_id: 'turn-0', source_turn_id: 'pt-0' },
    });
    const router = createFetchRouter([
      {
        match: (url, method) => url.startsWith('/api/schedules/sch-1/runs') && method === 'GET',
        respond: () => jsonResponse({ runs: [forkRun], next_cursor: null }),
      },
      {
        match: (url, method) => url === '/api/sessions/fork-session-9/events' && method === 'GET',
        respond: () => jsonResponse({
          events: [{
            session_id: 'fork-session-9',
            turn: 1,
            call_id: 'c-1',
            event: 'user_message',
            ts: 1,
            data: {
              text: 'Summarize the overnight CI results.',
              scheduled_task: { schedule_id: 'sch-1', run_id: 'run-fork', schedule_name: 'Nightly digest' },
            },
          }],
          nextCursor: null,
          hasMore: false,
        }),
      },
      {
        match: (url, method) => url === '/api/schedules/sch-1' && method === 'GET',
        respond: () => jsonResponse(makeSchedule()),
      },
    ]);
    mockFetch(router.handler);
    const onOpenScheduledTurn = vi.fn();
    renderDetail(createOperationHarness(), { onOpenScheduledTurn });

    await userEvent.click(await screen.findByTestId('schedule-tab-runs'));
    await userEvent.click(await screen.findByTestId('schedule-run-open-run-fork'));

    // The hidden Fork transcript renders inline from the events API — the
    // conversation surface was NOT opened for it.
    await screen.findByTestId('schedule-fork-transcript');
    expect(onOpenScheduledTurn).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByText('Summarize the overnight CI results.')).toBeInTheDocument();
    });

    const beforeRefresh = router.calls.filter(call => call.url.includes('/events')).length;
    act(() => notifyScheduleChanged({
      type: 'schedule:changed',
      reason: 'run_updated',
      schedule_id: 'sch-1',
      revision: 4,
      run_id: 'run-fork',
    }));
    await waitFor(() => {
      expect(router.calls.filter(call => call.url.includes('/events')).length)
        .toBeGreaterThan(beforeRefresh);
    });

    await userEvent.click(screen.getByTestId('schedule-fork-back'));
    await screen.findByTestId('schedule-run-run-fork');
  });
});
