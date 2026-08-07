import { act, fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Transcript } from '../src/transcript/Transcript.js';
import type { MsgItem } from '../src/types.js';

describe('transcript history pagination', () => {
  it('loads an older turn page when the user scrolls upward to the top', () => {
    const onLoadOlder = vi.fn();
    const item: MsgItem = {
      kind: 'user',
      id: 'message-1',
      text: 'hello',
      exec: 'codex',
      ts: 1,
      turn: 1,
    };
    const { container } = render(
      <div className="main-scroll">
        <Transcript
          items={[item]}
          pending={false}
          onApprove={() => undefined}
          hasOlder
          onLoadOlder={onLoadOlder}
        />
      </div>,
    );
    const scroller = container.querySelector('.main-scroll') as HTMLDivElement;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1_000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 });

    scroller.scrollTop = 500;
    fireEvent.scroll(scroller);
    expect(onLoadOlder).not.toHaveBeenCalled();

    scroller.scrollTop = 20;
    fireEvent.scroll(scroller);
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('preserves the visible scroll anchor after prepending an older page', () => {
    const onLoadOlder = vi.fn();
    const current: MsgItem = {
      kind: 'user', id: 'message-2', text: 'current', exec: 'codex', ts: 2, turn: 2,
    };
    const older: MsgItem = {
      kind: 'user', id: 'message-1', text: 'older', exec: 'codex', ts: 1, turn: 1,
    };
    const { container, rerender } = render(
      <div className="main-scroll">
        <Transcript
          items={[current]}
          pending={false}
          onApprove={() => undefined}
          hasOlder
          onLoadOlder={onLoadOlder}
        />
      </div>,
    );
    const scroller = container.querySelector('.main-scroll') as HTMLDivElement;
    let scrollHeight = 1_000;
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 });
    scroller.scrollTop = 20;

    fireEvent.click(container.querySelector('.transcript-history-load button')!);
    expect(onLoadOlder).toHaveBeenCalledTimes(1);

    scrollHeight = 1_600;
    act(() => {
      rerender(
        <div className="main-scroll">
          <Transcript
            items={[older, current]}
            pending={false}
            onApprove={() => undefined}
            hasOlder={false}
            loadingOlder={false}
            onLoadOlder={onLoadOlder}
          />
        </div>,
      );
    });
    expect(scroller.scrollTop).toBe(620);
  });
});
