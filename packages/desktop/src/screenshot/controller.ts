import type {
  BrowserWindowConstructorOptions,
  Rectangle,
} from 'electron';
import type {
  GianScreenshotCapture,
  GianScreenshotErrorCode,
  GianScreenshotStartResult,
  GianScreenshotState,
  GianScreenshotTarget,
} from '@gian/shared';

export const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;
export const MAX_CAPTURE_TOTAL_PIXELS = 160_000_000;
export const MAX_CAPTURE_DATA_URL_CHARS = 256 * 1024 * 1024;
export const MAC_SCREENSHOT_SHORTCUT = 'Control+Command+A';
export const OTHER_SCREENSHOT_SHORTCUT = 'Control+Shift+A';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

export type ScreenPermissionStatus =
  | 'not-determined'
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'unknown';

export interface ScreenshotDisplay {
  id: number;
  bounds: Rectangle;
  scaleFactor: number;
}

export interface ScreenshotImage {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  toDataURL(): string;
}

export interface ScreenshotSource {
  display_id: string;
  thumbnail: ScreenshotImage;
}

export interface ScreenshotOverlayWebContents {
  id: number;
  isDestroyed(): boolean;
  once(event: 'render-process-gone', listener: () => void): this;
}

export interface ScreenshotOverlayWindow {
  readonly webContents: ScreenshotOverlayWebContents;
  isDestroyed(): boolean;
  once(event: 'closed', listener: () => void): this;
  loadFile(path: string): Promise<void>;
  show(): void;
  showInactive(): void;
  focus(): void;
  destroy(): void;
  setAlwaysOnTop(
    flag: boolean,
    level?: 'normal' | 'floating' | 'torn-off-menu' | 'modal-panel' | 'main-menu'
      | 'status' | 'pop-up-menu' | 'screen-saver' | 'dock',
    relativeLevel?: number,
  ): void;
  setVisibleOnAllWorkspaces(
    visible: boolean,
    options?: { visibleOnFullScreen?: boolean; skipTransformProcessType?: boolean },
  ): void;
}

export interface ScreenshotOverlayCapture {
  captureId: string;
  imageDataUrl: string;
  targetLabel: string;
}

export interface ScreenshotControllerDependencies {
  platform: NodeJS.Platform;
  overlayHtmlPath: string;
  overlayPreloadPath: string;
  listDisplays(): ScreenshotDisplay[];
  getCursorPoint(): { x: number; y: number };
  captureScreens(thumbnailSize: { width: number; height: number }): Promise<ScreenshotSource[]>;
  createOverlayWindow(options: BrowserWindowConstructorOptions): ScreenshotOverlayWindow;
  getScreenPermissionStatus(): ScreenPermissionStatus;
  showScreenPermissionHelp(): Promise<void>;
  /** Hide Gian and return an opaque token used to restore its exact prior state. */
  prepareMainWindow(): Promise<unknown>;
  restoreMainWindow(token: unknown, outcome: 'cancel' | 'success'): Promise<void>;
  waitForDesktopToSettle(): Promise<void>;
  watchDisplayChanges(listener: () => void): () => void;
  registerGlobalShortcut(accelerator: string, listener: () => void): boolean;
  unregisterGlobalShortcut(accelerator: string): void;
  randomId(): string;
  now(): Date;
  /** Synchronously publish the exact final PNG to the operating system. */
  writePngToClipboard(bytes: Uint8Array): boolean;
  onCaptured(capture: GianScreenshotCapture): Promise<void> | void;
  onError(error: GianScreenshotErrorCode): Promise<void> | void;
}

interface OverlayBinding {
  captureId: string;
  displayId: number;
  imageDataUrl: string;
  window: ScreenshotOverlayWindow;
}

interface ActiveCapture {
  id: string;
  target: GianScreenshotTarget;
  restoreToken?: unknown;
  stopWatchingDisplays?: () => void;
  bindings: Map<number, OverlayBinding>;
  windows: ScreenshotOverlayWindow[];
  ownerSenderId?: number;
  cleaned: boolean;
  finishing: boolean;
  abortCode?: GianScreenshotErrorCode;
}

