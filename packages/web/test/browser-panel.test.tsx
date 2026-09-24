import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { GianBrowserApi, GianBrowserState } from '@gian/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserPanel } from '../src/components/BrowserPanel.js';
import { Sheet } from '../src/components/Sheet.js';
import type { SheetTab } from '../src/components/sheet-model.js';
import { LocaleProvider } from '../src/i18n/index.js';
import { createOperationHarness } from './operation-test-utils.js';
import { mockFetch } from './setup.js';

const initialState: GianBrowserState = {
  url: 'https://example.com/',
  title: 'Example',
  loading: false,
  canGoBack: true,
  canGoForward: false,
  canOpenExternal: true,
  inspecting: false,
  zoomFactor: 1,
};

const TAB_ID = 'tab-browser-test';
let listener: ((tabId: string, state: GianBrowserState) => void) | null = null;
let elementListener: Parameters<GianBrowserApi['subscribeElement']>[0] | null = null;
let findListener: Parameters<GianBrowserApi['subscribeFind']>[0] | null = null;
let findRequestedListener: Parameters<GianBrowserApi['subscribeFindRequested']>[0] | null = null;
let downloadsListener: Parameters<GianBrowserApi['subscribeDownloads']>[0] | null = null;
let permissionsListener: Parameters<GianBrowserApi['subscribePermissions']>[0] | null = null;
let addressRequestedListener: Parameters<GianBrowserApi['subscribeAddressRequested']>[0] | null = null;
let extensionsListener: Parameters<GianBrowserApi['subscribeExtensions']>[0] | null = null;
let browser: GianBrowserApi;

