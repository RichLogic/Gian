/**
 * Timer list page (Issue #51): the five semantic columns, status filter,
 * cursor pagination, loading/empty/error/offline states, row actions with
 * stable Idempotency-Keys, archive's confirmation gate, schedule:changed
 * invalidation, the panel-2 detail open/close (wide) and swap/Back (narrow)
 * layouts, and the zh locale.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState, type ReactElement } from 'react';
import { LocaleProvider } from '../src/i18n/index.js';
import { TimerView } from '../src/views/TimerView.js';
import { notifyScheduleChanged } from '../src/presentation/schedule-sync.js';
import { __resetFeedback, getSnapshot, resolveConfirm } from '../src/feedback.js';
import { mockFetch } from './setup.js';
import { createOperationHarness } from './operation-test-utils.js';
import {
  createFetchRouter,
  jsonResponse,
  makeSchedule,
  scheduleErrorResponse,
  scheduleListResponse,
} from './schedule-fixtures.js';

function renderTimer(
  harness: ReturnType<typeof createOperationHarness>,
  props: Partial<Parameters<typeof TimerView>[0]> = {},
  locale: 'en' | 'zh-CN' = 'en',
) {
  const ui: ReactElement = (
    <LocaleProvider locale={locale}>
      <TimerView
        sessions={[]}
        selectedScheduleId={null}
        onSelectSchedule={() => undefined}
        onOpenScheduledTurn={() => undefined}
        onCreateSchedule={() => undefined}
        {...props}
      />
    </LocaleProvider>
  );
  return render(ui, { wrapper: harness.wrapper });
}

/** App owns the selection; this wrapper reproduces that controlled wiring so
 *  row clicks actually open the panel and close/back deselects. */
function StatefulTimerView(props: Partial<Parameters<typeof TimerView>[0]>) {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <TimerView
      sessions={[]}
      selectedScheduleId={selected}
      onSelectSchedule={setSelected}
      onOpenScheduledTurn={() => undefined}
      onCreateSchedule={() => undefined}
      {...props}
    />
  );
}

function renderStatefulTimer(
  harness: ReturnType<typeof createOperationHarness>,
  props: Partial<Parameters<typeof TimerView>[0]> = {},
) {
  return render(
    <LocaleProvider locale="en">
      <StatefulTimerView {...props} />
    </LocaleProvider>,
    { wrapper: harness.wrapper },
  );
}

/** Query-aware viewport mock for the 1100px detail-swap boundary. */
function mockViewport({ narrow = false }: { narrow?: boolean } = {}) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('1100px') && narrow,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/** List + detail + runs routes for a one-schedule world. */
function detailRoutes() {
  return createFetchRouter([
    {
      match: (url, method) => url.startsWith('/api/schedules/sch-1/runs') && method === 'GET',
      respond: () => jsonResponse({ runs: [], next_cursor: null }),
    },
    {
      match: (url, method) => url === '/api/schedules/sch-1' && method === 'GET',
      respond: () => jsonResponse(makeSchedule()),
    },
    {
      match: url => url.startsWith('/api/schedules'),
      respond: () => scheduleListResponse([makeSchedule()]),
    },
  ]);
}

