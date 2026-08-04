import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { LocaleProvider } from '../src/i18n/index.js';
import { ImageZoomContext, UserMessage } from '../src/transcript/items.js';
import type { MsgItem } from '../src/types.js';

const item: MsgItem = {
  kind: 'user', id: 'm1', text: 'look at this', exec: 'claude', ts: 0, turn: 0,
  attachments: [{ name: 'shot.png', mime: 'image/png', url: '/api/sessions/s1/attachments/shot.png' }],
};

function renderMsg(zoom?: (src: string, alt?: string) => void) {
  return render(
    <LocaleProvider locale="en">
      <ImageZoomContext.Provider value={zoom ?? null}>
        <UserMessage item={item} />
      </ImageZoomContext.Provider>
    </LocaleProvider>,
  );
}

afterEach(() => cleanup());

describe('UserMessage image attachment', () => {
  it('plain left-click opens the in-app lightbox instead of navigating away', () => {
    const zoom = vi.fn();
    const { container } = renderMsg(zoom);
    const link = container.querySelector('a.msg-att') as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.classList.contains('zoomable')).toBe(true);

    // The href is preserved as a fallback (modified-click → new tab), but a
    // plain click must be intercepted (default prevented) and routed to zoom.
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(zoom).toHaveBeenCalledWith('/api/sessions/s1/attachments/shot.png', 'shot.png');
  });

  it('⌘/ctrl-click is left to the browser (new tab) — not intercepted', () => {
    const zoom = vi.fn();
    const { container } = renderMsg(zoom);
    const link = container.querySelector('a.msg-att') as HTMLAnchorElement;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, metaKey: true });
    link.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(zoom).not.toHaveBeenCalled();
  });

  it('without a provider, falls back to a plain new-tab link', () => {
    const { container } = renderMsg(undefined);
    const link = container.querySelector('a.msg-att') as HTMLAnchorElement;
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.classList.contains('zoomable')).toBe(false);
    // No onClick handler → a plain click is not prevented.
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    // jsdom doesn't navigate, but the important bit is we didn't intercept it.
    fireEvent(link, ev);
    expect(ev.defaultPrevented).toBe(false);
  });
});
