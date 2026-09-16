import type { AttentionMessage } from '@gian/shared';
import { desktopBridge } from './desktop-bridge.js';

// v2 stores device-level fields only. The user-level master/kind switches
// moved into the Host config (`notifications` settings section), where the
// Host gates the attention signal before broadcasting — keeping them in
// localStorage would drift between devices.
const PREFS_KEY_V2 = 'gian.notificationPrefs.v2';
const PREFS_KEY_V1 = 'gian.notificationPrefs.v1';

export interface DeviceNotificationPrefs {
  desktop: boolean;
  sound: boolean;
}

export const DEFAULT_DEVICE_NOTIFICATION_PREFS: DeviceNotificationPrefs = {
  desktop: true,
  sound: false,
};

export type BrowserNotificationPermission = NotificationPermission | 'unsupported';

export function visibleSessionForNativeNotification(input: {
  mode: 'sessions' | 'tasks' | 'spaces' | 'agents' | 'timer' | 'custom';
  viewState: 'main' | 'both' | 'workbench';
  activeSessionId: string | null;
  activeSubtaskId: string | null;
}): string | null {
  // `workbench` hides the Session surface entirely; Settings, Terminal,
  // Browser, and other full-sheet views must not suppress a useful alert for
  // the session behind them. In `both`, the Session remains visibly present.
  if (input.viewState === 'workbench') return null;
  if (input.mode === 'sessions') return input.activeSessionId;
  // Timer shows no conversation surface — the schedule detail is not the
  // control Session, so a notification for it must not be suppressed.
  if (
    input.mode === 'tasks'
    && input.activeSubtaskId
    && input.activeSubtaskId === input.activeSessionId
  ) {
    return input.activeSessionId;
  }
  return null;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function browserNotificationPermission(): BrowserNotificationPermission {
  if (!('Notification' in globalThis)) return 'unsupported';
  return Notification.permission;
}

export function loadDeviceNotificationPrefs(): DeviceNotificationPrefs {
  const store = storage();
  const rawV2 = store?.getItem(PREFS_KEY_V2);
  if (rawV2) {
    try {
      const parsed = JSON.parse(rawV2) as Partial<DeviceNotificationPrefs>;
      return {
        desktop: typeof parsed.desktop === 'boolean'
          ? parsed.desktop
          : DEFAULT_DEVICE_NOTIFICATION_PREFS.desktop,
        sound: typeof parsed.sound === 'boolean'
          ? parsed.sound
          : DEFAULT_DEVICE_NOTIFICATION_PREFS.sound,
      };
    } catch {
      return { ...DEFAULT_DEVICE_NOTIFICATION_PREFS };
    }
  }
  // One-way v1 → v2 migration: only the device-level fields come forward;
  // the retired kind switches are dropped (Host config owns them now).
  const rawV1 = store?.getItem(PREFS_KEY_V1);
  if (rawV1) {
    try {
      const parsed = JSON.parse(rawV1) as Partial<Record<string, unknown>>;
      const migrated: DeviceNotificationPrefs = {
        desktop: typeof parsed.desktop === 'boolean'
          ? parsed.desktop
          : DEFAULT_DEVICE_NOTIFICATION_PREFS.desktop,
        sound: typeof parsed.sound === 'boolean'
          ? parsed.sound
          : DEFAULT_DEVICE_NOTIFICATION_PREFS.sound,
      };
      saveDeviceNotificationPrefs(migrated);
      return migrated;
    } catch {
      return { ...DEFAULT_DEVICE_NOTIFICATION_PREFS };
    }
  }
  return { ...DEFAULT_DEVICE_NOTIFICATION_PREFS };
}

export function saveDeviceNotificationPrefs(prefs: DeviceNotificationPrefs): DeviceNotificationPrefs {
  storage()?.setItem(PREFS_KEY_V2, JSON.stringify(prefs));
  return prefs;
}

export function nativeNotificationPreferencesForMigration(): DeviceNotificationPrefs {
  const preferences = loadDeviceNotificationPrefs();
  return {
    ...preferences,
    // Carry forward only consent already granted through the renderer. A
    // fresh signed install still requires an explicit user gesture.
    desktop: preferences.desktop && browserNotificationPermission() === 'granted',
  };
}

export async function requestDesktopNotificationPermission(): Promise<BrowserNotificationPermission> {
  if (!('Notification' in globalThis)) return 'unsupported';
  if (Notification.permission === 'granted' || Notification.permission === 'denied') {
    return Notification.permission;
  }
  return Notification.requestPermission();
}

/**
 * Renderer fallback delivery (Browser / GianDev): presents the Host's
 * `attention` message as-is — the title/body/privacy level and the stable
 * dedupe id are exactly what the native path delivers. Suppression mirrors
 * the native rule: a focused window already showing this Session stays
 * quiet.
 */
export function maybeNotifyForAttention(
  message: AttentionMessage,
  options: {
    visibleSessionId: string | null;
    onClick?: () => void;
  },
): boolean {
  // Signed desktop builds receive global, privacy-bounded `attention`
  // messages in Electron main. Keeping the renderer path active as well
  // would double-notify. Browser/GianDev surfaces retain this fallback.
  if (desktopBridge()?.notifications?.native) return false;
  const prefs = loadDeviceNotificationPrefs();
  if (!prefs.desktop || browserNotificationPermission() !== 'granted') return false;
  if (
    document.hasFocus()
    && document.visibilityState === 'visible'
    && options.visibleSessionId === message.session_id
  ) {
    return false;
  }

  try {
    const notification = new Notification(message.title, {
      body: message.body,
      // The Host id is stable across replay, so the OS itself de-duplicates
      // a re-broadcast of the same display event.
      tag: message.id,
      silent: !prefs.sound,
    });
    notification.onclick = () => {
      try {
        window.focus();
      } catch {
        // Browser focus can be denied; the notification itself still worked.
      }
      options.onClick?.();
      notification.close();
    };
    return true;
  } catch {
    return false;
  }
}
