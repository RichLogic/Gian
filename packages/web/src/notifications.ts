import type { EventEnvelope, Session } from '@gian/shared';
import { stripGianActionBlocks } from '@gian/shared';
import { displayDataForEnvelope, displayTypeForEnvelope } from './transcript/apply.js';
import { desktopBridge } from './desktop-bridge.js';

const PREFS_KEY = 'gian.notificationPrefs.v1';

export interface NotificationPrefs {
  desktop: boolean;
  sessionDone: boolean;
  approvalNeeded: boolean;
  errors: boolean;
  sound: boolean;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  desktop: true,
  sessionDone: true,
  approvalNeeded: true,
  errors: true,
  sound: false,
};

export type BrowserNotificationPermission = NotificationPermission | 'unsupported';

export function visibleSessionForNativeNotification(input: {
  mode: 'sessions' | 'tasks' | 'spaces';
  viewState: 'main' | 'both' | 'workbench';
  activeSessionId: string | null;
  activeSubtaskId: string | null;
}): string | null {
  // `workbench` hides the Session surface entirely; Settings, Terminal,
  // Browser, and other full-sheet views must not suppress a useful alert for
  // the session behind them. In `both`, the Session remains visibly present.
  if (input.viewState === 'workbench') return null;
  if (input.mode === 'sessions') return input.activeSessionId;
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

export function loadNotificationPrefs(): NotificationPrefs {
  const raw = storage()?.getItem(PREFS_KEY);
  if (!raw) return DEFAULT_NOTIFICATION_PREFS;
  try {
    const parsed = JSON.parse(raw) as Partial<NotificationPrefs>;
    return {
      desktop: typeof parsed.desktop === 'boolean' ? parsed.desktop : DEFAULT_NOTIFICATION_PREFS.desktop,
      sessionDone: typeof parsed.sessionDone === 'boolean' ? parsed.sessionDone : DEFAULT_NOTIFICATION_PREFS.sessionDone,
      approvalNeeded: typeof parsed.approvalNeeded === 'boolean' ? parsed.approvalNeeded : DEFAULT_NOTIFICATION_PREFS.approvalNeeded,
      errors: typeof parsed.errors === 'boolean' ? parsed.errors : DEFAULT_NOTIFICATION_PREFS.errors,
      sound: typeof parsed.sound === 'boolean' ? parsed.sound : DEFAULT_NOTIFICATION_PREFS.sound,
    };
  } catch {
    return DEFAULT_NOTIFICATION_PREFS;
  }
}

export function saveNotificationPrefs(prefs: NotificationPrefs): NotificationPrefs {
  storage()?.setItem(PREFS_KEY, JSON.stringify(prefs));
  return prefs;
}

export function nativeNotificationPreferencesForMigration(): NotificationPrefs {
  const preferences = loadNotificationPrefs();
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

function sessionLabel(session: Pick<Session, 'name' | 'executor'> | null | undefined): string {
  if (!session) return 'Session';
  const name = session.name?.trim();
  if (name) return name;
  if (session.executor === 'codex') return 'Codex session';
  if (session.executor === 'kimi') return 'Kimi session';
  if (session.executor === 'grok') return 'Grok session';
  return 'Claude session';
}

function notificationForEnvelope(
  env: EventEnvelope,
  session: Pick<Session, 'name' | 'executor'> | null | undefined,
  prefs: NotificationPrefs,
): { title: string; body: string; tag: string } | null {
  const label = sessionLabel(session);
  const type = displayTypeForEnvelope(env);
  const data = displayDataForEnvelope(env);
  if (type === 'state.turn-completed') {
    if (!prefs.sessionDone) return null;
    const summary = typeof data.summary === 'string' ? stripGianActionBlocks(data.summary).trim() : '';
    return {
      title: `Gian · ${label} completed`,
      body: summary || `Turn ${env.turn} completed.`,
      tag: `gian:${env.session_id}:completed:${env.turn}`,
    };
  }
  if (type === 'interaction.approval' || type === 'interaction.question') {
    if (!prefs.approvalNeeded) return null;
    const title = typeof data.title === 'string' ? data.title : 'Approval needed';
    const subject = typeof data.subject === 'string' ? data.subject : '';
    return {
      title: `Gian · ${title}`,
      body: subject || label,
      tag: `gian:${env.session_id}:approval:${env.call_id}`,
    };
  }
  if (type === 'state.error') {
    if (!prefs.errors) return null;
    const message = typeof data.message === 'string' ? data.message : 'Session error';
    return {
      title: `Gian · ${label} failed`,
      body: message,
      tag: `gian:${env.session_id}:error:${env.call_id}`,
    };
  }
  return null;
}

export function maybeNotifyForEnvelope(
  env: EventEnvelope,
  options: {
    session?: Pick<Session, 'name' | 'executor'> | null;
    onClick?: () => void;
  } = {},
): boolean {
  // Signed desktop builds receive global, privacy-bounded `attention`
  // messages in Electron main. Keeping the renderer path active as well
  // would double-notify the currently subscribed session. Browser/GianDev
  // surfaces retain this fallback.
  if (desktopBridge()?.notifications?.native) return false;
  const prefs = loadNotificationPrefs();
  if (!prefs.desktop || browserNotificationPermission() !== 'granted') return false;

  const payload = notificationForEnvelope(env, options.session, prefs);
  if (!payload) return false;

  try {
    const notification = new Notification(payload.title, {
      body: payload.body,
      tag: payload.tag,
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