export function screenshotShortcutForPlatform(platform: NodeJS.Platform): string {
  return platform === 'darwin' ? MAC_SCREENSHOT_SHORTCUT : OTHER_SCREENSHOT_SHORTCUT;
}

function validDisplay(display: ScreenshotDisplay): boolean {
  const { x, y, width, height } = display.bounds;
  return Number.isFinite(display.id)
    && Number.isFinite(x)
    && Number.isFinite(y)
    && Number.isFinite(width)
    && Number.isFinite(height)
    && width > 0
    && height > 0
    && Number.isFinite(display.scaleFactor)
    && display.scaleFactor > 0;
}

/** `desktopCapturer` accepts one thumbnail size for every source. Asking for
 * the largest physical width and height avoids downscaling any display in the
 * ordinary mixed-DPI case. The actual NativeImage size remains authoritative. */
export function thumbnailSizeForDisplays(
  displays: readonly ScreenshotDisplay[],
): { width: number; height: number } {
  if (displays.length === 0 || displays.some(display => !validDisplay(display))) {
    throw new Error('invalid screenshot display topology');
  }
  return displays.reduce(
    (size, display) => ({
      width: Math.max(size.width, Math.ceil(display.bounds.width * display.scaleFactor)),
      height: Math.max(size.height, Math.ceil(display.bounds.height * display.scaleFactor)),
    }),
    { width: 1, height: 1 },
  );
}

/** Match exclusively by the documented display identifier. Source names and
 * `screen:ZZ:0` sequence numbers are not stable display identities. */
export function matchDisplaySources(
  displays: readonly ScreenshotDisplay[],
  sources: readonly ScreenshotSource[],
): Map<number, ScreenshotSource> {
  if (new Set(displays.map(display => display.id)).size !== displays.length) {
    throw new Error('duplicate screenshot display identity');
  }
  if (sources.length !== displays.length) {
    throw new Error('capture source count does not match display topology');
  }
  const displayIds = new Set(displays.map(display => String(display.id)));
  if (sources.some(source => !displayIds.has(source.display_id))) {
    throw new Error('capture source does not match a known display');
  }
  const matched = new Map<number, ScreenshotSource>();
  for (const display of displays) {
    if (!validDisplay(display)) throw new Error('invalid screenshot display topology');
    const candidates = sources.filter(source => source.display_id === String(display.id));
    if (candidates.length !== 1) {
      throw new Error(`expected exactly one capture source for display ${display.id}`);
    }
    const source = candidates[0]!;
    const size = source.thumbnail.getSize();
    if (
      source.thumbnail.isEmpty()
      || !Number.isFinite(size.width)
      || !Number.isFinite(size.height)
      || size.width <= 0
      || size.height <= 0
    ) {
      throw new Error(`empty capture source for display ${display.id}`);
    }
    matched.set(display.id, source);
  }
  return matched;
}

export function displayContainingPoint(
  displays: readonly ScreenshotDisplay[],
  point: { x: number; y: number },
): ScreenshotDisplay | null {
  return displays.find(display => {
    const { x, y, width, height } = display.bounds;
    return point.x >= x && point.x < x + width && point.y >= y && point.y < y + height;
  }) ?? null;
}

/** Convert overlay-local DIP coordinates to pixels in the actual captured
 * NativeImage. macOS does not expose Electron's DIP conversion helpers, and
 * the source thumbnail dimensions are not guaranteed to equal the request. */
