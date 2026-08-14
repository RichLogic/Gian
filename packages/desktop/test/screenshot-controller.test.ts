import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BrowserWindowConstructorOptions } from 'electron';
import type { GianScreenshotCapture } from '@gian/shared';
import {
  MAC_SCREENSHOT_SHORTCUT,
  MAX_SCREENSHOT_BYTES,
  OTHER_SCREENSHOT_SHORTCUT,
  ScreenshotController,
  displayContainingPoint,
  mapDipRectToImagePixels,
  matchDisplaySources,
  screenshotShortcutForPlatform,
  thumbnailSizeForDisplays,
  validatedPngBytes,
  type ScreenshotControllerDependencies,
  type ScreenshotDisplay,
  type ScreenshotOverlayWindow,
  type ScreenshotSource,
} from '../src/screenshot/controller.js';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class FakeWebContents {
  readonly listeners: Array<() => void> = [];
  destroyed = false;

  constructor(readonly id: number) {}

  isDestroyed(): boolean {
    return this.destroyed;
  }

  once(event: 'render-process-gone', listener: () => void): this {
    assert.equal(event, 'render-process-gone');
    this.listeners.push(listener);
    return this;
  }

  crash(): void {
    this.destroyed = true;
    for (const listener of this.listeners.splice(0)) listener();
  }
}

class FakeOverlayWindow implements ScreenshotOverlayWindow {
  readonly webContents: FakeWebContents;
  readonly closedListeners: Array<() => void> = [];
  destroyed = false;
  shown = false;
  hidden = false;
  focused = false;
  loadedPath: string | null = null;
  loadCount = 0;
  alwaysOnTop: unknown[] | null = null;
  allWorkspaces: unknown[] | null = null;

  constructor(
    id: number,
    readonly options: BrowserWindowConstructorOptions,
  ) {
    this.webContents = new FakeWebContents(id);
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  once(event: 'closed', listener: () => void): this {
    assert.equal(event, 'closed');
    this.closedListeners.push(listener);
    return this;
  }

  async loadFile(path: string): Promise<void> {
    this.loadedPath = path;
    this.loadCount += 1;
  }

  hide(): void {
    this.shown = false;
    this.hidden = true;
  }

  show(): void {
    this.shown = true;
    this.hidden = false;
  }

  showInactive(): void {
    this.shown = true;
    this.hidden = false;
  }

  focus(): void {
    this.focused = true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const listener of this.closedListeners.splice(0)) listener();
  }

  setAlwaysOnTop(...args: Parameters<ScreenshotOverlayWindow['setAlwaysOnTop']>): void {
    this.alwaysOnTop = args;
  }

  setVisibleOnAllWorkspaces(
    ...args: Parameters<ScreenshotOverlayWindow['setVisibleOnAllWorkspaces']>
  ): void {
    this.allWorkspaces = args;
  }
}

function fakeImage(
  width: number,
  height: number,
  pngBytes = PNG_BYTES,
): ScreenshotSource['thumbnail'] {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    toPNG: () => Buffer.from(pngBytes),
  };
}

const DISPLAYS: ScreenshotDisplay[] = [
  {
    id: 11,
    bounds: { x: -1280, y: 0, width: 1280, height: 800 },
    scaleFactor: 1,
  },
  {
    id: 22,
    bounds: { x: 0, y: -100, width: 1512, height: 982 },
    scaleFactor: 2,
  },
];

interface Harness {
  controller: ScreenshotController;
  windows: FakeOverlayWindow[];
  captures: GianScreenshotCapture[];
  errors: string[];
  restores: Array<'cancel' | 'success' | 'clipboard'>;
  shortcuts: string[];
  unregistered: string[];
  permissionHelp: { count: number };
  clipboardWrites: Uint8Array[];
  fireDisplayChange(): void;
}

