import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export interface ScreenshotPreferences {
  hideMainWindowDuringCapture: boolean;
  /** User-remapped global capture shortcut (Electron accelerator). Null =
   *  the platform default from `screenshotShortcutForPlatform`. */
  shortcut: string | null;
}

export const DEFAULT_SCREENSHOT_PREFERENCES: ScreenshotPreferences = {
  // The frozen desktop should include the Gian window by default so the
  // capture can cover Gian's own surface; users can opt into the classic
  // WeChat-style hide via Settings.
  hideMainWindowDuringCapture: false,
  shortcut: null,
};

/** Conservative accelerator allow-list: 1+ modifiers then a key, Electron
 *  names only. Anything else falls back to the platform default rather than
 *  risking a globalShortcut.register throw. */
const ACCELERATOR_RE =
  /^(?:(?:Command|Cmd|Control|Ctrl|CommandOrControl|CmdOrCtrl|Alt|Option|Shift|Super)\+)+(?:[A-Za-z0-9]|[Ff](?:[1-9]|1[0-9]|2[0-4])|Enter|Return|Escape|Esc|Tab|Space|Backspace|Delete|Up|Down|Left|Right|Home|End|PageUp|PageDown|Insert|Plus|Minus|Comma|Period)$/;

export function isValidScreenshotShortcut(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false;
  const parts = value.split('+');
  if (parts.length < 2) return false;
  const modifiers = parts.slice(0, -1);
  if (new Set(modifiers.map(m => m.toLowerCase())).size !== modifiers.length) return false;
  return ACCELERATOR_RE.test(value);
}

export interface ScreenshotPreferenceStore {
  load(): ScreenshotPreferences;
  save(preferences: ScreenshotPreferences): void;
}

export function sanitizeScreenshotPreferences(
  value: unknown,
  fallback: ScreenshotPreferences = DEFAULT_SCREENSHOT_PREFERENCES,
): ScreenshotPreferences {
  const candidate = value && typeof value === 'object'
    ? value as Partial<ScreenshotPreferences>
    : {};
  return {
    hideMainWindowDuringCapture: typeof candidate.hideMainWindowDuringCapture === 'boolean'
      ? candidate.hideMainWindowDuringCapture
      : fallback.hideMainWindowDuringCapture,
    // Explicit null resets to the platform default; a valid string remaps;
    // anything else (absent/garbage) keeps the fallback.
    shortcut: candidate.shortcut === null
      ? null
      : isValidScreenshotShortcut(candidate.shortcut)
        ? candidate.shortcut
        : fallback.shortcut,
  };
}

export class FileScreenshotPreferenceStore implements ScreenshotPreferenceStore {
  constructor(private readonly path: string) {}

  load(): ScreenshotPreferences {
    try {
      return sanitizeScreenshotPreferences(
        JSON.parse(readFileSync(this.path, 'utf8')),
      );
    } catch {
      return { ...DEFAULT_SCREENSHOT_PREFERENCES };
    }
  }

  save(preferences: ScreenshotPreferences): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(preferences, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      renameSync(temporaryPath, this.path);
    } catch (error) {
      try { unlinkSync(temporaryPath); } catch {}
      throw error;
    }
  }
}