export function mapDipRectToImagePixels(
  rect: Rectangle,
  displayBounds: Rectangle,
  imageSize: { width: number; height: number },
): Rectangle {
  if (
    displayBounds.width <= 0
    || displayBounds.height <= 0
    || imageSize.width <= 0
    || imageSize.height <= 0
  ) {
    throw new Error('invalid screenshot geometry');
  }
  const leftDip = Math.min(rect.x, rect.x + rect.width);
  const topDip = Math.min(rect.y, rect.y + rect.height);
  const rightDip = Math.max(rect.x, rect.x + rect.width);
  const bottomDip = Math.max(rect.y, rect.y + rect.height);
  const scaleX = imageSize.width / displayBounds.width;
  const scaleY = imageSize.height / displayBounds.height;
  const left = clamp(Math.floor(leftDip * scaleX), 0, imageSize.width);
  const top = clamp(Math.floor(topDip * scaleY), 0, imageSize.height);
  const right = clamp(Math.ceil(rightDip * scaleX), left, imageSize.width);
  const bottom = clamp(Math.ceil(bottomDip * scaleY), top, imageSize.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function validatedPngBytes(value: unknown): Uint8Array | null {
  let bytes: Uint8Array;
  if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else {
    return null;
  }
  if (bytes.byteLength < PNG_SIGNATURE.length || bytes.byteLength > MAX_SCREENSHOT_BYTES) {
    return null;
  }
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) return null;
  }
  // Own the data after the IPC invocation returns; never retain a view into a
  // renderer-owned backing store.
  return new Uint8Array(bytes);
}

function cloneTarget(target: GianScreenshotTarget): GianScreenshotTarget {
  return target.kind === 'session'
    ? { kind: 'session', sessionId: target.sessionId, label: target.label }
    : {
        kind: 'new-session',
        scope: { kind: target.scope.kind, id: target.scope.id },
        label: target.label,
      };
}

function screenshotFilename(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `screenshot-${stamp}.png`;
}

export class ScreenshotController {
  private readonly shortcut: string;
  private target: GianScreenshotTarget | null = null;
  private active: ActiveCapture | null = null;
  private shortcutRegistered = false;
  private disposed = false;

  constructor(private readonly dependencies: ScreenshotControllerDependencies) {
    this.shortcut = screenshotShortcutForPlatform(dependencies.platform);
  }

  registerShortcut(): boolean {
    if (this.disposed) return false;
    if (this.shortcutRegistered) return true;
    try {
      this.shortcutRegistered = this.dependencies.registerGlobalShortcut(
        this.shortcut,
        () => { void this.start(); },
      );
    } catch {
      this.shortcutRegistered = false;
    }
    if (!this.shortcutRegistered) this.reportError('shortcut-unavailable');
    return this.shortcutRegistered;
  }

  setTarget(target: GianScreenshotTarget | null): void {
    this.target = target ? cloneTarget(target) : null;
  }

  invalidateTarget(): void {
    this.target = null;
    const capture = this.active;
    if (capture && !capture.cleaned && !capture.finishing) {
      void this.abortCapture(capture, 'capture-failed');
    }
  }

  getState(): GianScreenshotState {
    return {
      shortcut: this.shortcut,
      shortcutRegistered: this.shortcutRegistered,
      capturing: this.active !== null,
    };
  }

