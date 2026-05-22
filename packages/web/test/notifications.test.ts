import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventEnvelope } from '@gian/shared';
import {
  DEFAULT_NOTIFICATION_PREFS,
  browserNotificationPermission,
  loadNotificationPrefs,
  maybeNotifyForEnvelope,
  requestDesktopNotificationPermission,
  saveNotificationPrefs,
} from '../src/notifications.js';

class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static requestPermission = vi.fn(async () => FakeNotification.permission);
  static instances: FakeNotification[] = [];

  onclick: ((this: Notification, ev: Event) => unknown) | null = null;
  readonly close = vi.fn();

  constructor(
    readonly title: string,
    readonly options?: NotificationOptions,
  ) {
    FakeNotification.instances.push(this);
  }
}

const originalNotification = globalThis.Notification;

function installNotification(permission: NotificationPermission) {
  FakeNotification.permission = permission;
  FakeNotification.instances = [];
  FakeNotification.requestPermission = vi.fn(async () => FakeNotification.permission);
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    writable: true,
    value: FakeNotification,
  });
}

function envelope(
  event: 'turn_completed' | 'approval_requested' | 'session_error',
  data: Record<string, unknown>,
): EventEnvelope {
  return {
    session_id: 'sess-1',
    turn: 3,
    call_id: `${event}-1`,
    event,
    ts: Date.now(),
    data,
  };
}

describe('browser notifications', () => {
  beforeEach(() => {
    localStorage.clear();
    installNotification('granted');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    Object.defineProperty(globalThis, 'Notification', {
      configurable: true,
      writable: true,
      value: originalNotification,
    });
  });

  it('loads default notification preferences when storage is empty', () => {
    expect(loadNotificationPrefs()).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });

  it('requests browser notification permission from a user gesture path', async () => {
    installNotification('default');
    FakeNotification.requestPermission = vi.fn(async () => 'granted');

    await expect(requestDesktopNotificationPermission()).resolves.toBe('granted');
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
  });

  it('sends a desktop notification for session completion when permission is granted', () => {
    const sent = maybeNotifyForEnvelope(
      envelope('turn_completed', { summary: 'Implemented the parser.' }),
      { session: { name: 'Parser fix', executor: 'codex' } },
    );

    expect(sent).toBe(true);
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]!.title).toBe('Gian · Parser fix completed');
    expect(FakeNotification.instances[0]!.options?.body).toBe('Implemented the parser.');
  });

  it('does not notify when browser permission has not been granted', () => {
    installNotification('default');

    const sent = maybeNotifyForEnvelope(envelope('turn_completed', {}));

    expect(sent).toBe(false);
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('honors per-event preferences', () => {
    saveNotificationPrefs({ ...DEFAULT_NOTIFICATION_PREFS, sessionDone: false });

    const sent = maybeNotifyForEnvelope(envelope('turn_completed', { summary: 'done' }));

    expect(sent).toBe(false);
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('reports unsupported when Notification is absent', () => {
    Reflect.deleteProperty(globalThis, 'Notification');

    expect(browserNotificationPermission()).toBe('unsupported');
    expect(maybeNotifyForEnvelope(envelope('session_error', { message: 'boom' }))).toBe(false);
  });
});
