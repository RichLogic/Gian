import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { Sheet } from '../src/components/Sheet.js';
import type { SheetTab } from '../src/components/Sheet.js';

const fileTab: SheetTab = {
  id: 'f1', pane: 0, name: 'foo.ts', kind: 'file', icoKind: 'ts', ico: 'TS',
  lines: [['1', 'const a = 1']], fullPath: '/tmp/foo.ts', viewMode: 'source',
};
const termTab: SheetTab = {
  id: 'term1', pane: 1, name: 'zsh', kind: 'term', icoKind: 'term', ico: '$',
};

const actions = {
  activateTab: vi.fn(), closeTab: vi.fn(), pinTab: vi.fn(), setTabViewMode: vi.fn(),
};

function renderSheet(props: Partial<React.ComponentProps<typeof Sheet>>) {
  return render(
    <Sheet
      tabs={[fileTab, termTab]}
      active={{ 0: 'f1', 1: 'term1' }}
      actions={actions}
      renderTab={() => <div>term-body</div>}
      {...props}
    />,
  );
}

describe('Sheet pane sizing', () => {
  it('pins the top pane to a fixed split height when the terminal pane is visible', () => {
    const { container } = renderSheet({ hideTerm: false });
    const panes = container.querySelectorAll<HTMLElement>('.sheet-pane');
    expect(panes.length).toBe(2);
    // Top (file) pane is the fixed-height split; terminal pane fills the rest.
    // (jsdom normalizes `flex: none` to its longhand `0 0 auto`.)
    expect(panes[0]!.style.flex).toBe('0 0 auto');
    expect(panes[0]!.style.height).toBe('var(--sheet-top-h, 320px)');
    expect(panes[1]!.style.display).not.toBe('none');
  });

  it('lets the top pane fill when the terminal pane is hidden via the dock toggle', () => {
    const { container } = renderSheet({ hideTerm: true });
    const panes = container.querySelectorAll<HTMLElement>('.sheet-pane');
    expect(panes.length).toBe(2);
    // The hidden terminal pane keeps xterm mounted (display:none, not removed)…
    expect(panes[1]!.style.display).toBe('none');
    // …but the top pane must drop its fixed height so it fills the sheet,
    // matching the all-tabs-closed path (regression: it used to stay 320px).
    expect(panes[0]!.style.flex).toBe('');
    expect(panes[0]!.style.height).toBe('');
  });

  it('lets the lone file pane fill when the terminal is closed entirely (×)', () => {
    const { container } = renderSheet({ tabs: [fileTab], active: { 0: 'f1', 1: null } });
    const panes = container.querySelectorAll<HTMLElement>('.sheet-pane');
    expect(panes.length).toBe(1);
    expect(panes[0]!.style.flex).toBe('');
    expect(panes[0]!.style.height).toBe('');
  });
});