  async start(): Promise<GianScreenshotStartResult> {
    if (this.disposed) return { ok: false, error: 'capture-failed' };
    if (this.active) {
      this.reportError('busy');
      return { ok: false, error: 'busy' };
    }
    if (!this.target) {
      this.reportError('no-target');
      return { ok: false, error: 'no-target' };
    }

    const permission = this.dependencies.getScreenPermissionStatus();
    if (permission === 'denied' || permission === 'restricted') {
      await this.dependencies.showScreenPermissionHelp();
      this.reportError('permission-denied');
      return { ok: false, error: 'permission-denied' };
    }

    const capture: ActiveCapture = {
      id: this.dependencies.randomId(),
      target: cloneTarget(this.target),
      bindings: new Map(),
      windows: [],
      cleaned: false,
      finishing: false,
    };
    this.active = capture;

    try {
      capture.restoreToken = await this.dependencies.prepareMainWindow();
      if (capture.cleaned) return { ok: false, error: capture.abortCode ?? 'capture-failed' };
      await this.dependencies.waitForDesktopToSettle();
      if (capture.cleaned) return { ok: false, error: capture.abortCode ?? 'capture-failed' };

      const displays = this.dependencies.listDisplays();
      const thumbnailSize = thumbnailSizeForDisplays(displays);
      capture.stopWatchingDisplays = this.dependencies.watchDisplayChanges(() => {
        void this.abortCapture(capture, 'capture-failed');
      });
      const sources = await this.dependencies.captureScreens(thumbnailSize);
      if (capture.cleaned) return { ok: false, error: capture.abortCode ?? 'capture-failed' };
      const sourceByDisplay = matchDisplaySources(displays, sources);

      const totalPixels = sources.reduce((total, source) => {
        const size = source.thumbnail.getSize();
        return total + size.width * size.height;
      }, 0);
      if (!Number.isSafeInteger(totalPixels) || totalPixels > MAX_CAPTURE_TOTAL_PIXELS) {
        throw new Error('captured desktop exceeds pixel budget');
      }

      let totalDataUrlChars = 0;

      for (const display of displays) {
        const source = sourceByDisplay.get(display.id)!;
        const imageDataUrl = source.thumbnail.toDataURL();
        totalDataUrlChars += imageDataUrl.length;
        if (
          !imageDataUrl.startsWith('data:image/png;base64,')
          || totalDataUrlChars > MAX_CAPTURE_DATA_URL_CHARS
        ) {
          throw new Error('captured desktop exceeds encoded image budget');
        }
        const window = this.dependencies.createOverlayWindow({
          x: display.bounds.x,
          y: display.bounds.y,
          width: display.bounds.width,
          height: display.bounds.height,
          show: false,
          frame: false,
          transparent: false,
          backgroundColor: '#000000',
          type: 'panel',
          title: 'Gian Screenshot',
          focusable: true,
          acceptFirstMouse: true,
          enableLargerThanScreen: true,
          resizable: false,
          movable: false,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          closable: false,
          skipTaskbar: true,
          hasShadow: false,
          roundedCorners: false,
          hiddenInMissionControl: true,
          webPreferences: {
            preload: this.dependencies.overlayPreloadPath,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
            spellcheck: false,
            devTools: false,
            backgroundThrottling: false,
            partition: 'gian-screenshot',
          },
        });
        capture.windows.push(window);
        const cancelOnOverlayGone = () => {
          void this.abortCapture(capture, 'capture-failed');
        };
        window.once('closed', cancelOnOverlayGone);
        window.webContents.once('render-process-gone', cancelOnOverlayGone);
        window.setAlwaysOnTop(true, 'screen-saver', 1);
        window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        capture.bindings.set(window.webContents.id, {
          captureId: capture.id,
          displayId: display.id,
          imageDataUrl,
          window,
        });
      }

      await Promise.all(capture.windows.map(window =>
        window.loadFile(this.dependencies.overlayHtmlPath)));
      if (capture.cleaned) return { ok: false, error: capture.abortCode ?? 'capture-failed' };

      for (const window of capture.windows) window.showInactive();
      const cursorDisplay = displayContainingPoint(displays, this.dependencies.getCursorPoint())
        ?? displays[0]!;
      const focused = [...capture.bindings.values()]
        .find(binding => binding.displayId === cursorDisplay.id)?.window;
      focused?.show();
      focused?.focus();
      return { ok: true };
    } catch {
      const currentPermission = this.dependencies.getScreenPermissionStatus();
      const error: GianScreenshotErrorCode =
        this.dependencies.platform === 'darwin' && currentPermission !== 'granted'
          ? 'permission-denied'
          : 'capture-failed';
      await this.cleanupCapture(capture, 'cancel');
      if (error === 'permission-denied') await this.dependencies.showScreenPermissionHelp();
      this.reportError(error);
      return { ok: false, error };
    }
  }

