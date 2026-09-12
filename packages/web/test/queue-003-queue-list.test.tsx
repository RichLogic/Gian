// Coverage for traceability row (component dimension):
//   QUEUE-003 — Queue UI must show queue contents (text + attachment
//               thumbnails) AND support edit / remove / clear / send-now.
//               Reorder was removed on 2026-08-05 (no move up/down). The
//               underlying QueueManager + WS routing are covered host-side
//               in queue-and-busy.test.ts.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { QueueEntry } from '../src/types.js';
import { QueueList } from '../src/components/QueueList.js';
import { ImageZoomContext } from '../src/transcript/items.js';

function entry(id: string, text: string, extra?: Partial<QueueEntry>): QueueEntry {
  return { id, text, ...extra };
}

function renderQueue(opts: {
  queue?: QueueEntry[];
  withSendNow?: boolean;
} = {}) {
  const onRemove = vi.fn();
  const onUpdate = vi.fn();
  const onClear = vi.fn();
  const onSendNow = opts.withSendNow ? vi.fn() : undefined;
  render(
    <QueueList
      sessionId="sess-1"
      queue={opts.queue ?? []}
      onRemove={onRemove}
      onUpdate={onUpdate}
      onClear={onClear}
      onSendNow={onSendNow}
    />,
  );
  return { onRemove, onUpdate, onClear, onSendNow };
}

describe('QUEUE-003: QueueList rendering', () => {
  it('renders nothing when the queue is empty', () => {
    const { container } = render(
      <QueueList sessionId="sess-1" queue={[]} onRemove={vi.fn()} onUpdate={vi.fn()} onClear={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('QUEUE-003: shows each entry text in order', () => {
    renderQueue({ queue: [entry('a', 'first'), entry('b', 'second'), entry('c', 'third')] });
    expect(screen.getByText('first')).toBeInTheDocument();
    expect(screen.getByText('second')).toBeInTheDocument();
    expect(screen.getByText('third')).toBeInTheDocument();
  });

  it('QUEUE-003: shows ordinal indices 1, 2, 3… for each entry', () => {
    renderQueue({ queue: [entry('a', 'first'), entry('b', 'second')] });
    const indices = Array.from(document.querySelectorAll('.qd-idx'), (el) => el.textContent);
    expect(indices).toEqual(['1', '2']);
  });

  it('QUEUE-003: renders image attachments as thumbnails served by the host', () => {
    renderQueue({
      queue: [entry('a', 'with image', {
        items: [{ type: 'localImage', path: '/data/attachments/sess-1/paste-1.png', name: 'paste-1.png', mime: 'image/png' }],
      })],
    });
    const img = document.querySelector('.qd-att-thumb img');
    expect(img?.getAttribute('src')).toBe('/api/sessions/sess-1/attachments/paste-1.png');
  });

  it('QUEUE-003: renders non-image attachments as file chips', () => {
    renderQueue({
      queue: [entry('a', 'with file', {
        items: [{ type: 'localFile', path: '/data/attachments/sess-1/notes.txt', name: 'notes.txt', mime: 'text/plain' }],
      })],
    });
    expect(document.querySelector('.qd-att-file')?.textContent).toContain('notes.txt');
  });

  it('QUEUE-003: thumbnails fit inside the box with the image aspect ratio preserved (no square crop)', () => {
    // Regression (2026-09-07): thumbs were 32x32 with object-fit: cover, hard
    // cropping wide screenshots into squares.
    const css = readFileSync('src/styles/coding.css', 'utf8');
    const thumb = css.match(/\.qd-att-thumb img\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(thumb).toMatch(/max-width:\s*64px/);
    expect(thumb).toMatch(/max-height:\s*32px/);
    expect(thumb).not.toMatch(/object-fit:\s*cover/);
    expect(thumb).not.toMatch(/(^|;)\s*width:\s*32px/);
  });

  it('renders queued references inline and keeps the structured row atomic', () => {
    renderQueue({
      queue: [entry('a', 'Before  after', {
        composer_document: {
          version: 1,
          segments: [
            { type: 'text', text: 'Before ' },
            { type: 'reference', id: 'file-1', referenceType: 'attachment', label: 'notes.txt' },
            { type: 'text', text: ' after' },
          ],
        },
        items: [{ type: 'localFile', path: '/data/attachments/sess-1/notes.txt', name: 'notes.txt', mime: 'text/plain' }],
      })],
    });
    expect(document.querySelector('.inline-reference-document')).toHaveTextContent('Before notes.txt after');
    expect(document.querySelector('[data-reference-id="file-1"]')).toBeInTheDocument();
    expect(screen.queryByLabelText('Edit')).toBeNull();
    expect(document.querySelector('.qd-att-file')).toBeNull();
  });

  it('queued image chip click opens the lightbox directly (2026-09-10 owner call)', async () => {
    const user = userEvent.setup();
    const zoom = vi.fn();
    render(
      <ImageZoomContext.Provider value={zoom}>
        <QueueList
          sessionId="sess-1"
          queue={[entry('a', '', {
            composer_document: {
              version: 1,
              segments: [{ type: 'reference', id: 'img-1', referenceType: 'attachment', label: 'shot.png' }],
            },
            items: [{ type: 'localImage', path: '/data/attachments/sess-1/shot.png', name: 'shot.png', mime: 'image/png', size: 2048 }],
          })]}
          onRemove={vi.fn()}
          onUpdate={vi.fn()}
          onClear={vi.fn()}
        />
      </ImageZoomContext.Provider>,
    );
    // Image chips: click → lightbox, no popover detour.
    await user.click(screen.getByText('shot.png'));
    expect(zoom).toHaveBeenCalledWith('/api/sessions/sess-1/attachments/shot.png', 'shot.png');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('QUEUE-003: edit', () => {
  it('Edit swaps the row to a textarea; Enter saves via onUpdate(id, text)', async () => {
    const user = userEvent.setup();
    const { onUpdate } = renderQueue({ queue: [entry('a', 'first'), entry('b', 'second')] });
    await user.click(screen.getAllByLabelText('Edit')[0]!);
    const box = screen.getByDisplayValue('first');
    await user.clear(box);
    await user.type(box, 'first edited{Enter}');
    expect(onUpdate).toHaveBeenCalledWith('a', 'first edited');
  });

  it('QUEUE-003: Escape cancels the edit without calling onUpdate', async () => {
    const user = userEvent.setup();
    const { onUpdate } = renderQueue({ queue: [entry('a', 'first')] });
    await user.click(screen.getByLabelText('Edit'));
    const box = screen.getByDisplayValue('first');
    await user.type(box, ' changed{Escape}');
    expect(onUpdate).not.toHaveBeenCalled();
    // Back in read mode.
    expect(screen.getByText('first')).toBeInTheDocument();
  });

  it('QUEUE-003: saving an unchanged text is a no-op', async () => {
    const user = userEvent.setup();
    const { onUpdate } = renderQueue({ queue: [entry('a', 'first')] });
    await user.click(screen.getByLabelText('Edit'));
    await user.type(screen.getByDisplayValue('first'), '{Enter}');
    expect(onUpdate).not.toHaveBeenCalled();
    expect(screen.getByText('first')).toBeInTheDocument();
  });

  it('QUEUE-003: saving a blank text is a no-op', async () => {
    const user = userEvent.setup();
    const { onUpdate } = renderQueue({ queue: [entry('a', 'first')] });
    await user.click(screen.getByLabelText('Edit'));
    const box = screen.getByDisplayValue('first');
    await user.clear(box);
    await user.type(box, '{Enter}');
    expect(onUpdate).not.toHaveBeenCalled();
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
