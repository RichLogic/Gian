// chat-ui message bubbles: user (text / attachments / context / document /
// echo states) and assistant (markdown, footer, copy, footer actions).

import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AssistantMessage, UserMessage } from '../src/items.js';
import { ImageZoomContext, MessageAttachmentOpenContext } from '../src/contexts.js';
import type { MsgItem } from '../src/types.js';

function userMsg(overrides: Partial<MsgItem> = {}): MsgItem {
  return { kind: 'user', id: 'u-1', text: 'hello there', exec: 'claude', ts: 1_000, turn: 1, ...overrides };
}

function assistantMsg(overrides: Partial<MsgItem> = {}): MsgItem {
  return { kind: 'assistant', id: 'a-1', text: '**done**', exec: 'claude', ts: 1_000, turn: 1, ...overrides };
}

describe('UserMessage', () => {
  it('renders plain text with the selectable data contract', () => {
    const { container } = render(<UserMessage item={userMsg()} />);
    const text = container.querySelector('.msg-text.user-text')!;
    expect(text.textContent).toBe('hello there');
    expect(text.getAttribute('data-transcript-source-kind')).toBe('user');
    expect(text.getAttribute('data-transcript-turn')).toBe('1');
  });

  it('linkifies URLs in user message text (sent messages no longer render links as inert text)', () => {
    const { container } = render(
      <UserMessage item={userMsg({ text: 'check https://example.com/docs please' })} />,
    );
    const text = container.querySelector('.msg-text.user-text')!;
    const link = text.querySelector('a[data-link-kind="web"]')!;
    expect(link.getAttribute('href')).toBe('https://example.com/docs');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(text.textContent).toBe('check https://example.com/docs please');
  });

  it('renders image attachments inline and routes zoom through the callback', () => {
    const zoom = vi.fn();
    const { container } = render(
      <ImageZoomContext.Provider value={zoom}>
        <UserMessage item={userMsg({
          text: '',
          attachments: [{ name: 'shot.png', mime: 'image/png', url: '/api/sessions/s1/attachments/shot.png' }],
        })} />
      </ImageZoomContext.Provider>,
    );
    const link = container.querySelector('a.msg-att.zoomable')!;
    expect(link.querySelector('img')!.getAttribute('src')).toContain('shot.png');
    fireEvent.click(link);
    expect(zoom).toHaveBeenCalledWith('/api/sessions/s1/attachments/shot.png', 'shot.png');
  });

  it('renders non-image attachments as download chips with size', () => {
    const { container } = render(
      <UserMessage item={userMsg({
        attachments: [{ name: 'log.txt', mime: 'text/plain', url: '/api/x/log.txt', size: 2048 }],
      })} />,
    );
    const chip = container.querySelector('a.msg-file-att')!;
    expect(chip.getAttribute('download')).toBe('log.txt');
    expect(chip.textContent).toContain('2.0 KB');
  });

  it('routes attachments through an app-owned secure opener when provided', async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    const attachment = { name: 'screen.png', mime: 'image/png', url: 'opaque-handle', size: 128 };
    render(
      <MessageAttachmentOpenContext.Provider value={open}>
        <UserMessage item={userMsg({ attachments: [attachment] })} />
      </MessageAttachmentOpenContext.Provider>,
    );
    await user.click(screen.getByRole('button', { name: /screen\.png/ }));
    expect(open).toHaveBeenCalledWith(attachment);
    expect(document.querySelector('img[src="opaque-handle"]')).toBeNull();
  });

  it('renders context items as cards above the text', () => {
    const { container } = render(
      <UserMessage item={userMsg({
        contextItems: [{ id: 'c1', type: 'pastedText', text: 'line1\nline2', lineCount: 2, byteSize: 11 }],
      })} />,
    );
    expect(container.querySelector('.message-context-cards .context-card')).not.toBeNull();
    expect(container.querySelector('.context-card-label')!.textContent).toBe('Pasted text');
  });

  it('renders a composer document with inline reference chips', () => {
    const { container } = render(
      <UserMessage item={userMsg({
        text: '',
        composerDocument: {
          version: 1,
          segments: [
            { type: 'text', text: 'see ' },
            { type: 'reference', id: 'r1', referenceType: 'attachment', label: 'spec.pdf' },
          ],
        },
        attachments: [{ name: 'spec.pdf', mime: 'application/pdf', url: '/api/x/spec.pdf' }],
      })} />,
    );
    const chip = container.querySelector('.message-inline-reference[data-reference-type="attachment"]')!;
    expect(chip.textContent).toContain('spec.pdf');
  });

  it('image attachment chip: click zooms straight to the lightbox; hover shows the preview popover (2026-09-10 owner call)', () => {
    vi.useFakeTimers();
    try {
      const zoom = vi.fn();
      render(
        <ImageZoomContext.Provider value={zoom}>
          <UserMessage item={userMsg({
            text: '',
            composerDocument: {
              version: 1,
              segments: [{ type: 'reference', id: 'r1', referenceType: 'attachment', label: 'shot.png' }],
            },
            attachments: [{ name: 'shot.png', mime: 'image/png', url: '/api/x/shot.png', size: 2048 }],
          })} />
        </ImageZoomContext.Provider>,
      );
      const chip = screen.getByText('shot.png');
      // Click: no popover — straight to the lightbox.
      fireEvent.click(chip);
      expect(zoom).toHaveBeenCalledWith('/api/x/shot.png', 'shot.png');
      expect(screen.queryByRole('dialog')).toBeNull();
      // Hover: the preview popover opens after the delay.
      fireEvent.mouseEnter(chip);
      expect(screen.queryByRole('dialog')).toBeNull();
      act(() => { vi.advanceTimersByTime(350); });
      const pop = screen.getByRole('dialog');
      expect(pop.querySelector('.ref-pop-title')!.textContent).toBe('shot.png');
      expect(pop.querySelector('.ref-pop-meta')!.textContent).toBe('2.0 KB');
      expect(pop.querySelector('.ref-pop-thumb')!.getAttribute('src')).toBe('/api/x/shot.png');
      // Sent messages can't be removed — no Remove button, only Close.
      expect(pop.querySelector('.ref-pop-remove')).toBeNull();
      // Leaving the chip closes the hover-opened preview.
      fireEvent.mouseLeave(chip);
      act(() => { vi.advanceTimersByTime(250); });
      expect(screen.queryByRole('dialog')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('non-image attachment chip: hover previews; a plain click does nothing (2026-09-10)', () => {
    vi.useFakeTimers();
    try {
      render(
        <UserMessage item={userMsg({
          text: '',
          composerDocument: {
            version: 1,
            segments: [{ type: 'reference', id: 'r1', referenceType: 'attachment', label: 'spec.pdf' }],
          },
          attachments: [{ name: 'spec.pdf', mime: 'application/pdf', url: '/api/x/spec.pdf', size: 512 }],
        })} />,
      );
      const chip = screen.getByText('spec.pdf');
      // Hover opens after the delay; pointer on the popover keeps it alive.
      fireEvent.mouseEnter(chip);
      expect(screen.queryByRole('dialog')).toBeNull();
      act(() => { vi.advanceTimersByTime(350); });
      const pop = screen.getByRole('dialog');
      expect(pop.querySelector('.ref-pop-title')!.textContent).toBe('spec.pdf');
      fireEvent.mouseLeave(chip);
      fireEvent.mouseEnter(pop);
      act(() => { vi.advanceTimersByTime(250); });
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      // Leaving both closes the hover-opened preview.
      fireEvent.mouseLeave(pop);
      act(() => { vi.advanceTimersByTime(250); });
      expect(screen.queryByRole('dialog')).toBeNull();
      // A plain click performs no action.
      fireEvent.click(chip);
      act(() => { vi.advanceTimersByTime(300); });
      expect(screen.queryByRole('dialog')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('non-image attachment chip popover keeps a download affordance; outside click closes', async () => {
    const user = userEvent.setup();
    render(
      <UserMessage item={userMsg({
        text: '',
        composerDocument: {
          version: 1,
          segments: [{ type: 'reference', id: 'r1', referenceType: 'attachment', label: 'spec.pdf' }],
        },
        attachments: [{ name: 'spec.pdf', mime: 'application/pdf', url: '/api/x/spec.pdf', size: 512 }],
      })} />,
    );
    // The popover is hover-driven (click is a no-op), so hover to open it.
    await user.hover(screen.getByText('spec.pdf'));
    const pop = await screen.findByRole('dialog');
    expect(pop.querySelector('.ref-pop-thumb')).toBeNull();
    const download = pop.querySelector('.ref-pop-download')!;
    expect(download.textContent).toBe('Download');
    expect(download.getAttribute('href')).toBe('/api/x/spec.pdf');
    expect(download.getAttribute('download')).toBe('spec.pdf');
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('an attachment chip without a url stays a plain span (no popover)', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <UserMessage item={userMsg({
        text: '',
        composerDocument: {
          version: 1,
          segments: [{ type: 'reference', id: 'r1', referenceType: 'attachment', label: 'gone.png' }],
        },
        attachments: [{ name: 'gone.png', mime: 'image/png' }],
      })} />,
    );
    const chip = container.querySelector('.message-inline-reference[data-reference-type="attachment"]')!;
    expect(chip.tagName).toBe('SPAN');
    await user.click(chip);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('marks a pending echo and a failed echo distinctly', () => {
    const pending = render(<UserMessage item={userMsg({ pending: true })} />);
    expect(pending.container.querySelector('.msg.user.pending')).not.toBeNull();
    pending.unmount();
    const failed = render(<UserMessage item={userMsg({ failed: true })} />);
    expect(failed.container.querySelector('.msg.user.failed')).not.toBeNull();
    expect(screen.getByText('failed to send')).toBeInTheDocument();
  });

  it('failed echo retry fires the injected callback', async () => {
    const user = userEvent.setup();
    const onRetrySend = vi.fn();
    render(<UserMessage item={userMsg({ failed: true })} onRetrySend={onRetrySend} />);
    await user.click(screen.getByText('Retry'));
    expect(onRetrySend).toHaveBeenCalledTimes(1);
  });

  it('no retry button without a callback; unknown state shows the caveat', () => {
    const { container, rerender } = render(<UserMessage item={userMsg({ failed: true })} />);
    expect(screen.queryByText('Retry')).toBeNull();
    rerender(<UserMessage item={userMsg({ pending: true })} sendUnknown />);
    expect(container.querySelector('.msg-state-unknown')!.textContent).toBe('may not have been sent');
  });
});

describe('AssistantMessage', () => {
  it('renders markdown prose', () => {
    const { container } = render(<AssistantMessage item={assistantMsg()} />);
    expect(container.querySelector('.msg-text.md strong')!.textContent).toBe('done');
  });

  it('hides the footer unless tail/copyable/actions call for it', () => {
    const { container, rerender } = render(<AssistantMessage item={assistantMsg()} />);
    expect(container.querySelector('.msg-foot')).toBeNull();
    rerender(<AssistantMessage item={assistantMsg()} showFooter />);
    expect(container.querySelector('.msg-foot .msg-time')).not.toBeNull();
  });

  it('copyable adds a copy button; footerActions render as given', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { container } = render(
      <AssistantMessage item={assistantMsg()} copyable footerActions={<button type="button" className="fork-turn-btn">F</button>} />,
    );
    expect(container.querySelector('.msg-copy')).not.toBeNull();
    expect(container.querySelector('.fork-turn-btn')).not.toBeNull();
    fireEvent.click(container.querySelector('.msg-copy')!);
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('**done**'));
  });

  it('continuation bubbles suppress the header spacing class', () => {
    const { container } = render(<AssistantMessage item={assistantMsg()} hideAvatar />);
    expect(container.querySelector('.msg.continuation')).not.toBeNull();
  });
});