beforeEach(() => {
  listener = null;
  elementListener = null;
  findListener = null;
  findRequestedListener = null;
  downloadsListener = null;
  permissionsListener = null;
  addressRequestedListener = null;
  extensionsListener = null;
  browser = {
    createTab: vi.fn().mockResolvedValue(null),
    listTabs: vi.fn().mockResolvedValue({ revision: 0, tabs: [] }),
    configure: vi.fn().mockResolvedValue(true),
    listDownloads: vi.fn().mockResolvedValue({ revision: 0, downloads: [] }),
    cancelDownload: vi.fn().mockResolvedValue(true),
    revealDownload: vi.fn().mockResolvedValue(true),
    listPermissionRequests: vi.fn().mockResolvedValue({ revision: 0, requests: [] }),
    respondPermission: vi.fn().mockResolvedValue(true),
    listExtensions: vi.fn().mockResolvedValue({ revision: 0, extensions: [] }),
    installExtension: vi.fn().mockResolvedValue(null),
    setExtensionEnabled: vi.fn().mockResolvedValue(true),
    removeExtension: vi.fn().mockResolvedValue(true),
    getState: vi.fn().mockResolvedValue(initialState),
    navigate: vi.fn().mockImplementation(async (_tabId, url) => ({ ...initialState, url })),
    openProject: vi.fn().mockResolvedValue(initialState),
    goBack: vi.fn().mockResolvedValue(initialState),
    goForward: vi.fn().mockResolvedValue(initialState),
    reload: vi.fn().mockResolvedValue(initialState),
    recover: vi.fn().mockResolvedValue(initialState),
    stop: vi.fn().mockResolvedValue(initialState),
    findInPage: vi.fn(),
    stopFindInPage: vi.fn().mockResolvedValue(true),
    openDevTools: vi.fn().mockResolvedValue(true),
    setLayout: vi.fn().mockResolvedValue(true),
    captureFrame: vi.fn().mockResolvedValue('data:image/png;base64,Zm9vZQ=='),
    capturePageSnapshot: vi.fn().mockResolvedValue(null),
    capturePageScreenshot: vi.fn().mockResolvedValue(null),
    setBackground: vi.fn().mockResolvedValue(true),
    setZoom: vi.fn().mockImplementation(async (_tabId, factor) => ({
      ...initialState,
      zoomFactor: factor,
    })),
    openExternal: vi.fn().mockResolvedValue(true),
    closeTab: vi.fn().mockResolvedValue(true),
    clearData: vi.fn().mockResolvedValue(true),
    setInspectMode: vi.fn().mockImplementation(async (_tabId, enabled) => ({
      ...initialState,
      inspecting: enabled,
    })),
    subscribeTabs: vi.fn(() => () => {}),
    subscribePresentationRequested: vi.fn(() => () => {}),
    subscribe: vi.fn().mockImplementation(cb => {
      listener = cb;
      return () => { listener = null; };
    }),
    subscribeFind: vi.fn().mockImplementation(cb => {
      findListener = cb;
      return () => { findListener = null; };
    }),
    subscribeFindRequested: vi.fn().mockImplementation(cb => {
      findRequestedListener = cb;
      return () => { findRequestedListener = null; };
    }),
    subscribeAddressRequested: vi.fn().mockImplementation(cb => {
      addressRequestedListener = cb;
      return () => { addressRequestedListener = null; };
    }),
    subscribeDownloads: vi.fn().mockImplementation(cb => {
      downloadsListener = cb;
      return () => { downloadsListener = null; };
    }),
    subscribePermissions: vi.fn().mockImplementation(cb => {
      permissionsListener = cb;
      return () => { permissionsListener = null; };
    }),
    subscribeExtensions: vi.fn().mockImplementation(cb => {
      extensionsListener = cb;
      return () => { extensionsListener = null; };
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

async function openBrowserMenu(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'More Browser actions' }));
  // The menu overlays a captured freeze frame, so it opens after the
  // captureFrame round-trip resolves.
  await screen.findByRole('menu', { name: 'More Browser actions' });
}

describe('BrowserPanel', () => {
  it('keeps navigation, element selection, and external open visible while moving utilities into More', async () => {
    renderPanel(true, 'session-browser-menu');
    await screen.findByDisplayValue('https://example.com/');
    expect(screen.getByRole('button', { name: 'Back' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Select element' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Open in system browser' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Find in page' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Downloads' })).not.toBeInTheDocument();

    await openBrowserMenu();
    expect(screen.getByRole('menu', { name: 'More Browser actions' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Find in page' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Downloads' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Extensions' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Open DevTools' })).toBeVisible();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Find in page' }));
    expect(screen.getByRole('textbox', { name: 'Find text' })).toBeVisible();
    expect(screen.queryByRole('menu', { name: 'More Browser actions' })).not.toBeInTheDocument();

    await openBrowserMenu();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'More Browser actions' })).not.toBeInTheDocument();
  });

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

  it('floats the menu over a freeze frame instead of resizing the page', async () => {
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if (!this.classList.contains('browser-viewport')) return originalRect.call(this);
      return {
        x: 10, y: 20, left: 10, top: 20, right: 410, bottom: 220,
        width: 400, height: 200, toJSON: () => ({}),
      } as DOMRect;
    });
    renderPanel(true, 'session-browser-menu');
    await waitFor(() => expect(browser.setLayout).toHaveBeenCalledWith(
      TAB_ID,
      { x: 10, y: 20, width: 400, height: 200 },
      true,
    ));

    await openBrowserMenu();
    expect(browser.captureFrame).toHaveBeenCalledWith(TAB_ID);
    // The native view hides while the menu is open — it never gets squeezed
    // narrower (Electron would paint it over the HTML menu).
    await waitFor(() => expect(browser.setLayout).toHaveBeenLastCalledWith(
      TAB_ID, expect.any(Object), false,
    ));
    expect(browser.setLayout).not.toHaveBeenCalledWith(
      TAB_ID, expect.objectContaining({ width: 180 }), expect.anything(),
    );
    expect(document.querySelector('.browser-freeze')).not.toBeNull();
    expect(screen.getByRole('menu', { name: 'More Browser actions' })).toBeVisible();

    // Closing restores the native view at the same bounds.
    fireEvent.click(screen.getByRole('button', { name: 'More Browser actions' }));
    await waitFor(() => expect(browser.setLayout).toHaveBeenLastCalledWith(
      TAB_ID,
      { x: 10, y: 20, width: 400, height: 200 },
      true,
    ));
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

  it('attaches a tab reference chip to the target Session composer from the More menu', async () => {
    localStorage.clear();
    renderPanel(true, 'session-browser-attach');
    await screen.findByDisplayValue('https://example.com/');

    await openBrowserMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Attach tab reference' }));

    expect(screen.queryByRole('menu', { name: 'More Browser actions' })).not.toBeInTheDocument();
    const draft = JSON.parse(
      localStorage.getItem('gian.composer.draft.v4.session-browser-attach') ?? 'null',
    );
    expect(draft.contextItems).toHaveLength(1);
    expect(draft.contextItems[0]).toEqual(expect.objectContaining({ type: 'pastedText' }));
    expect(draft.contextItems[0].text).toContain(
      `Browser tab · Example · https://example.com/ · tabId ${TAB_ID}`,
    );
    expect(draft.contextItems[0].text).toContain(`tab_id "${TAB_ID}"`);
  });

  it('attaches a page snapshot chip after the menu closes and the native view restores', async () => {
    localStorage.clear();
    vi.mocked(browser.capturePageSnapshot).mockResolvedValue({
      url: 'https://example.com/',
      title: 'Example',
      tree: '- RootWebArea "Example"\n  - button "Save" [ref=@e1]',
      truncated: false,
      snapshotId: 'browser-snapshot-test',
    });
    renderPanel(true, 'session-browser-attach');
    await screen.findByDisplayValue('https://example.com/');

    await openBrowserMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Attach page snapshot' }));

    // The capture waits for the native view to reattach after the menu closes.
    expect(screen.queryByRole('menu', { name: 'More Browser actions' })).not.toBeInTheDocument();
    await waitFor(() => expect(browser.capturePageSnapshot).toHaveBeenCalledWith(TAB_ID));
    await waitFor(() => {
      const draft = JSON.parse(
        localStorage.getItem('gian.composer.draft.v4.session-browser-attach') ?? 'null',
      );
      expect(draft?.contextItems?.[0]?.text ?? '').toContain('Page snapshot · Example');
    });
    const draft = JSON.parse(
      localStorage.getItem('gian.composer.draft.v4.session-browser-attach') ?? 'null',
    );
    expect(draft.contextItems[0].text).toContain(`tabId ${TAB_ID} · snapshotId browser-snapshot-test`);
    expect(draft.contextItems[0].text).toContain('- button "Save" [ref=@e1]');
  });

  it('uploads a viewport screenshot and attaches it as an image in the target composer', async () => {
    localStorage.clear();
    vi.mocked(browser.capturePageScreenshot).mockResolvedValue({
      mimeType: 'image/png',
      base64: btoa('png-bytes'),
      width: 1_280,
      height: 800,
    });
    mockFetch(async input => {
      if (String(input).includes('/api/sessions/session-browser-attach/attachments')) {
        return new Response(JSON.stringify({
          path: '/uploads/shot.png',
          name: 'browser-screenshot.png',
          mime: 'image/png',
          size: 9,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 404 });
    });
    renderPanel(true, 'session-browser-attach');
    await screen.findByDisplayValue('https://example.com/');

    await openBrowserMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Attach screenshot' }));

    await waitFor(() => expect(browser.capturePageScreenshot).toHaveBeenCalledWith(TAB_ID));
    await waitFor(() => {
      const draft = JSON.parse(
        localStorage.getItem('gian.composer.draft.v4.session-browser-attach') ?? 'null',
      );
      expect(draft?.attachments?.[0]?.path).toBe('/uploads/shot.png');
    });
    const draft = JSON.parse(
      localStorage.getItem('gian.composer.draft.v4.session-browser-attach') ?? 'null',
    );
    expect(draft.attachments[0]).toEqual(expect.objectContaining({
      name: 'browser-screenshot.png',
      mime: 'image/png',
    }));
  });

  it('attaches nothing when the main-side capture fails', async () => {
    localStorage.clear();
    vi.mocked(browser.capturePageSnapshot).mockResolvedValue(null);
    vi.mocked(browser.capturePageScreenshot).mockResolvedValue(null);
    renderPanel(true, 'session-browser-attach');
    await screen.findByDisplayValue('https://example.com/');

    await openBrowserMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Attach page snapshot' }));
    await waitFor(() => expect(browser.capturePageSnapshot).toHaveBeenCalledWith(TAB_ID));
    await openBrowserMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Attach screenshot' }));
    await waitFor(() => expect(browser.capturePageScreenshot).toHaveBeenCalledWith(TAB_ID));

    await waitFor(() => expect(browser.capturePageScreenshot).toHaveBeenCalledTimes(1));
    expect(localStorage.getItem('gian.composer.draft.v4.session-browser-attach')).toBeNull();
  });

  it('keeps the attach actions unavailable without an active Session context target', async () => {
    renderPanel();
    await screen.findByDisplayValue('https://example.com/');
    await openBrowserMenu();
    expect(screen.getByRole('menuitem', { name: 'Attach screenshot' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: 'Attach page snapshot' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: 'Attach tab reference' })).toBeDisabled();
  });

  it('hides the toolbar and attach actions entirely off desktop', () => {
    delete window.gianDesktop;
    const harness = createOperationHarness();
    render(
      <LocaleProvider locale="en">
        <BrowserPanel tabId={TAB_ID} visible contextTargetSessionId="session-off-desktop" />
      </LocaleProvider>,
      { wrapper: harness.wrapper },
    );
    expect(screen.getByText('Browser is available in the Electron desktop app.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More Browser actions' })).not.toBeInTheDocument();
  });

  it('forwards page titles as the Sheet tab name with a default fallback and no rename loops', async () => {
    const onTitleChange = vi.fn();
    const harness = createOperationHarness();
    render(
      <LocaleProvider locale="en">
        <BrowserPanel tabId={TAB_ID} visible onTitleChange={onTitleChange} />
      </LocaleProvider>,
      { wrapper: harness.wrapper },
    );
    await screen.findByDisplayValue('https://example.com/');
    // The initial getState reading already carries the live page title.
    await waitFor(() => expect(onTitleChange).toHaveBeenCalledWith('Example'));
    expect(onTitleChange).toHaveBeenCalledTimes(1);

    act(() => listener?.(TAB_ID, { ...initialState, title: 'Docs — Example' }));
    expect(onTitleChange).toHaveBeenLastCalledWith('Docs — Example');
    expect(onTitleChange).toHaveBeenCalledTimes(2);

    // An echo of the same title must not rename again.
    act(() => listener?.(TAB_ID, { ...initialState, title: 'Docs — Example' }));
    expect(onTitleChange).toHaveBeenCalledTimes(2);

    // A blank page falls back to the default tab name.
    act(() => listener?.(TAB_ID, { ...initialState, url: '', title: '' }));
    expect(onTitleChange).toHaveBeenLastCalledWith('Browser');
    expect(onTitleChange).toHaveBeenCalledTimes(3);
  });

  it('drives per-tab zoom from the toolbar controls', async () => {
    renderPanel();
    await screen.findByDisplayValue('https://example.com/');
    await openBrowserMenu();
    expect(screen.getByRole('button', { name: 'Reset zoom' })).toHaveTextContent('100%');

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    await waitFor(() => expect(browser.setZoom).toHaveBeenCalledWith(TAB_ID, 1.1));
    expect(screen.getByRole('button', { name: 'Reset zoom' })).toHaveTextContent('110%');

    // Clicking the percentage resets to 100%.
    fireEvent.click(screen.getByRole('button', { name: 'Reset zoom' }));
    await waitFor(() => expect(browser.setZoom).toHaveBeenLastCalledWith(TAB_ID, 1));

    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    await waitFor(() => expect(browser.setZoom).toHaveBeenLastCalledWith(TAB_ID, 0.9));

    // Bounds disable the step buttons.
    act(() => listener?.(TAB_ID, { ...initialState, zoomFactor: 0.25 }));
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeDisabled();
    act(() => listener?.(TAB_ID, { ...initialState, zoomFactor: 5 }));
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeDisabled();
  });

  it('handles zoom keyboard shortcuts while the native view is not focused', async () => {
    renderPanel();
    await screen.findByDisplayValue('https://example.com/');

    fireEvent.keyDown(document, { key: '=', metaKey: true });
    await waitFor(() => expect(browser.setZoom).toHaveBeenCalledWith(TAB_ID, 1.1));

    fireEvent.keyDown(document, { key: '0', metaKey: true });
    await waitFor(() => expect(browser.setZoom).toHaveBeenLastCalledWith(TAB_ID, 1));

    fireEvent.keyDown(document, { key: '-', ctrlKey: true });
    await waitFor(() => expect(browser.setZoom).toHaveBeenLastCalledWith(TAB_ID, 0.9));
  });

  it('handles Browser navigation shortcuts and native address-focus requests', async () => {
    renderPanel(true, 'session-shortcuts');
    const address = await screen.findByDisplayValue('https://example.com/');

    fireEvent.keyDown(document, { key: 'l', metaKey: true });
    expect(address).toHaveFocus();
    fireEvent.keyDown(document, { key: 'r', metaKey: true });
    fireEvent.keyDown(document, { key: 't', metaKey: true });
    fireEvent.keyDown(document, { key: '[', metaKey: true });
    fireEvent.keyDown(document, { key: ']', metaKey: true });
    await waitFor(() => expect(browser.reload).toHaveBeenCalledWith(TAB_ID));
    expect(browser.createTab).toHaveBeenCalledWith({
      sourceSessionId: 'session-shortcuts',
      activate: true,
    });
    expect(browser.goBack).toHaveBeenCalledWith(TAB_ID);
    expect(browser.goForward).toHaveBeenCalledWith(TAB_ID);

    fireEvent.blur(address);
    act(() => addressRequestedListener?.(TAB_ID));
    expect(address).toHaveFocus();
  });

  it('offers main-owned recovery after a Browser renderer failure', async () => {
    renderPanel();
    await screen.findByDisplayValue('https://example.com/');
    act(() => listener?.(TAB_ID, {
      ...initialState,
      recoverable: true,
      error: 'Browser renderer stopped: crashed',
    }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reload page' }));
    });
    expect(browser.recover).toHaveBeenCalledWith(TAB_ID);
  });

  it('finds text in the native page from the toolbar and native focus shortcut', async () => {
    renderPanel();
    await screen.findByDisplayValue('https://example.com/');

    act(() => findRequestedListener?.(TAB_ID));
    const input = screen.getByRole('textbox', { name: 'Find text' });
    fireEvent.change(input, { target: { value: 'needle' } });
    expect(browser.findInPage).toHaveBeenCalledWith(TAB_ID, 'needle', {
      forward: true,
      findNext: false,
    });

    act(() => findListener?.(TAB_ID, {
      requestId: 1,
      activeMatchOrdinal: 2,
      matches: 5,
      finalUpdate: true,
    }));
    expect(screen.getByText('2/5')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Previous match' }));
    expect(browser.findInPage).toHaveBeenLastCalledWith(TAB_ID, 'needle', {
      forward: false,
      findNext: true,
    });

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(browser.stopFindInPage).toHaveBeenCalledWith(TAB_ID);
    expect(screen.queryByRole('textbox', { name: 'Find text' })).not.toBeInTheDocument();
  });

  it('opens detached DevTools only through the trusted Browser bridge', async () => {
    renderPanel();
    await screen.findByDisplayValue('https://example.com/');
    await openBrowserMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open DevTools' }));
    expect(browser.openDevTools).toHaveBeenCalledWith(TAB_ID);
  });

  it('shows main-owned downloads and routes cancel and reveal actions', async () => {
    renderPanel();
    await screen.findByDisplayValue('https://example.com/');
    await openBrowserMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Downloads' }));
    expect(screen.getByText('No downloads')).toBeInTheDocument();

    act(() => downloadsListener?.({
      revision: 1,
      downloads: [{
        id: 'download-active',
        tabId: TAB_ID,
        filename: 'artifact.zip',
        mimeType: 'application/zip',
        status: 'progressing',
        receivedBytes: 1_024,
        totalBytes: 2_048,
        canCancel: true,
        canReveal: false,
      }, {
        id: 'download-complete',
        tabId: TAB_ID,
        filename: 'report.pdf',
        mimeType: 'application/pdf',
        status: 'completed',
        receivedBytes: 4_096,
        totalBytes: 4_096,
        canCancel: false,
        canReveal: true,
      }],
    }));

    expect(screen.getByText('artifact.zip')).toBeInTheDocument();
    expect(screen.getByText('1 KB / 2 KB')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel download' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show in Finder' }));
    expect(browser.cancelDownload).toHaveBeenCalledWith('download-active');
    expect(browser.revealDownload).toHaveBeenCalledWith('download-complete');
  });

  it('shows an origin-bound site permission prompt and preserves explicit decisions', async () => {
    renderPanel();
    await screen.findByDisplayValue('https://example.com/');
    act(() => permissionsListener?.({
      revision: 1,
      requests: [{
        id: 'permission-1',
        tabId: TAB_ID,
        origin: 'https://example.com',
        kinds: ['camera', 'microphone'],
      }],
    }));

    expect(screen.getByRole('alertdialog', { name: 'Site permission request' }))
      .toHaveTextContent('https://example.com');
    expect(screen.getByText('Camera, Microphone')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Always allow' }));
    expect(browser.respondPermission).toHaveBeenCalledWith('permission-1', 'allow_always');
  });

  it('manages unpacked extensions and exposes compatibility warnings honestly', async () => {
    renderPanel();
    await screen.findByDisplayValue('https://example.com/');
    await openBrowserMenu();
    const extensionsButton = screen.getByRole('menuitem', { name: 'Extensions' });
    fireEvent.click(extensionsButton);
    expect(screen.getByText('No extensions loaded')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load unpacked' }));
    expect(browser.installExtension).toHaveBeenCalledTimes(1);

    act(() => extensionsListener?.({
      revision: 1,
      extensions: [{
        key: 'extension-1',
        extensionId: 'chrome-extension-id',
        sourceName: 'fixture-extension',
        name: 'Fixture Extension',
        version: '1.2.3',
        manifestVersion: 3,
        enabled: true,
        status: 'ready',
        permissions: ['storage'],
        warnings: ['Electron does not declare manifest key "action" as supported'],
      }],
    }));
    expect(screen.getByText('Fixture Extension')).toBeInTheDocument();
    expect(screen.getByTitle(/manifest key "action"/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Fixture Extension enabled' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove extension' }));
    expect(browser.setExtensionEnabled).toHaveBeenCalledWith('extension-1', false);
    expect(browser.removeExtension).toHaveBeenCalledWith('extension-1');
  });
});