function createHarness(
  overrides: Partial<ScreenshotControllerDependencies> = {},
): Harness {
  const windows: FakeOverlayWindow[] = [];
  const captures: GianScreenshotCapture[] = [];
  const errors: string[] = [];
  const restores: Array<'cancel' | 'success' | 'clipboard'> = [];
  const shortcuts: string[] = [];
  const unregistered: string[] = [];
  const permissionHelp = { count: 0 };
  const clipboardWrites: Uint8Array[] = [];
  let displayChangeListener: (() => void) | null = null;

  const dependencies: ScreenshotControllerDependencies = {
    platform: 'darwin',
    overlayHtmlPath: '/app/renderer/screenshot.html',
    overlayPreloadPath: '/app/dist/screenshot-preload.cjs',
    listDisplays: () => DISPLAYS,
    getCursorPoint: () => ({ x: 100, y: 100 }),
    captureScreens: async () => [
      { display_id: '11', thumbnail: fakeImage(1280, 800) },
      { display_id: '22', thumbnail: fakeImage(3024, 1964) },
    ],
    createOverlayWindow: options => {
      const window = new FakeOverlayWindow(100 + windows.length, options);
      windows.push(window);
      return window;
    },
    getScreenPermissionStatus: () => 'granted',
    showScreenPermissionHelp: async () => { permissionHelp.count += 1; },
    prepareMainWindow: async () => ({ hidden: true }),
    restoreMainWindow: async (_token, outcome) => { restores.push(outcome); },
    waitForDesktopToSettle: async () => undefined,
    watchDisplayChanges: listener => {
      displayChangeListener = listener;
      return () => { displayChangeListener = null; };
    },
    registerGlobalShortcut: accelerator => {
      shortcuts.push(accelerator);
      return true;
    },
    unregisterGlobalShortcut: accelerator => { unregistered.push(accelerator); },
    randomId: () => 'capture-1',
    now: () => new Date('2026-08-12T12:34:56.789Z'),
    writePngToClipboard: bytes => {
      clipboardWrites.push(new Uint8Array(bytes));
      return true;
    },
    onCaptured: capture => { captures.push(capture); },
    onError: error => { errors.push(error); },
    ...overrides,
  };

  return {
    controller: new ScreenshotController(dependencies),
    windows,
    captures,
    errors,
    restores,
    shortcuts,
    unregistered,
    permissionHelp,
    clipboardWrites,
    fireDisplayChange: () => { displayChangeListener?.(); },
  };
}

function setSessionTarget(controller: ScreenshotController, sessionId = 'session-1'): void {
  controller.setTarget({ kind: 'session', sessionId, label: `Session ${sessionId}` });
}

