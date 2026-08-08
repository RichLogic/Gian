import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptMinimap } from '../src/transcript/TranscriptMinimap.js';
import type { MsgItem } from '../src/types.js';

const items: MsgItem[] = [
  { kind: 'user', id: 'u1', text: 'first question', exec: 'codex', ts: 1, turn: 1 },
  { kind: 'user', id: 'u2', text: 'second question', exec: 'codex', ts: 2, turn: 2 },
  { kind: 'user', id: 'u3', text: 'third question', exec: 'codex', ts: 3, turn: 3 },
];

const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');

function Harness({ width = 800, visibleItems = items }: { width?: number; visibleItems?: MsgItem[] }) {
  return (
    <div className="main" data-width={width}>
      <div className="main-scroll">
        <div className="transcript">
          {visibleItems.map((item, index) => (
            <div key={item.id} data-msg-id={item.id} data-offset={100 + index * 300} />
          ))}
        </div>
      </div>
      <TranscriptMinimap items={visibleItems} />
    </div>
  );
}

describe('WEB-NAV-001: transcript message navigation', () => {
  const scrollTo = vi.fn(function scrollTo(this: HTMLElement, options: ScrollToOptions) {
    this.scrollTop = Number(options.top ?? 0);
  });

  beforeEach(() => {
    scrollTo.mockClear();
    localStorage.setItem('gian.transcript.minimap', '1');
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function clientWidth(this: HTMLElement) {
      return this.classList.contains('main') ? Number(this.dataset.width ?? 800) : 800;
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function clientHeight(this: HTMLElement) {
      return this.classList.contains('main-scroll') ? 240 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function scrollHeight(this: HTMLElement) {
      return this.classList.contains('main-scroll') ? 1_000 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function offsetTop(this: HTMLElement) {
      return Number(this.dataset.offset ?? 0);
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function offsetHeight(this: HTMLElement) {
      return this.dataset.msgId ? 80 : 0;
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true, writable: true, value: scrollTo,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalScrollTo) {
      Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo);
    } else {
      delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
    }
    localStorage.clear();
  });

  it('jumps directly to a selected message offset without legacy navigation buttons', async () => {
    render(<Harness />);

    const second = await screen.findByRole('button', {
      name: /Jump to your message 2: second question/i,
    });
    expect(screen.queryByRole('button', { name: 'Previous message' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Next message' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Scroll to bottom' })).toBeNull();

    await userEvent.click(second);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 376, behavior: 'smooth' });
  });

  it('shows the minimap only at the width and message-count thresholds', async () => {
    const narrow = render(<Harness width={639} />);
    await waitFor(() => expect(narrow.container.querySelector('.transcript-minimap')).toHaveAttribute('aria-hidden', 'true'));
    narrow.unmount();

    const roomy = render(<Harness width={640} />);
    await waitFor(() => expect(roomy.container.querySelector('.transcript-minimap')).toHaveAttribute('aria-hidden', 'false'));
    expect(screen.getAllByRole('button', { name: /Jump to your message/ })).toHaveLength(3);
    roomy.unmount();

    const tooShort = render(<Harness width={800} visibleItems={items.slice(0, 2)} />);
    await waitFor(() => expect(tooShort.container.querySelector('.transcript-minimap')).toHaveAttribute('aria-hidden', 'true'));
  });
});
