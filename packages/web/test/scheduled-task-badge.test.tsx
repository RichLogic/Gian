/**
 * Scheduled-task provenance (Issue #51): a canonical user_message carrying
 * `data.scheduled_task` projects onto the MsgItem and renders a compact
 * "sent by a schedule" tag; clicking it opens the Schedule's Timer detail via
 * the ScheduleOpenContext. Ordinary and echoed messages never get the tag.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { EventEnvelope } from '@gian/shared';
import { applyEnvelope } from '../src/transcript/apply.js';
import { ScheduleOpenContext, UserMessage } from '../src/transcript/items.js';
import type { MsgItem, TranscriptItem } from '../src/types.js';

function userMessageEnvelope(data: Record<string, unknown>): EventEnvelope {
  return {
    session_id: 'session-1',
    turn: 1,
    call_id: 'call-1',
    event: 'user_message',
    ts: 1,
    data,
  };
}

describe('applyEnvelope scheduled_task projection', () => {
  it('carries a well-formed scheduled_task origin onto the user item', () => {
    const items = applyEnvelope([] as TranscriptItem[], userMessageEnvelope({
      text: 'run the digest',
      scheduled_task: { schedule_id: 'sch-1', run_id: 'run-1', schedule_name: 'Nightly digest' },
    }), 'claude');
    const item = items[0] as MsgItem;
    expect(item.kind).toBe('user');
    expect(item.scheduledTask).toEqual({
      schedule_id: 'sch-1',
      run_id: 'run-1',
      schedule_name: 'Nightly digest',
    });
  });

  it('ignores malformed or absent origins', () => {
    const plain = applyEnvelope([], userMessageEnvelope({ text: 'hello' }), 'claude');
    expect((plain[0] as MsgItem).scheduledTask).toBeUndefined();
    const malformed = applyEnvelope([], userMessageEnvelope({
      text: 'hello',
      scheduled_task: { schedule_id: 42 },
    }), 'claude');
    expect((malformed[0] as MsgItem).scheduledTask).toBeUndefined();
  });
});

describe('UserMessage schedule provenance tag', () => {
  const item: MsgItem = {
    kind: 'user',
    id: 'call-1',
    text: 'run the digest',
    exec: 'claude',
    ts: 1,
    turn: 1,
    scheduledTask: { schedule_id: 'sch-1', run_id: 'run-1', schedule_name: 'Nightly digest' },
  };

  it('renders the tag and opens the Schedule detail on click', async () => {
    const openSchedule = vi.fn();
    render(
      <ScheduleOpenContext.Provider value={openSchedule}>
        <UserMessage item={item} />
      </ScheduleOpenContext.Provider>,
    );
    const tag = screen.getByTestId('schedule-tag-run-1');
    expect(tag).toHaveTextContent('Nightly digest');
    await userEvent.click(tag);
    expect(openSchedule).toHaveBeenCalledWith('sch-1');
  });

  it('renders the tag inert without a provider and omits it on plain messages', () => {
    const { rerender } = render(<UserMessage item={item} />);
    // No provider → non-interactive tag (span), still labeled.
    expect(screen.getByText('Nightly digest')).toBeInTheDocument();
    expect(screen.queryByTestId('schedule-tag-run-1')).toBeNull();

    rerender(<UserMessage item={{ ...item, scheduledTask: undefined }} />);
    expect(screen.queryByText('Nightly digest')).toBeNull();
  });
});
