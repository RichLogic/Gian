import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TranscriptMinimap,
  TranscriptNavigation,
} from '../src/transcript/TranscriptMinimap.js';
import { transcriptItemIdentity } from '../src/transcript/identity.js';
import type { MsgItem } from '../src/types.js';

const items: MsgItem[] = [
  { kind: 'user', id: 'u1', text: 'first question', exec: 'codex', ts: 1, turn: 1 },
  { kind: 'user', id: 'u2', text: 'second question', exec: 'codex', ts: 2, turn: 2 },
  { kind: 'user', id: 'u3', text: 'third question', exec: 'codex', ts: 3, turn: 3 },
];

const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');

function Harness({ width = 1_000, visibleItems = items }: { width?: number; visibleItems?: MsgItem[] }) {
  return (
    <div className="main" data-width={width}>
      <div className="main-scroll">
        <div className="transcript">
          {visibleItems.map((item, index) => (
            <div
              key={transcriptItemIdentity(item)}
              data-msg-id={transcriptItemIdentity(item)}
              data-offset={100 + index * 300}
            />
          ))}
        </div>
      </div>
      <TranscriptMinimap items={visibleItems} />
      <div className="main-underbar">
        <TranscriptNavigation items={visibleItems} />
      </div>
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

  it('keeps direct minimap jumps plus previous, next, and scroll-bottom controls', async () => {
    render(<Harness />);

    const second = await screen.findByRole('button', {
      name: /Jump to your message 2: second question/i,
    });
    const previous = await screen.findByRole('button', { name: 'Previous message' });
    const next = screen.getByRole('button', { name: 'Next message' });
    const bottom = screen.getByRole('button', { name: 'Scroll to bottom' });
    expect(previous).toBeDisabled();
    expect(next).toBeEnabled();

    await userEvent.click(second);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 376, behavior: 'smooth' });

    const scroller = document.querySelector('.main-scroll') as HTMLElement;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(previous).toBeEnabled());
    await userEvent.click(previous);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 76, behavior: 'smooth' });

    fireEvent.scroll(scroller);
    await waitFor(() => expect(next).toBeEnabled());
    await userEvent.click(next);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 376, behavior: 'smooth' });

    await userEvent.click(bottom);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1_000, behavior: 'smooth' });
  });

  it('keeps minimap anchors distinct when a provider reuses one user id across turns', async () => {
    const reused = items.map(item => ({ ...item, id: 'shared-user-id' }));
    render(<Harness visibleItems={reused} />);

    expect(await screen.findAllByRole('button', { name: /Jump to your message/ })).toHaveLength(3);
    const second = screen.getByRole('button', {
      name: /Jump to your message 2: second question/i,
    });
    await userEvent.click(second);

    expect(scrollTo).toHaveBeenLastCalledWith({ top: 376, behavior: 'smooth' });
    expect(document.querySelectorAll('[data-msg-id="2:user:shared-user-id"]')).toHaveLength(1);
  });

  it('shows the minimap only at the width and message-count thresholds', async () => {
    const narrow = render(<Harness width={959} />);
    await waitFor(() => expect(narrow.container.querySelector('.transcript-minimap')).toHaveAttribute('aria-hidden', 'true'));
    narrow.unmount();

    const roomy = render(<Harness width={960} />);
    await waitFor(() => expect(roomy.container.querySelector('.transcript-minimap')).toHaveAttribute('aria-hidden', 'false'));
    expect(screen.getAllByRole('button', { name: /Jump to your message/ })).toHaveLength(3);
    roomy.unmount();

    const tooShort = render(<Harness width={1_000} visibleItems={items.slice(0, 2)} />);
    await waitFor(() => expect(tooShort.container.querySelector('.transcript-minimap')).toHaveAttribute('aria-hidden', 'true'));
  });
});