  getOverlayCapture(senderId: number): ScreenshotOverlayCapture | null {
    const capture = this.active;
    if (!capture || capture.cleaned || capture.finishing) return null;
    const binding = capture.bindings.get(senderId);
    if (!binding || binding.captureId !== capture.id) return null;
    return {
      captureId: capture.id,
      imageDataUrl: binding.imageDataUrl,
      targetLabel: capture.target.label,
    };
  }

  claimFromOverlay(senderId: number, captureId: unknown): boolean {
    const capture = this.active;
    if (
      !capture
      || capture.cleaned
      || capture.finishing
      || typeof captureId !== 'string'
      || captureId !== capture.id
    ) {
      return false;
    }
    const binding = capture.bindings.get(senderId);
    if (!binding || binding.captureId !== capture.id) return false;
    if (capture.ownerSenderId === undefined) capture.ownerSenderId = senderId;
    return capture.ownerSenderId === senderId;
  }

  async cancelFromOverlay(senderId: number): Promise<boolean> {
    const capture = this.active;
    if (!capture || capture.cleaned || capture.finishing) return false;
    const binding = capture.bindings.get(senderId);
    if (!binding || binding.captureId !== capture.id) return false;
    capture.finishing = true;
    await this.cleanupCapture(capture, 'cancel');
    return true;
  }

  async completeFromOverlay(
    senderId: number,
    captureId: unknown,
    value: unknown,
  ): Promise<boolean> {
    const capture = this.active;
    if (
      !capture
      || capture.cleaned
      || capture.finishing
      || typeof captureId !== 'string'
      || captureId !== capture.id
    ) return false;
    const binding = capture.bindings.get(senderId);
    if (
      !binding
      || binding.captureId !== capture.id
      || capture.ownerSenderId !== senderId
    ) return false;
    const bytes = validatedPngBytes(value);
    if (!bytes) return false;
    try {
      if (!this.dependencies.writePngToClipboard(bytes)) return false;
    } catch {
      return false;
    }

    capture.finishing = true;
    await this.cleanupCapture(capture, 'success');
    await this.dependencies.onCaptured({
      id: capture.id,
      target: cloneTarget(capture.target),
      filename: screenshotFilename(this.dependencies.now()),
      mime: 'image/png',
      bytes,
    });
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.shortcutRegistered) {
      this.dependencies.unregisterGlobalShortcut(this.shortcut);
      this.shortcutRegistered = false;
    }
    const capture = this.active;
    this.active = null;
    if (!capture) return;
    capture.cleaned = true;
    capture.stopWatchingDisplays?.();
    capture.bindings.clear();
    for (const window of capture.windows) {
      if (!window.isDestroyed()) window.destroy();
    }
    capture.windows.length = 0;
  }

  private async abortCapture(
    capture: ActiveCapture,
    error: GianScreenshotErrorCode,
  ): Promise<void> {
    if (capture.cleaned || capture.finishing) return;
    capture.abortCode = error;
    capture.finishing = true;
    await this.cleanupCapture(capture, 'cancel');
    this.reportError(error);
  }

  private async cleanupCapture(
    capture: ActiveCapture,
    outcome: 'cancel' | 'success',
  ): Promise<void> {
    if (capture.cleaned) return;
    capture.cleaned = true;
    capture.stopWatchingDisplays?.();
    capture.stopWatchingDisplays = undefined;
    capture.bindings.clear();
    for (const window of capture.windows) {
      if (!window.isDestroyed()) window.destroy();
    }
    capture.windows.length = 0;
    try {
      await this.dependencies.restoreMainWindow(capture.restoreToken, outcome);
    } finally {
      if (this.active === capture) this.active = null;
    }
  }

  private reportError(error: GianScreenshotErrorCode): void {
    try {
      void this.dependencies.onError(error);
    } catch {
      // Screenshot error reporting must never destabilize the Desktop shell.
    }
  }
}
