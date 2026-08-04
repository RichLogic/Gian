import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { Sheet } from '../src/components/Sheet.js';
import type { SheetTab } from '../src/components/Sheet.js';

const termOne: SheetTab = {
  id: 'term-1',
  group: 'term',
  name: 'zsh',
  kind: 'term',
  icoKind: 'term',
  ico: '$',
};

const termTwo: SheetTab = {
  id: 'term-2',
  group: 'term',
  name: 'zsh #2',
  kind: 'term',
  icoKind: 'term',
  ico: '$',
};

const actions = {
  activateTab: vi.fn(),
  closeTab: vi.fn(),
  pinTab: vi.fn(),
  setTabViewMode: vi.fn(),
  setTabName: vi.fn(),
};

describe('Sheet terminal tabs', () => {
  it('keeps inactive terminal bodies mounted when the active tab changes', () => {
    const mounts = new Map<string, number>();
    const unmounts = new Map<string, number>();

    function TrackedTerminal({ id }: { id: string }) {
      useEffect(() => {
        mounts.set(id, (mounts.get(id) ?? 0) + 1);
        return () => {
          unmounts.set(id, (unmounts.get(id) ?? 0) + 1);
        };
      }, [id]);
      return <div data-testid={`terminal-${id}`} />;
    }

    const renderTab = (tab: SheetTab) => <TrackedTerminal id={tab.id} />;
    const view = render(
      <Sheet
        tabs={[termOne, termTwo]}
        activeByGroup={{ term: termOne.id }}
        activeGroup="term"
        actions={actions}
        renderTab={renderTab}
      />,
    );

    expect(mounts.get(termOne.id)).toBe(1);
    expect(mounts.get(termTwo.id)).toBe(1);
    expect(view.getByTestId(`terminal-${termTwo.id}`).parentElement?.style.display).toBe('none');

    view.rerender(
      <Sheet
        tabs={[termOne, termTwo]}
        activeByGroup={{ term: termTwo.id }}
        activeGroup="term"
        actions={actions}
        renderTab={renderTab}
      />,
    );

    expect(mounts.get(termOne.id)).toBe(1);
    expect(mounts.get(termTwo.id)).toBe(1);
    expect(unmounts.size).toBe(0);
    expect(view.getByTestId(`terminal-${termOne.id}`).parentElement?.style.display).toBe('none');
    expect(view.getByTestId(`terminal-${termTwo.id}`).parentElement?.style.display).not.toBe('none');
  });
});
