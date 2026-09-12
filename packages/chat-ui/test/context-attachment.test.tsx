// chat-ui context/attachment/document presentation: ContextCards,
// InlineReferenceDocument, and the reference popover.

import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContextCards } from '../src/context-cards.js';
import { InlineReferenceDocument } from '../src/inline-reference-document.js';
import type { MessageContextItem } from '@gian/shared';

const pasted: MessageContextItem = {
  id: 'c1', type: 'pastedText', text: 'alpha\nbeta\ngamma', lineCount: 3, byteSize: 15,
};
const folder: MessageContextItem = { id: 'c2', type: 'folder', path: '/repo/src', name: 'src' };

describe('ContextCards', () => {
  it('renders nothing for an empty list', () => {
    const { container } = render(<ContextCards items={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('pasted text expands to a capped preview; folder cards are inert', async () => {
    const user = userEvent.setup();
    const { container } = render(<ContextCards items={[pasted, folder]} />);
    const cards = container.querySelectorAll('.context-card');
    expect(cards).toHaveLength(2);
    const pastedMain = cards[0]!.querySelector('button.context-card-main')!;
    expect(pastedMain.textContent).toContain('3 lines, 15 B');
    await user.click(pastedMain);
    expect(container.querySelector('.context-card-preview')!.textContent).toContain('gamma');
    // Folder cards never expand.
    expect(cards[1]!.querySelector('button')).toBeNull();
    expect(cards[1]!.textContent).toContain('/repo/src');
  });

  it('selection-origin pasted text reads as a quote', () => {
    const { container } = render(<ContextCards items={[{ ...pasted, origin: 'selection' }]} />);
    expect(container.querySelector('.context-card-label')!.textContent).toBe('Quote');
  });

  it('remove button reports the item id', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(<ContextCards items={[pasted]} onRemove={onRemove} />);
    await user.click(screen.getByLabelText('Remove context'));
    expect(onRemove).toHaveBeenCalledWith('c1');
  });
});

describe('InlineReferenceDocument', () => {
  const doc = {
    version: 1 as const,
    segments: [
      { type: 'text' as const, text: 'check ' },
      { type: 'reference' as const, id: 'c1', referenceType: 'context' as const, label: 'pasted notes' },
      { type: 'text' as const, text: ' and ' },
      { type: 'reference' as const, id: 'a1', referenceType: 'attachment' as const, label: 'spec.pdf' },
    ],
  };

  it('renders text and both chip kinds in order', () => {
    const { container } = render(
      <InlineReferenceDocument
        document={doc}
        contextItems={[pasted]}
        attachments={[{ name: 'spec.pdf', mime: 'application/pdf', url: '/api/x/spec.pdf' }]}
      />,
    );
    const root = container.querySelector('.inline-reference-document')!;
    expect(root.textContent).toContain('check');
    const chips = container.querySelectorAll('.message-inline-reference');
    expect(chips).toHaveLength(2);
    expect(chips[0]!.getAttribute('data-reference-type')).toBe('context');
    expect(chips[1]!.getAttribute('data-reference-type')).toBe('attachment');
    // Chips with a URL are buttons that open the attachment popover (the
    // download href moved inside the popover body).
    expect(chips[1]!.tagName).toBe('BUTTON');
  });

  it('context chips preview on hover (click is a no-op) and close on Escape', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <InlineReferenceDocument document={doc} contextItems={[pasted]} />,
    );
    const chip = container.querySelector('button.message-inline-reference')!;
    // 2026-09-10 owner call: a plain chip click does nothing.
    await user.click(chip);
    expect(document.body.querySelector('.ref-pop')).toBeNull();
    await user.hover(chip);
    await vi.waitFor(() => expect(document.body.querySelector('.ref-pop')).not.toBeNull());
    expect(document.body.querySelector('.ref-pop')!.textContent).toContain('alpha');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.body.querySelector('.ref-pop')).toBeNull();
  });

  it('attachment chips without a URL render inert (no href)', () => {
    const { container } = render(
      <InlineReferenceDocument document={doc} attachments={[{ name: 'spec.pdf' }]} />,
    );
    const chip = container.querySelector('[data-reference-type="attachment"]')!;
    expect(chip.tagName).toBe('SPAN');
    expect(chip.getAttribute('href')).toBeNull();
  });

  it('image attachment chip: click routes activation (zoom) directly; hover opens the popover (2026-09-10 owner call)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onAttachmentActivate = vi.fn().mockReturnValue(true);
    try {
      const { container } = render(
        <InlineReferenceDocument
          document={doc}
          attachments={[{ name: 'spec.png', mime: 'image/png', url: '/api/x/spec.png', size: 64 }]}
          onAttachmentActivate={onAttachmentActivate}
        />,
      );
      const chip = container.querySelector('[data-reference-type="attachment"]')!;
      // Click: straight to activation (zoom) — no popover.
      fireEvent.click(chip);
      expect(onAttachmentActivate).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'spec.png', url: '/api/x/spec.png' }),
      );
      expect(document.body.querySelector('.ref-pop')).toBeNull();
      // Hover: the preview popover still opens after the delay.
      fireEvent.mouseEnter(chip);
      act(() => { vi.advanceTimersByTime(350); });
      const pop = document.body.querySelector('.ref-pop')!;
      expect(pop).not.toBeNull();
      expect(pop.querySelector('.ref-pop-title')!.textContent).toBe('spec.png');
      expect(pop.querySelector('.ref-pop-meta')!.textContent).toBe('64 B');
    } finally {
      vi.useRealTimers();
    }
  });
});