function nextTurn(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

describe('screenshot geometry and validation', () => {
  it('uses the expected global shortcut on each platform', () => {
    assert.equal(screenshotShortcutForPlatform('darwin'), MAC_SCREENSHOT_SHORTCUT);
    assert.equal(screenshotShortcutForPlatform('win32'), OTHER_SCREENSHOT_SHORTCUT);
    assert.equal(screenshotShortcutForPlatform('linux'), OTHER_SCREENSHOT_SHORTCUT);
  });

  it('requests enough pixels for mixed-DPI displays and finds negative-origin displays', () => {
    assert.deepEqual(thumbnailSizeForDisplays(DISPLAYS), { width: 3024, height: 1964 });
    assert.equal(displayContainingPoint(DISPLAYS, { x: -1, y: 1 })?.id, 11);
    assert.equal(displayContainingPoint(DISPLAYS, { x: 0, y: 1 })?.id, 22);
    assert.equal(displayContainingPoint(DISPLAYS, { x: 9999, y: 1 }), null);
  });

  it('matches sources only by an exact display id and fails closed', () => {
    const validSources = [
      { display_id: '22', thumbnail: fakeImage(3024, 1964) },
      { display_id: '11', thumbnail: fakeImage(1280, 800) },
    ];
    assert.equal(matchDisplaySources(DISPLAYS, validSources).get(11), validSources[1]);
    assert.throws(() => matchDisplaySources(DISPLAYS, validSources.slice(0, 1)));
    assert.throws(() => matchDisplaySources(DISPLAYS, [
      validSources[0]!,
      { display_id: '22', thumbnail: fakeImage(3024, 1964) },
    ]));
    assert.throws(() => matchDisplaySources(DISPLAYS, [
      validSources[0]!,
      { display_id: '99', thumbnail: fakeImage(1280, 800) },
    ]));
  });

  it('maps overlay DIP coordinates with independent actual image scales and clamps edges', () => {
    assert.deepEqual(
      mapDipRectToImagePixels(
        { x: 100.2, y: 50.2, width: 200.2, height: 100.2 },
        DISPLAYS[1]!.bounds,
        { width: 3024, height: 1473 },
      ),
      { x: 200, y: 75, width: 401, height: 151 },
    );
    assert.deepEqual(
      mapDipRectToImagePixels(
        { x: 30, y: 20, width: -50, height: -40 },
        DISPLAYS[0]!.bounds,
        { width: 1280, height: 800 },
      ),
      { x: 0, y: 0, width: 30, height: 20 },
    );
  });

  it('accepts only an owned PNG byte array within the attachment budget', () => {
    const accepted = validatedPngBytes(PNG_BYTES);
    assert.deepEqual(accepted, PNG_BYTES);
    assert.notEqual(accepted, PNG_BYTES);
    assert.equal(validatedPngBytes(new Uint8Array([1, 2, 3])), null);
    const oversized = new Uint8Array(MAX_SCREENSHOT_BYTES + 1);
    oversized.set(PNG_BYTES);
    assert.equal(validatedPngBytes(oversized), null);
  });
});

describe('screenshot controller lifecycle', () => {
  it('reports shortcut conflicts and unregisters only the shortcut it owns', () => {
    const conflicted = createHarness({ registerGlobalShortcut: () => false });
    assert.equal(conflicted.controller.registerShortcut(), false);
    assert.deepEqual(conflicted.errors, ['shortcut-unavailable']);
    conflicted.controller.dispose();
    assert.deepEqual(conflicted.unregistered, []);

    const registered = createHarness();
    assert.equal(registered.controller.registerShortcut(), true);
    assert.deepEqual(registered.shortcuts, [MAC_SCREENSHOT_SHORTCUT]);
    registered.controller.dispose();
    assert.deepEqual(registered.unregistered, [MAC_SCREENSHOT_SHORTCUT]);
  });

  it('blocks capture when screen permission is denied', async () => {
    let captureCalls = 0;
    const harness = createHarness({
      getScreenPermissionStatus: () => 'denied',
      captureScreens: async () => {
        captureCalls += 1;
        return [];
      },
    });
    setSessionTarget(harness.controller);

    assert.deepEqual(await harness.controller.start(), {
      ok: false,
      error: 'permission-denied',
    });
    assert.equal(captureCalls, 0);
    assert.equal(harness.permissionHelp.count, 1);
    assert.deepEqual(harness.errors, ['permission-denied']);
  });

  it('binds each frozen source to its sender and lets only the first claimant complete', async () => {
    const harness = createHarness();
    setSessionTarget(harness.controller);

    assert.deepEqual(await harness.controller.start(), { ok: true });
    assert.equal(harness.windows.length, 2);
    assert.deepEqual(
      harness.windows.map(window => [window.options.x, window.options.y]),
      [[-1280, 0], [0, -100]],
    );
    for (const window of harness.windows) {
      assert.equal(window.options.transparent, false);
      assert.equal(window.options.webPreferences?.sandbox, true);
      assert.equal(window.options.webPreferences?.nodeIntegration, false);
      assert.equal(window.options.webPreferences?.contextIsolation, true);
      assert.equal(window.options.webPreferences?.partition, 'gian-screenshot');
      assert.deepEqual(window.alwaysOnTop, [true, 'screen-saver', 1]);
      assert.deepEqual(window.allWorkspaces, [true, { visibleOnFullScreen: true }]);
    }

    const left = harness.controller.getOverlayCapture(100)!;
    const right = harness.controller.getOverlayCapture(101)!;
    assert.equal(left.captureId, 'capture-1');
    assert.equal(right.captureId, 'capture-1');
    assert.equal(harness.controller.getOverlayCapture(999), null);

    harness.controller.setTarget({
      kind: 'new-session',
      scope: { kind: 'task', id: 'task-2' },
      label: 'New target',
    });
    assert.equal(harness.controller.claimFromOverlay(100, left.captureId), true);
    assert.equal(harness.controller.claimFromOverlay(101, right.captureId), false);
    assert.equal(
      await harness.controller.completeFromOverlay(101, right.captureId, PNG_BYTES),
      false,
    );
    assert.equal(
      await harness.controller.completeFromOverlay(100, 'stale-capture', PNG_BYTES),
      false,
    );
    assert.equal(
      await harness.controller.completeFromOverlay(100, left.captureId, PNG_BYTES),
      true,
    );

    assert.equal(harness.captures.length, 1);
    assert.deepEqual(harness.captures[0]?.target, {
      kind: 'session',
      sessionId: 'session-1',
      label: 'Session session-1',
    });
    assert.equal(harness.captures[0]?.filename, 'screenshot-20260812T123456Z.png');
    assert.deepEqual(harness.restores, ['success']);
    assert.deepEqual(harness.clipboardWrites, [PNG_BYTES]);
    assert.ok(harness.windows.every(window => window.hidden && !window.destroyed));
    assert.deepEqual(harness.errors, []);
  });

  it('captures without a conversation target and only writes the final PNG to clipboard', async () => {
    const harness = createHarness();

    assert.deepEqual(await harness.controller.start(), { ok: true });
    const capture = harness.controller.getOverlayCapture(100)!;
    assert.equal(capture.clipboardOnly, true);
    assert.equal(capture.targetLabel, '');
    assert.equal(harness.controller.claimFromOverlay(100, capture.captureId), true);

    assert.equal(
      await harness.controller.completeFromOverlay(100, capture.captureId, PNG_BYTES),
      true,
    );
    assert.deepEqual(harness.clipboardWrites, [PNG_BYTES]);
    assert.deepEqual(harness.captures, []);
    assert.deepEqual(harness.restores, ['clipboard']);
    assert.deepEqual(harness.errors, []);
  });

  it('falls back to clipboard-only if the captured target is invalidated', async () => {
    const harness = createHarness();
    setSessionTarget(harness.controller);
    assert.deepEqual(await harness.controller.start(), { ok: true });
    const capture = harness.controller.getOverlayCapture(100)!;
    assert.equal(harness.controller.claimFromOverlay(100, capture.captureId), true);

    harness.controller.invalidateTarget();
    assert.equal(
      await harness.controller.completeFromOverlay(100, capture.captureId, PNG_BYTES),
      true,
    );

    assert.deepEqual(harness.clipboardWrites, [PNG_BYTES]);
    assert.deepEqual(harness.captures, []);
    assert.deepEqual(harness.restores, ['clipboard']);
    assert.deepEqual(harness.errors, []);
  });

  it('prewarms and reuses one hidden overlay window per display', async () => {
    const harness = createHarness();

    await harness.controller.warmUp();
    assert.equal(harness.windows.length, DISPLAYS.length);
    assert.ok(harness.windows.every(window => window.loadCount === 1));

    setSessionTarget(harness.controller);
    assert.deepEqual(await harness.controller.start(), { ok: true });
    const firstCapture = harness.controller.getOverlayCapture(100)!;
    assert.deepEqual(firstCapture.imagePngBytes, PNG_BYTES);
    assert.equal(harness.controller.claimFromOverlay(100, firstCapture.captureId), true);
    assert.equal(
      await harness.controller.completeFromOverlay(100, firstCapture.captureId, PNG_BYTES),
      true,
    );

    setSessionTarget(harness.controller, 'session-2');
    assert.deepEqual(await harness.controller.start(), { ok: true });
    assert.equal(harness.windows.length, DISPLAYS.length);
    assert.ok(harness.windows.every(window => window.loadCount === 3));
    assert.equal(await harness.controller.cancelFromOverlay(100), true);
    harness.controller.dispose();
    assert.ok(harness.windows.every(window => window.destroyed));
  });

  it('keeps the overlay open when the final PNG cannot reach the system clipboard', async () => {
    const harness = createHarness({ writePngToClipboard: () => false });
    setSessionTarget(harness.controller);
    assert.deepEqual(await harness.controller.start(), { ok: true });
    const capture = harness.controller.getOverlayCapture(100)!;
    assert.equal(harness.controller.claimFromOverlay(100, capture.captureId), true);

    assert.equal(
      await harness.controller.completeFromOverlay(100, capture.captureId, PNG_BYTES),
      false,
    );
    assert.equal(harness.controller.getState().capturing, true);
    assert.deepEqual(harness.captures, []);
    assert.deepEqual(harness.restores, []);
  });

  it('cancels and restores if display topology changes', async () => {
    const harness = createHarness();
    setSessionTarget(harness.controller);
    assert.deepEqual(await harness.controller.start(), { ok: true });

    harness.fireDisplayChange();
    await nextTurn();

    assert.deepEqual(harness.restores, ['cancel']);
    assert.deepEqual(harness.errors, ['capture-failed']);
    assert.equal(harness.controller.getState().capturing, false);
  });

  it('cancels if a bound overlay renderer exits', async () => {
    const harness = createHarness();
    setSessionTarget(harness.controller);
    assert.deepEqual(await harness.controller.start(), { ok: true });

    harness.windows[0]!.webContents.crash();
    await nextTurn();

    assert.deepEqual(harness.restores, ['cancel']);
    assert.deepEqual(harness.errors, ['capture-failed']);
    assert.equal(harness.windows[0]?.destroyed, true);
    assert.equal(harness.windows[1]?.hidden, true);
  });
});
