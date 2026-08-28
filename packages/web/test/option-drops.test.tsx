import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { useUpDrop } from '../src/components/composer/option-drops.js';

function Drop({ align }: { align?: 'left' | 'right' }) {
  const drop = useUpDrop(260, { align });
  return (
    <>
      <button ref={drop.btnRef} type="button" onClick={() => drop.setOpen(o => !o)}>open</button>
      {drop.open && drop.pos && (
        <div ref={drop.popRef} data-testid="pop" style={{ left: drop.pos.left, bottom: drop.pos.bottom }} />
      )}
    </>
  );
}

function mockButtonRect() {
  const button = screen.getByRole('button', { name: 'open' });
  button.getBoundingClientRect = () => ({
    left: 700, right: 740, top: 500, bottom: 520, width: 40, height: 20, x: 700, y: 500,
    toJSON: () => ({}),
  }) as DOMRect;
}

describe('useUpDrop', () => {
  it('anchors the left edge to the button by default', async () => {
    const user = userEvent.setup();
    render(<Drop />);
    mockButtonRect();
    await user.click(screen.getByRole('button', { name: 'open' }));
    expect(screen.getByTestId('pop').style.left).toBe('700px');
  });

  it('anchors the right edge to the button when align=right', async () => {
    const user = userEvent.setup();
    render(<Drop align="right" />);
    mockButtonRect();
    await user.click(screen.getByRole('button', { name: 'open' }));
    // 740 (button right) − 260 (popover width)
    expect(screen.getByTestId('pop').style.left).toBe('480px');
  });

  it('clamps a right-aligned popover to the window edge', async () => {
    const user = userEvent.setup();
    render(<Drop align="right" />);
    const button = screen.getByRole('button', { name: 'open' });
    button.getBoundingClientRect = () => ({
      left: 2, right: 30, top: 500, bottom: 520, width: 28, height: 20, x: 2, y: 500,
      toJSON: () => ({}),
    }) as DOMRect;
    await user.click(button);
    // 30 − 260 would be negative; clamped to 8.
    expect(screen.getByTestId('pop').style.left).toBe('8px');
  });
});
