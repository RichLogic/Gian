import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { Sheet } from '../src/components/Sheet.js';
import type { SheetTab } from '../src/components/Sheet.js';

const fileTab: SheetTab = {
  id: 'f1', group: 'files', name: 'foo.ts', kind: 'file', icoKind: 'ts', ico: 'TS',
  lines: [['1', 'const a = 1']], fullPath: '/tmp/foo.ts', viewMode: 'source',
};
const termTab: SheetTab = {
  id: 'term1', group: 'term', name: 'zsh', kind: 'term', icoKind: 'term', ico: '$',
};

const actions = {
  activateTab: vi.fn(), closeTab: vi.fn(), pinTab: vi.fn(), setTabViewMode: vi.fn(),
};

function renderSheet(props: Partial<React.ComponentProps<typeof Sheet>>) {
  return render(
    <Sheet
      tabs={[fileTab, termTab]}
      activeByGroup={{ files: 'f1', term: 'term1' }}
      activeGroup="files"
      actions={actions}
      renderTab={() => <div>term-body</div>}
      {...props}
    />,
  );
}

describe('Sheet tab groups', () => {
  it('renders one .sheet-group per tab group, sized to fill the sheet', () => {
    const { container } = renderSheet({});
    const groups = container.querySelectorAll<HTMLElement>('.sheet-group');
    expect(groups.length).toBe(2);
    // Groups fill via CSS (.sheet-group flex: 1 1 0) — no inline sizing.
    expect(groups[0]!.style.flex).toBe('');
    expect(groups[0]!.style.height).toBe('');
  });

  it('shows only the active rail group; others stay mounted display:none', () => {
    const { container } = renderSheet({ activeGroup: 'files' });
    const groups = container.querySelectorAll<HTMLElement>('.sheet-group');
    expect(groups.length).toBe(2);
    // files group visible, term group hidden but mounted (xterm keep-alive).
    expect(groups[0]!.style.display).not.toBe('none');
    expect(groups[1]!.style.display).toBe('none');
  });

  it('keeps every group mounted when the whole sheet is hidden', () => {
    const { container } = renderSheet({ hidden: true });
    const sheet = container.querySelector<HTMLElement>('.sheet')!;
    expect(sheet.style.display).toBe('none');
    // Groups (and their terminals) stay in the DOM across visibility flips.
    expect(sheet.querySelectorAll('.sheet-group').length).toBe(2);
  });
});
