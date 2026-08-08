import { act, fireEvent, render, screen } from '@testing-library/react';
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

  it('keeps transcript content visible and exposes an accessible history retry', () => {
    const onRetryHistory = vi.fn();
    const item: MsgItem = {
      kind: 'user', id: 'message-live', text: 'live content remains', exec: 'codex', ts: 1, turn: 1,
    };
    render(
      <Transcript
        items={[item]}
        pending={false}
        onApprove={() => undefined}
        historyError={{
          kind: 'http', status: 500, operation: 'initial', message: 'server failed',
        }}
        onRetryHistory={onRetryHistory}
      />,
    );

    expect(screen.getByText('live content remains')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load message history.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry history load' }));
    expect(onRetryHistory).toHaveBeenCalledTimes(1);
  });

  it('releases bottom-follow while the user reads older output and re-locks after returning to bottom', () => {
    const user: MsgItem = {
      kind: 'user', id: 'message-user', text: 'run the tests', exec: 'codex', ts: 1, turn: 1,
    };
    const assistant = (text: string): MsgItem => ({
      kind: 'assistant', id: 'message-assistant', text, exec: 'codex', ts: 2, turn: 1,
    });
    const props = (text: string) => (
      <div className="main-scroll">
        <Transcript items={[user, assistant(text)]} pending onApprove={() => undefined} />
      </div>
    );
    const { container, rerender } = render(props('first chunk'));
    const scroller = container.querySelector('.main-scroll') as HTMLDivElement;
    let scrollHeight = 1_000;
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 });

    // Scrolling up releases the transcript's follow lock.
    scroller.scrollTop = 400;
    fireEvent.scroll(scroller);
    scrollHeight = 1_100;
    act(() => rerender(props('first chunk\nstreamed while reading')));
    expect(scroller.scrollTop).toBe(400);

    // Returning to the actual bottom re-engages it for the next delta.
    scroller.scrollTop = 700;
    fireEvent.scroll(scroller);
    scrollHeight = 1_200;
    act(() => rerender(props('first chunk\nstreamed while reading\nlatest chunk')));
    expect(scroller.scrollTop).toBe(1_200);
  });
});