describe('TimerView list', () => {
  beforeEach(() => {
    __resetFeedback();
  });

  afterEach(() => {
    // A narrow-viewport mock must not leak into the next test; components
    // treat a missing matchMedia as "wide".
    delete (window as { matchMedia?: unknown }).matchMedia;
  });

  it('renders the five semantic columns with row content', async () => {
    const router = createFetchRouter([{
      match: url => url.startsWith('/api/schedules'),
      respond: () => scheduleListResponse([makeSchedule()]),
    }]);
    mockFetch(router.handler);
    renderTimer(createOperationHarness());

    const list = await screen.findByTestId('timer-list');
    expect(list).toBeInTheDocument();
    // Column headers: name/frequency · status · conversation · next run · actions.
    expect(screen.getByText('Name / Frequency')).toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('Conversation')).toBeInTheDocument();
    expect(screen.getByText('Next run')).toBeInTheDocument();

    const row = screen.getByTestId('timer-row-sch-1');
    expect(row).toHaveTextContent('Nightly digest');
    expect(row).toHaveTextContent('Cron · 0 9 * * *');
    expect(row).toHaveTextContent('Active');
    expect(row).toHaveTextContent('Release watch');
    expect(row).toHaveTextContent('Claude · Gian');
    // Row actions exist with tooltips.
    expect(screen.getByTestId('timer-action-pause-sch-1')).toHaveAttribute('title', 'Pause');
    expect(screen.getByTestId('timer-action-run-sch-1')).toHaveAttribute('aria-label', 'Run now');
    expect(screen.getByTestId('timer-action-archive-sch-1')).toHaveAttribute('title', 'Archive');
  });

  it('filters statuses by default (archived excluded) and refetches on toggle', async () => {
    const router = createFetchRouter([{
      match: url => url.startsWith('/api/schedules'),
      respond: () => scheduleListResponse([]),
    }]);
    mockFetch(router.handler);
    renderTimer(createOperationHarness());

    await screen.findByTestId('timer-empty');
    expect(router.calls[0]!.url).toContain('status=active%2Cpaused%2Ccompleted');

    await userEvent.click(screen.getByTestId('timer-filter-archived'));
    await waitFor(() => {
      expect(router.calls.some(call => call.url.includes('archived'))).toBe(true);
    });
  });

  it('paginates with the cursor and appends rows', async () => {
    const router = createFetchRouter([{
      match: url => url.startsWith('/api/schedules'),
      respond: call => call.url.includes('cursor=c-2')
        ? scheduleListResponse([makeSchedule({ id: 'sch-2', name: 'Second' })])
        : scheduleListResponse([makeSchedule()], 'c-2'),
    }]);
    mockFetch(router.handler);
    renderTimer(createOperationHarness());

    await screen.findByTestId('timer-row-sch-1');
    await userEvent.click(screen.getByTestId('timer-load-more'));
    await screen.findByTestId('timer-row-sch-2');
    expect(screen.getByTestId('timer-row-sch-1')).toBeInTheDocument();
    expect(router.calls.filter(call => call.url.includes('cursor=c-2'))).toHaveLength(1);
  });

  it('shows loading, empty, and error-with-retry states', async () => {
    let respond: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { respond = resolve; });
    const router = createFetchRouter([{
      match: url => url.startsWith('/api/schedules'),
      respond: async () => { await gate; return scheduleListResponse([]); },
    }]);
    mockFetch(router.handler);
    renderTimer(createOperationHarness());
    expect(screen.getByTestId('timer-loading')).toBeInTheDocument();
    act(() => respond());
    await screen.findByTestId('timer-empty');

    // Error state with a retry that re-fetches.
    let fail = true;
    const router2 = createFetchRouter([{
      match: url => url.startsWith('/api/schedules'),
      respond: () => fail
        ? scheduleErrorResponse('INTERNAL_ERROR', 500, 'boom')
        : scheduleListResponse([makeSchedule()]),
    }]);
    mockFetch(router2.handler);
    renderTimer(createOperationHarness());
    await screen.findByTestId('timer-error');
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByTestId('timer-list');
  });

  it('shows the offline note without dropping loaded rows', async () => {
    const router = createFetchRouter([{
      match: url => url.startsWith('/api/schedules'),
      respond: () => scheduleListResponse([makeSchedule()]),
    }]);
    mockFetch(router.handler);
    renderTimer(createOperationHarness(), { offline: true });
    await screen.findByTestId('timer-row-sch-1');
    expect(screen.getByTestId('timer-offline')).toBeInTheDocument();
  });

  it('opens the detail on row click and keyboard activation', async () => {
    const router = createFetchRouter([{
      match: url => url.startsWith('/api/schedules'),
      respond: () => scheduleListResponse([makeSchedule()]),
    }]);
    mockFetch(router.handler);
    const onSelectSchedule = vi.fn();
    renderTimer(createOperationHarness(), { onSelectSchedule });

    await userEvent.click(await screen.findByTestId('timer-row-sch-1'));
    expect(onSelectSchedule).toHaveBeenCalledWith('sch-1');

    onSelectSchedule.mockClear();
    const row = screen.getByTestId('timer-row-sch-1');
    row.focus();
    await userEvent.keyboard('{Enter}');
    expect(onSelectSchedule).toHaveBeenCalledWith('sch-1');
  });

  it('a row click opens the detail in panel 2 beside the list; Close deselects', async () => {
    const router = detailRoutes();
    mockFetch(router.handler);
    renderStatefulTimer(createOperationHarness());

    await userEvent.click(await screen.findByTestId('timer-row-sch-1'));
    const panel = await screen.findByTestId('schedule-detail-panel');
    // Master/detail: the list stays mounted beside the shared `.p2` shell.
    expect(screen.getByTestId('timer-list')).toBeInTheDocument();
    expect(panel.className).toContain('p2');
    expect(panel.className).not.toContain('replacing');
    await screen.findByTestId('schedule-field-name');
    // Wide layout: no Back button; the Close (X) deselects.
    expect(screen.queryByTestId('schedule-back')).toBeNull();
    await userEvent.click(screen.getByTestId('schedule-close'));
    await waitFor(() => expect(screen.queryByTestId('schedule-detail-panel')).toBeNull());
    expect(screen.getByTestId('timer-list')).toBeInTheDocument();
  });

  it('narrow windows swap the list for the detail panel and Back returns', async () => {
    mockViewport({ narrow: true });
    const router = detailRoutes();
    mockFetch(router.handler);
    const { container } = renderStatefulTimer(createOperationHarness());

    await screen.findByTestId('timer-row-sch-1');
    await userEvent.click(screen.getByTestId('timer-row-sch-1'));
    const panel = await screen.findByTestId('schedule-detail-panel');
    // The list column is replaced, not squeezed.
    expect(panel.className).toContain('replacing');
    expect(container.querySelector('main.timer-main')).toBeNull();
    await screen.findByTestId('schedule-field-name');

    await userEvent.click(screen.getByTestId('schedule-back'));
    await waitFor(() => expect(screen.queryByTestId('schedule-detail-panel')).toBeNull());
    expect(container.querySelector('main.timer-main')).not.toBeNull();
    expect(screen.getByTestId('timer-list')).toBeInTheDocument();
  });

  it('pauses with a stable Idempotency-Key and dedupes rapid re-clicks', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const router = createFetchRouter([{
      match: (url, method) => (url === '/api/schedules' || url.startsWith('/api/schedules?')) && method === 'GET',
      respond: () => scheduleListResponse([makeSchedule()]),
    }, {
      match: (url, method) => url === '/api/schedules/sch-1/pause' && method === 'POST',
      respond: async () => {
        // Gate the response so the first click's run is still in flight when
        // the second click lands.
        await gate;
        return jsonResponse(makeSchedule({ status: 'paused', revision: 4 }));
      },
    }]);
    mockFetch(router.handler);
    renderTimer(createOperationHarness());

    const pause = await screen.findByTestId('timer-action-pause-sch-1');
    const initialReads = router.calls.filter(call => call.method === 'GET').length;
    await userEvent.click(pause);
    // The pending run disables the button; the dispatcher's same-entity
    // pending dedupe would also swallow a second dispatch.
    await waitFor(() => expect(pause).toBeDisabled());
    await userEvent.click(pause);
    expect(router.calls.filter(call => call.url.endsWith('/pause'))).toHaveLength(1);
    const call = router.calls.find(entry => entry.url.endsWith('/pause'))!;
    expect(call.headers['idempotency-key']).toBeTruthy();
    expect(call.body).toEqual({ expected_revision: 3 });
    await act(async () => release());
    await waitFor(() => {
      expect(router.calls.filter(entry => entry.method === 'GET').length).toBeGreaterThan(initialReads);
    });
  });

  it('does not open the row when an action is activated from the keyboard', async () => {
    const router = createFetchRouter([{
      match: (url, method) => (url === '/api/schedules' || url.startsWith('/api/schedules?')) && method === 'GET',
      respond: () => scheduleListResponse([makeSchedule()]),
    }, {
      match: (url, method) => url === '/api/schedules/sch-1/pause' && method === 'POST',
      respond: () => jsonResponse(makeSchedule({ status: 'paused', revision: 4 })),
    }]);
    mockFetch(router.handler);
    const onSelectSchedule = vi.fn();
    renderTimer(createOperationHarness(), { onSelectSchedule });

    const pause = await screen.findByTestId('timer-action-pause-sch-1');
    pause.focus();
    await userEvent.keyboard('{Enter}');

    await waitFor(() => {
      expect(router.calls.some(call => call.url.endsWith('/pause'))).toBe(true);
    });
    expect(onSelectSchedule).not.toHaveBeenCalled();
  });

  it('archives only after the confirmation dialog resolves', async () => {
    const router = createFetchRouter([{
      match: (url, method) => (url === '/api/schedules' || url.startsWith('/api/schedules?')) && method === 'GET',
      respond: () => scheduleListResponse([makeSchedule()]),
    }, {
      match: (url, method) => url === '/api/schedules/sch-1/archive' && method === 'POST',
      respond: () => jsonResponse(makeSchedule({ status: 'archived' })),
    }]);
    mockFetch(router.handler);
    renderTimer(createOperationHarness());

    await userEvent.click(await screen.findByTestId('timer-action-archive-sch-1'));
    expect(getSnapshot().confirms).toHaveLength(1);
    expect(router.calls.some(call => call.url.endsWith('/archive'))).toBe(false);

    act(() => resolveConfirm(getSnapshot().confirms[0]!.id, true));
    await waitFor(() => {
      expect(router.calls.some(call => call.url.endsWith('/archive'))).toBe(true);
    });
  });

  it('refreshes the list on schedule:changed invalidation', async () => {
    const router = createFetchRouter([{
      match: url => url.startsWith('/api/schedules'),
      respond: () => scheduleListResponse([makeSchedule()]),
    }]);
    mockFetch(router.handler);
    renderTimer(createOperationHarness());
    await screen.findByTestId('timer-row-sch-1');
    const before = router.calls.length;

    act(() => notifyScheduleChanged({
      type: 'schedule:changed',
      reason: 'state_changed',
      schedule_id: 'sch-1',
      revision: 4,
    }));
    await waitFor(() => expect(router.calls.length).toBeGreaterThan(before));
  });

  it('renders zh-CN strings after navigation moved to the shared sidebar', async () => {
    const router = createFetchRouter([{
      match: url => url.startsWith('/api/schedules'),
      respond: () => scheduleListResponse([makeSchedule()]),
    }]);
    mockFetch(router.handler);
    renderTimer(createOperationHarness(), {}, 'zh-CN');

    await screen.findByTestId('timer-row-sch-1');
    expect(screen.getByText('定时任务')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: '状态筛选' })).toBeInTheDocument();
  });

  it('offers the 新建定时任务 CTA in the head, wired to the create handoff', async () => {
    const router = createFetchRouter([{
      match: url => url.startsWith('/api/schedules'),
      respond: () => scheduleListResponse([makeSchedule()]),
    }]);
    mockFetch(router.handler);
    const onCreateSchedule = vi.fn();
    renderTimer(createOperationHarness(), { onCreateSchedule });

    await userEvent.click(await screen.findByTestId('timer-create'));
    expect(onCreateSchedule).toHaveBeenCalledTimes(1);
    // The handoff carries the localized guidance prompt (design 05-B).
    expect(onCreateSchedule.mock.calls[0]![0]).toContain('Gian scheduled task');
  });

  it('renders the rich empty state with a create CTA when no schedules exist', async () => {
    const router = createFetchRouter([{
      match: url => url.startsWith('/api/schedules'),
      respond: () => scheduleListResponse([]),
    }]);
    mockFetch(router.handler);
    const onCreateSchedule = vi.fn();
    renderTimer(createOperationHarness(), { onCreateSchedule });

    const empty = await screen.findByTestId('timer-empty');
    expect(empty).toHaveTextContent('No scheduled tasks yet');
    // The Gian-held semantics paragraph (bound conversation / fork / quit).
    expect(empty).toHaveTextContent('owning conversation');
    await userEvent.click(screen.getByTestId('timer-create-empty'));
    expect(onCreateSchedule).toHaveBeenCalledTimes(1);
  });

  it('keeps the fixed five-column layout inside a horizontal scroll wrapper', async () => {
    const router = createFetchRouter([{
      match: url => url.startsWith('/api/schedules'),
      respond: () => scheduleListResponse([makeSchedule()]),
    }]);
    mockFetch(router.handler);
    renderTimer(createOperationHarness());
    const list = await screen.findByTestId('timer-list');
    // Narrow-window contract: the wrapper scrolls horizontally; the table
    // keeps stable widths via table-layout: fixed + colgroup.
    expect(list.className).toContain('timer-table-wrap');
    expect(list.querySelectorAll('colgroup col')).toHaveLength(5);
    expect(list.querySelector('table')!.className).toContain('timer-table');
  });

  it('resets shared rail-action positioning and restores pointer input', () => {
    const css = readFileSync('src/styles/timer.css', 'utf8');
    const layoutRule = css.match(/\.timer-actions\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(layoutRule).toMatch(/position:\s*static/);
    expect(layoutRule).toMatch(/transform:\s*none/);

    const visibleRule = css.match(
      /\.timer-row:hover \.timer-actions \.ri-act,[\s\S]*?\.timer-actions \.ri-act:disabled\s*\{([^}]*)\}/,
    )?.[1] ?? '';
    expect(visibleRule).toMatch(/pointer-events:\s*auto/);
  });
});
