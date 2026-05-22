import type { EventEnvelope, Session } from '@gian/shared';

const PREFS_KEY = 'gian.notificationPrefs.v1';

export interface NotificationPrefs {
  desktop: boolean;
  sessionDone: boolean;
  approvalNeeded: boolean;
  errors: boolean;
  sound: boolean;
  badge: boolean;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  desktop: true,
  sessionDone: true,
  approvalNeeded: true,
  errors: true,
  sound: false,
  badge: true,
};

export type BrowserNotificationPermission = NotificationPermission | 'unsupported';

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
      badge: typeof parsed.badge === 'boolean' ? parsed.badge : DEFAULT_NOTIFICATION_PREFS.badge,
    };
  } catch {
    return DEFAULT_NOTIFICATION_PREFS;
  }
}

export function saveNotificationPrefs(prefs: NotificationPrefs): NotificationPrefs {
  storage()?.setItem(PREFS_KEY, JSON.stringify(prefs));
  return prefs;
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
  return name || (session.executor === 'codex' ? 'Codex session' : 'Claude session');
}

function notificationForEnvelope(
  env: EventEnvelope,
  session: Pick<Session, 'name' | 'executor'> | null | undefined,
  prefs: NotificationPrefs,
): { title: string; body: string; tag: string } | null {
  const label = sessionLabel(session);
  if (env.event === 'turn_completed') {
    if (!prefs.sessionDone) return null;
    const summary = typeof env.data.summary === 'string' ? env.data.summary.trim() : '';
    return {
      title: `Gian · ${label} completed`,
      body: summary || `Turn ${env.turn} completed.`,
      tag: `gian:${env.session_id}:completed:${env.turn}`,
    };
  }
  if (env.event === 'approval_requested') {
    if (!prefs.approvalNeeded) return null;
    const title = typeof env.data.title === 'string' ? env.data.title : 'Approval needed';
    const subject = typeof env.data.subject === 'string' ? env.data.subject : '';
    return {
      title: `Gian · ${title}`,
      body: subject || label,
      tag: `gian:${env.session_id}:approval:${env.call_id}`,
    };
  }
  if (env.event === 'session_error') {
    if (!prefs.errors) return null;
    const message = typeof env.data.message === 'string' ? env.data.message : 'Session error';
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
