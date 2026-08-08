import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { GianBrowserApi, GianBrowserState } from '@gian/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserPanel } from '../src/components/BrowserPanel.js';
import { Sheet } from '../src/components/Sheet.js';
import type { SheetTab } from '../src/components/sheet-model.js';
import { LocaleProvider } from '../src/i18n/index.js';
import { createOperationHarness } from './operation-test-utils.js';

const initialState: GianBrowserState = {
  url: 'https://example.com/',
  title: 'Example',
  loading: false,
  canGoBack: true,
  canGoForward: false,
  canOpenExternal: true,
};

const TAB_ID = 'tab-browser-test';
let listener: ((tabId: string, state: GianBrowserState) => void) | null = null;
let browser: GianBrowserApi;

beforeEach(() => {
  listener = null;
  browser = {
    getState: vi.fn().mockResolvedValue(initialState),
    navigate: vi.fn().mockImplementation(async (_tabId, url) => ({ ...initialState, url })),
    openProject: vi.fn().mockResolvedValue(initialState),
    goBack: vi.fn().mockResolvedValue(initialState),
    goForward: vi.fn().mockResolvedValue(initialState),
    reload: vi.fn().mockResolvedValue(initialState),
    stop: vi.fn().mockResolvedValue(initialState),
    setLayout: vi.fn().mockResolvedValue(true),
    openExternal: vi.fn().mockResolvedValue(true),
    closeTab: vi.fn().mockResolvedValue(true),
    clearData: vi.fn().mockResolvedValue(true),
    subscribe: vi.fn().mockImplementation(cb => {
      listener = cb;
      return () => { listener = null; };
    }),
  };
  window.gianDesktop = { browser };
});

afterEach(() => {
  delete window.gianDesktop;
  vi.restoreAllMocks();
});

function renderPanel(visible = true) {
  const harness = createOperationHarness();
  return render(
    <LocaleProvider locale="en">
      <BrowserPanel tabId={TAB_ID} visible={visible} />
    </LocaleProvider>,
    { wrapper: harness.wrapper },
  );
}

describe('BrowserPanel', () => {
  it('subscribes to Browser state and normalizes address-bar navigation', async () => {
    renderPanel();
    const address = await screen.findByLabelText('Browser address') as HTMLInputElement;
    await waitFor(() => expect(address.value).toBe('https://example.com/'));

    fireEvent.focus(address);
    fireEvent.change(address, { target: { value: 'localhost:5173' } });
    fireEvent.submit(address.closest('form')!);
    await waitFor(() => expect(browser.navigate).toHaveBeenCalledWith(TAB_ID, 'http://localhost:5173/'));

    act(() => listener?.(TAB_ID, { ...initialState, url: 'https://next.example/' }));
    fireEvent.blur(address);
    expect(address.value).toBe('https://next.example/');
  });

  it('mirrors visibility into native layout and hides the view on unmount', async () => {
    const rendered = renderPanel(true);
    await waitFor(() => expect(browser.setLayout).toHaveBeenCalledWith(
      TAB_ID,
      expect.objectContaining({ width: 0, height: 0 }),
      true,
    ));
    rendered.unmount();
    expect(browser.setLayout).toHaveBeenLastCalledWith(TAB_ID, expect.any(Object), false);
  });

  it('tracks position-only layout changes during panel animation and resizing', async () => {
    let left = 10;
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if (!this.classList.contains('browser-viewport')) return originalRect.call(this);
      return {
        x: left,
        y: 20,
        left,
        top: 20,
        right: left + 300,
        bottom: 220,
        width: 300,
        height: 200,
        toJSON: () => ({}),
      } as DOMRect;
    });

    const rendered = renderPanel(true);
    await waitFor(() => expect(browser.setLayout).toHaveBeenCalledWith(
      TAB_ID,
      { x: 10, y: 20, width: 300, height: 200 },
      true,
    ));
    left = 34;
    await waitFor(() => expect(browser.setLayout).toHaveBeenCalledWith(
      TAB_ID,
      { x: 34, y: 20, width: 300, height: 200 },
      true,
    ));
    rendered.unmount();
  });

  it('renders Browser in the standard Sheet tab strip', () => {
    const tab: SheetTab = {
      id: 'tab-browser',
      group: 'browser',
      name: 'Browser',
      kind: 'browser',
      icoKind: 'browser',
      ico: '◎',
    };
    const actions = {
      activateTab: vi.fn(),
      closeTab: vi.fn(),
      pinTab: vi.fn(),
      setTabViewMode: vi.fn(),
      setTabName: vi.fn(),
    };
    const onAddTab = vi.fn();
    render(
      <LocaleProvider locale="en">
        <Sheet
          tabs={[tab]}
          activeByGroup={{ browser: tab.id }}
          activeGroup="browser"
          actions={actions}
          onAddTab={onAddTab}
          renderTab={() => <div>Browser body</div>}
        />
      </LocaleProvider>,
    );
    expect(screen.getByTestId('sheet-tab-browser')).toHaveTextContent('Browser');
    fireEvent.click(screen.getByTitle('New Browser tab'));
    expect(onAddTab).toHaveBeenCalledWith('browser');
  });

  it('drives back/reload controls from Browser state', async () => {
    renderPanel();
    await screen.findByDisplayValue('https://example.com/');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    });
    expect(browser.goBack).toHaveBeenCalledTimes(1);
    expect(browser.reload).toHaveBeenCalledTimes(1);
    expect(browser.goBack).toHaveBeenCalledWith(TAB_ID);
    expect(browser.reload).toHaveBeenCalledWith(TAB_ID);
    expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled();
  });
});
