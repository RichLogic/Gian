import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  projectMinimapMarkers,
  TranscriptMinimap,
} from '../src/transcript/TranscriptMinimap.js';
import type { TranscriptItem } from '../src/types.js';

function user(id: string, text: string, turn: number): TranscriptItem {
  return { kind: 'user', id, text, turn, ts: turn * 1_000, exec: 'codex' };
}

function assistant(id: string, text: string, turn: number): TranscriptItem {
  return { kind: 'assistant', id, text, turn, ts: turn * 1_000 + 1, exec: 'codex' };
}

const items: TranscriptItem[] = [
  user('u1', 'Summarize the project modules', 1),
  assistant('a1', 'The desktop app owns the Host and Web lifecycle.', 1),
  user('u2', 'Check the browser security boundary', 2),
  assistant('a2', 'The Browser runs without Node integration.', 2),
  user('u3', 'Run the final smoke test', 3),
];

describe('projectMinimapMarkers', () => {
  it('pairs each user turn with its first assistant response', () => {
    expect(projectMinimapMarkers(items)).toMatchObject([
      {
        id: '1:user:u1',
        prompt: 'Summarize the project modules',
        response: 'The desktop app owns the Host and Web lifecycle.',
      },
      {
        id: '2:user:u2',
        response: 'The Browser runs without Node integration.',
      },
      { id: '3:user:u3', response: '' },
    ]);
  });
});

describe('TranscriptMinimap', () => {
  it('renders a compact Codex-style rail and jumps to the selected turn', async () => {
    localStorage.setItem('gian.transcript.minimap', '1');
    const scrollTo = vi.fn();
    const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
    const originalOffsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop');
    Object.defineProperties(HTMLElement.prototype, {
      clientWidth: { configurable: true, get: () => 1_000 },
      clientHeight: { configurable: true, get: () => 600 },
      offsetTop: {
        configurable: true,
        get() {
          const id = this.getAttribute?.('data-msg-id');
          return id === '1:user:u1' ? 40
            : id === '2:user:u2' ? 240
              : id === '3:user:u3' ? 440 : 0;
        },
      },
    });

    try {
      render(
        <div className="main">
          <div
            className="main-scroll"
            ref={node => { if (node) node.scrollTo = scrollTo; }}
          >
            <div className="transcript">
              <div data-msg-id="1:user:u1" />
              <div data-msg-id="2:user:u2" />
              <div data-msg-id="3:user:u3" />
            </div>
          </div>
          <TranscriptMinimap items={items} />
        </div>,
      );

      const second = await screen.findByRole('button', {
        name: /Jump to your message 2: Check the browser security boundary/i,
      });
      expect(document.querySelectorAll('.tm-item')).toHaveLength(3);
      expect(document.querySelector('.tm-stack')).toHaveStyle({ height: '42px' });
      expect(screen.getByText('The Browser runs without Node integration.')).toBeInTheDocument();

      await userEvent.click(second);
      expect(scrollTo).toHaveBeenCalledWith({ top: 216, behavior: 'smooth' });
    } finally {
      restorePrototypeProperty('clientWidth', originalClientWidth);
      restorePrototypeProperty('clientHeight', originalClientHeight);
      restorePrototypeProperty('offsetTop', originalOffsetTop);
      localStorage.removeItem('gian.transcript.minimap');
    }
  });

  it('stays hidden on a narrow chat panel', async () => {
    localStorage.setItem('gian.transcript.minimap', '1');
    const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 500,
    });
    try {
      const { container } = render(
        <div className="main">
          <div className="main-scroll">
            <div className="transcript">
              <div data-msg-id="1:user:u1" />
              <div data-msg-id="2:user:u2" />
              <div data-msg-id="3:user:u3" />
            </div>
          </div>
          <TranscriptMinimap items={items} />
        </div>,
      );
      await waitFor(() => expect(container.querySelector('.transcript-minimap')).toHaveClass('is-hidden'));
    } finally {
      restorePrototypeProperty('clientWidth', originalClientWidth);
      localStorage.removeItem('gian.transcript.minimap');
    }
  });
});

function restorePrototypeProperty(
  key: 'clientWidth' | 'clientHeight' | 'offsetTop',
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
}
