// Coverage for traceability row (component dimension):
//   QUEUE-003 — Queue UI must show queue contents AND support move
//               up / move down / remove / clear / send-now. The
//               underlying QueueManager + WS routing are already
//               covered host-side in queue-and-busy.test.ts.

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { QueueEntry } from '../src/types.js';
import { QueueList } from '../src/components/QueueList.js';

function entry(id: string, text: string): QueueEntry {
  return { id, text, sessionId: 'sess-1', createdAt: Date.now() };
}

function renderQueue(opts: {
  queue?: QueueEntry[];
  withSendNow?: boolean;
} = {}) {
  const onRemove = vi.fn();
  const onReorder = vi.fn();
  const onClear = vi.fn();
  const onSendNow = opts.withSendNow ? vi.fn() : undefined;
  render(
    <QueueList
      queue={opts.queue ?? []}
      onRemove={onRemove}
      onReorder={onReorder}
      onClear={onClear}
      onSendNow={onSendNow}
    />,
  );
  return { onRemove, onReorder, onClear, onSendNow };
}

describe('QUEUE-003: QueueList rendering', () => {
  it('renders nothing when the queue is empty', () => {
    const { container } = render(
      <QueueList queue={[]} onRemove={vi.fn()} onReorder={vi.fn()} onClear={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('QUEUE-003: shows the entry count and each entry text in order', () => {
    renderQueue({ queue: [entry('a', 'first'), entry('b', 'second'), entry('c', 'third')] });
    // Count badge has class .qd-count
    expect(document.querySelector('.qd-count')?.textContent).toBe('3');
    expect(screen.getByText('first')).toBeInTheDocument();
    expect(screen.getByText('second')).toBeInTheDocument();
    expect(screen.getByText('third')).toBeInTheDocument();
  });

  it('QUEUE-003: shows ordinal indices 1, 2, 3… for each entry', () => {
    renderQueue({ queue: [entry('a', 'first'), entry('b', 'second')] });
    const indices = Array.from(document.querySelectorAll('.qd-idx'), (el) => el.textContent);
    expect(indices).toEqual(['1', '2']);
  });
});

describe('QUEUE-003: reorder operations', () => {
  it('Move up sends the swapped id order to onReorder', async () => {
    const user = userEvent.setup();
    const { onReorder } = renderQueue({
      queue: [entry('a', 'first'), entry('b', 'second'), entry('c', 'third')],
    });
    // Move-up button for the second entry.
    const upButtons = screen.getAllByLabelText('Move up');
    await user.click(upButtons[1]!);
    expect(onReorder).toHaveBeenCalledWith(['b', 'a', 'c']);
  });

  it('QUEUE-003: Move down sends the swapped id order to onReorder', async () => {
    const user = userEvent.setup();
    const { onReorder } = renderQueue({
      queue: [entry('a', 'first'), entry('b', 'second'), entry('c', 'third')],
    });
    const downButtons = screen.getAllByLabelText('Move down');
    await user.click(downButtons[0]!);
    expect(onReorder).toHaveBeenCalledWith(['b', 'a', 'c']);
  });

  it('QUEUE-003: Move up on the FIRST entry is disabled (no-op)', () => {
    renderQueue({ queue: [entry('a', 'first'), entry('b', 'second')] });
    const upButtons = screen.getAllByLabelText('Move up');
    expect(upButtons[0]).toBeDisabled();
  });

  it('QUEUE-003: Move down on the LAST entry is disabled', () => {
    renderQueue({ queue: [entry('a', 'first'), entry('b', 'second')] });
    const downButtons = screen.getAllByLabelText('Move down');
    expect(downButtons[downButtons.length - 1]).toBeDisabled();
  });
});

describe('QUEUE-003: remove / clear', () => {
  it('Remove button fires onRemove(queueId)', async () => {
    const user = userEvent.setup();
    const { onRemove } = renderQueue({
      queue: [entry('a', 'first'), entry('b', 'second')],
    });
    const removeButtons = screen.getAllByLabelText('Remove');
    await user.click(removeButtons[1]!);
    expect(onRemove).toHaveBeenCalledWith('b');
  });

  it('QUEUE-003: Clear button fires onClear()', async () => {
    const user = userEvent.setup();
    const { onClear } = renderQueue({ queue: [entry('a', 'first')] });
    await user.click(screen.getByRole('button', { name: /Clear/i }));
    expect(onClear).toHaveBeenCalled();
  });
});

describe('QUEUE-003: send-now', () => {
  it('Send now button appears when onSendNow is supplied AND fires the callback', async () => {
    const user = userEvent.setup();
    const { onSendNow } = renderQueue({
      queue: [entry('a', 'first')],
      withSendNow: true,
    });
    const btn = screen.getByRole('button', { name: /Send now/i });
    await user.click(btn);
    expect(onSendNow).toHaveBeenCalled();
  });

  it('QUEUE-003: Send now button is hidden when onSendNow is omitted', () => {
    renderQueue({ queue: [entry('a', 'first')], withSendNow: false });
    expect(screen.queryByRole('button', { name: /Send now/i })).toBeNull();
  });
});
