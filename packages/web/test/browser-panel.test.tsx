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
  inspecting: false,
};

const TAB_ID = 'tab-browser-test';
let listener: ((tabId: string, state: GianBrowserState) => void) | null = null;
let elementListener: Parameters<GianBrowserApi['subscribeElement']>[0] | null = null;
let browser: GianBrowserApi;

beforeEach(() => {
  listener = null;
  elementListener = null;
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
    setInspectMode: vi.fn().mockImplementation(async (_tabId, enabled) => ({
      ...initialState,
      inspecting: enabled,
    })),
    subscribe: vi.fn().mockImplementation(cb => {
      listener = cb;
      return () => { listener = null; };
    }),
    subscribeElement: vi.fn().mockImplementation(cb => {
      elementListener = cb;
      return () => { elementListener = null; };
    }),
  };
  window.gianDesktop = { browser };
});

afterEach(() => {
  delete window.gianDesktop;
  vi.restoreAllMocks();
});

function renderPanel(visible = true, contextTargetSessionId: string | null = null) {
  const harness = createOperationHarness();
  return render(
    <LocaleProvider locale="en">
      <BrowserPanel
        tabId={TAB_ID}
        visible={visible}
        contextTargetSessionId={contextTargetSessionId}
      />
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

  it('toggles native inspect mode and stores the captured element in the target Session draft', async () => {
    localStorage.clear();
    renderPanel(true, 'session-browser-context');
    await screen.findByDisplayValue('https://example.com/');

    const inspect = screen.getByRole('button', { name: 'Select element' });
    expect(inspect).toBeEnabled();
    fireEvent.click(inspect);
    await waitFor(() => expect(browser.setInspectMode).toHaveBeenCalledWith(TAB_ID, true));

    act(() => elementListener?.(TAB_ID, {
      pageUrl: 'https://example.com/page',
      pageTitle: 'Example page',
      tagName: 'button',
      selector: 'button[data-testid="save"]',
      role: 'button',
      name: 'Save',
      attributes: { 'data-testid': 'save' },
      contentOmitted: false,
      snippet: '<button data-testid="save">Save</button>',
    }));

    const draft = JSON.parse(
      localStorage.getItem('gian.composer.draft.v4.session-browser-context') ?? 'null',
    );
    expect(draft.contextItems).toEqual([expect.objectContaining({
      type: 'browserElement',
      pageUrl: 'https://example.com/page',
      selector: 'button[data-testid="save"]',
      snippet: '<button data-testid="save">Save</button>',
    })]);
  });

  it('keeps inspect unavailable without an active Session context target', async () => {
    renderPanel();
    await screen.findByDisplayValue('https://example.com/');
    expect(screen.getByRole('button', { name: 'Select element' })).toBeDisabled();
  });

  it('cancels inspection when the active Session context target changes', async () => {
    const harness = createOperationHarness();
    const view = render(
      <LocaleProvider locale="en">
        <BrowserPanel tabId={TAB_ID} visible contextTargetSessionId="session-a" />
      </LocaleProvider>,
      { wrapper: harness.wrapper },
    );
    await screen.findByDisplayValue('https://example.com/');
    act(() => listener?.(TAB_ID, { ...initialState, inspecting: true }));
    view.rerender(
      <LocaleProvider locale="en">
        <BrowserPanel tabId={TAB_ID} visible contextTargetSessionId="session-b" />
      </LocaleProvider>,
    );
    await waitFor(() => expect(browser.setInspectMode).toHaveBeenCalledWith(TAB_ID, false));
  });
});
