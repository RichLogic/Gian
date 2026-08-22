// Step/request Trace presentation (gian.proxy/2.0, 2026-08-19).
// Pins: step rows collapse/expand their parentId-linked children and show
// the reported duration; the request card renders the effective request
// identity (model provider + id, reason badge, parameter chips, context
// window) with the system prompt and tools list folded by default; a
// truncated payload surfaces a notice and the artifact stays read-only path
// text; orphan parentIds keep their rows at top level.

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ChatContextPanel } from '../src/components/ChatContextPanel.js';
import { LocaleProvider } from '../src/i18n/index.js';
import { ChatPanelOpenContext, type ChatPanelRequest } from '../src/presentation/chat-panel.js';
import {
  traceFixtureMultiStep,
  traceFixtureOrphanParent,
  traceFixtureStepRequest,
  traceFixtureTruncatedRequest,
} from '../src/trace/fixtures.js';
import { TraceView } from '../src/trace/TraceView.js';
import type { TraceItem, TraceSnapshot } from '../src/trace/types.js';

function renderTrace(snapshot: TraceSnapshot, open?: (request: ChatPanelRequest) => void) {
  return render(
    <LocaleProvider locale="en">
      <ChatPanelOpenContext.Provider value={open ?? null}>
        <TraceView snapshot={snapshot} />
      </ChatPanelOpenContext.Provider>
    </LocaleProvider>,
  );
}

function renderRequestPanel(item: TraceItem) {
  render(
    <LocaleProvider locale="en">
      <ChatContextPanel
        target={{ kind: 'trace-item', item, sessionId: 'session-1' }}
        items={[]}
        onClose={() => {}}
      />
    </LocaleProvider>,
  );
  return screen.getByTestId('trace-request-card');
}

describe('step groups in the Trace list', () => {
  it('folds step children behind the step row until it is expanded', async () => {
    renderTrace(traceFixtureStepRequest);
    expect(screen.queryByTestId('trace-row-request-1')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('trace-row-step:turn-1:native-turn-1:0'));
    expect(screen.getByTestId('trace-row-request-1')).toBeInTheDocument();
    expect(
      screen.getByTestId('trace-step-children-step:turn-1:native-turn-1:0'),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('trace-row-step:turn-1:native-turn-1:0'));
    expect(screen.queryByTestId('trace-row-request-1')).not.toBeInTheDocument();
  });

  it('shows the reported step duration on the step row, never a fabricated one', () => {
    renderTrace(traceFixtureStepRequest);
    const row = screen.getByTestId('trace-row-step:turn-1:native-turn-1:0');
    expect(within(row).getByTestId('trace-step-dur-step:turn-1:native-turn-1:0'))
      .toHaveTextContent('49s');
    expect(within(row).getByTestId('trace-status-succeeded')).toBeInTheDocument();
  });

  it('renders a multi-step turn as two independent collapsible groups', async () => {
    renderTrace(traceFixtureMultiStep);
    await userEvent.click(screen.getByTestId('trace-row-step:turn-1:native-turn-1:0'));
    expect(screen.getByTestId('trace-row-ms-request-1')).toBeInTheDocument();
    // The second step stays folded until its own header is clicked.
    expect(screen.queryByTestId('trace-row-ms-request-2')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('trace-row-step:turn-1:native-turn-1:1'));
    expect(screen.getByTestId('trace-row-ms-request-2')).toBeInTheDocument();
    expect(screen.getByTestId('trace-row-ms-assistant-2')).toBeInTheDocument();
  });

  it('keeps rows with an orphan parentId at top level', () => {
    renderTrace(traceFixtureOrphanParent);
    // The orphan renders without expanding anything, outside the step group.
    expect(screen.getByTestId('trace-row-orphan-row')).toBeInTheDocument();
    expect(screen.queryByTestId('trace-row-orphan-child')).not.toBeInTheDocument();
  });
});

describe('request card', () => {
  it('renders the effective request identity with a folded prompt and tools', async () => {
    const open = vi.fn();
    renderTrace(traceFixtureStepRequest, open);
    await userEvent.click(screen.getByTestId('trace-row-step:turn-1:native-turn-1:0'));
    await userEvent.click(screen.getByTestId('trace-row-request-1'));

    const request = open.mock.calls.at(-1)?.[0] as ChatPanelRequest;
    expect(request.kind).toBe('trace-item');
    const card = renderRequestPanel((request as { item: TraceItem }).item);

    // Model identity: display name, provider, and the raw model id.
    expect(within(card).getByText('DeepSeek Chat')).toBeInTheDocument();
    expect(within(card).getByText('deepseek')).toBeInTheDocument();
    expect(within(card).getByText('deepseek-chat')).toBeInTheDocument();
    // Reason badge carries the protocol reason.
    expect(within(card).getByTestId('trace-request-reason'))
      .toHaveAttribute('data-reason', 'initial');
    // Parameter chips display opaque scalars verbatim.
    const chips = within(card).getByTestId('trace-request-parameters');
    expect(chips).toHaveTextContent('effort: high');
    expect(chips).toHaveTextContent('temperature: 0.2');
    // Context window shows when present.
    expect(card).toHaveTextContent('128000');
    // No truncation marker on a complete payload.
    expect(screen.queryByTestId('trace-request-truncated')).not.toBeInTheDocument();

    // System prompt and tools list are folded by default (content present in
    // the DOM, region collapsed).
    const regions = card.querySelectorAll('details');
    expect(regions).toHaveLength(2);
    regions.forEach(region => expect(region).not.toHaveAttribute('open'));
    expect(card).toHaveTextContent('You are a careful coding agent.');
    expect(card).toHaveTextContent('read_file');

    await userEvent.click(within(card).getByText('System prompt'));
    expect(regions[0]).toHaveAttribute('open');
  });

  it('shows a truncated notice and the artifact as plain path text', () => {
    const item = traceFixtureTruncatedRequest.items.find(
      candidate => candidate.id === 'trunc-request-1',
    );
    if (!item) throw new Error('missing truncated request fixture item');
    const card = renderRequestPanel(item);

    expect(within(card).getByTestId('trace-request-truncated')).toBeInTheDocument();
    expect(within(card).getByTestId('trace-request-reason'))
      .toHaveAttribute('data-reason', 'change');
    expect(within(card).getByTestId('trace-request-parameters'))
      .toHaveTextContent('maxTokens: 4096');
    expect(card).toHaveTextContent('64000');
    // Artifact is path text only — no link or button to open/execute it.
    expect(card).toHaveTextContent('/tmp/gian/traces/request-1.json');
    expect(within(card).queryByRole('link')).not.toBeInTheDocument();
    expect(within(card).queryByRole('button')).not.toBeInTheDocument();
    // Tools list folds with name and description.
    expect(card).toHaveTextContent('read_file');
    expect(card).toHaveTextContent('Read one workspace file.');
    expect(card).toHaveTextContent('write_file');
  });
});
