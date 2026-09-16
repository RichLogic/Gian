import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttentionMessage } from '@gian/shared';
import {
  DEFAULT_DEVICE_NOTIFICATION_PREFS,
  browserNotificationPermission,
  loadDeviceNotificationPrefs,
  maybeNotifyForAttention,
  nativeNotificationPreferencesForMigration,
  requestDesktopNotificationPermission,
  saveDeviceNotificationPrefs,
  visibleSessionForNativeNotification,
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

function attention(overrides: Partial<AttentionMessage> = {}): AttentionMessage {
  return {
    type: 'attention',
    id: 'gian:attention:abc123',
    session_id: 'sess-1',
    turn: 3,
    kind: 'turn-completed',
    timestamp: Date.now(),
    title: 'Turn completed',
    body: 'The agent finished turn 3.',
    provider: 'codex',
    ...overrides,
  };
}

function focusWindow(focused: boolean) {
  vi.spyOn(document, 'hasFocus').mockReturnValue(focused);
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: focused ? 'visible' : 'hidden',
  });
}

describe('device notification preferences', () => {
  beforeEach(() => {
    localStorage.clear();
    delete window.gianDesktop;
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

  it('loads device-level defaults when storage is empty', () => {
    expect(loadDeviceNotificationPrefs()).toEqual(DEFAULT_DEVICE_NOTIFICATION_PREFS);
  });

  it('migrates only consent and sound from the v1 five-key format', () => {
    localStorage.setItem('gian.notificationPrefs.v1', JSON.stringify({
      desktop: true,
      sessionDone: false,
      approvalNeeded: false,
      errors: false,
      sound: true,
    }));

    expect(loadDeviceNotificationPrefs()).toEqual({ desktop: true, sound: true });
    // The retired kind switches must not survive into v2 storage.
    expect(JSON.parse(localStorage.getItem('gian.notificationPrefs.v2')!)).toEqual({
      desktop: true,
      sound: true,
    });
  });

  it('prefers v2 storage over v1 once both exist', () => {
    localStorage.setItem('gian.notificationPrefs.v1', JSON.stringify({ desktop: true, sound: true }));
    saveDeviceNotificationPrefs({ desktop: false, sound: false });
    expect(loadDeviceNotificationPrefs()).toEqual({ desktop: false, sound: false });
  });

  it('requests browser notification permission from a user gesture path', async () => {
    installNotification('default');
    FakeNotification.requestPermission = vi.fn(async () => 'granted');

    await expect(requestDesktopNotificationPermission()).resolves.toBe('granted');
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
  });

  it('migrates native delivery only from previously granted consent', () => {
    saveDeviceNotificationPrefs({ desktop: true, sound: true });
    expect(nativeNotificationPreferencesForMigration()).toEqual({
      desktop: true,
      sound: true,
    });
    installNotification('default');
    expect(nativeNotificationPreferencesForMigration().desktop).toBe(false);
  });
});

describe('maybeNotifyForAttention', () => {
  beforeEach(() => {
    localStorage.clear();
    delete window.gianDesktop;
    installNotification('granted');
    focusWindow(false);
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

  it('delivers the Host text verbatim with the attention id as the tag', () => {
    const message = attention();
    const sent = maybeNotifyForAttention(message, { visibleSessionId: null });

    expect(sent).toBe(true);
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]!.title).toBe('Turn completed');
    expect(FakeNotification.instances[0]!.options?.body).toBe('The agent finished turn 3.');
    expect(FakeNotification.instances[0]!.options?.tag).toBe('gian:attention:abc123');
    expect(FakeNotification.instances[0]!.options?.silent).toBe(true);
  });

  it('honors the device sound preference', () => {
    saveDeviceNotificationPrefs({ desktop: true, sound: true });
    maybeNotifyForAttention(attention(), { visibleSessionId: null });
    expect(FakeNotification.instances[0]!.options?.silent).toBe(false);
  });

  it('does not notify when device consent is off', () => {
    saveDeviceNotificationPrefs({ desktop: false, sound: false });

    expect(maybeNotifyForAttention(attention(), { visibleSessionId: null })).toBe(false);
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('does not notify when browser permission has not been granted', () => {
    installNotification('default');

    expect(maybeNotifyForAttention(attention(), { visibleSessionId: null })).toBe(false);
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('suppresses the session already visible in a focused window only', () => {
    focusWindow(true);

    expect(maybeNotifyForAttention(attention(), { visibleSessionId: 'sess-1' })).toBe(false);
    expect(maybeNotifyForAttention(attention({ id: 'other' }), { visibleSessionId: 'sess-2' }))
      .toBe(true);
    expect(FakeNotification.instances).toHaveLength(1);
  });

  it('notifies a visible session while the window is unfocused', () => {
    focusWindow(false);

    expect(maybeNotifyForAttention(attention(), { visibleSessionId: 'sess-1' })).toBe(true);
  });

  it('leaves signed desktop delivery to Electron main to avoid duplicates', () => {
    window.gianDesktop = {
      notifications: {
        native: true,
      } as NonNullable<typeof window.gianDesktop>['notifications'],
    };

    expect(maybeNotifyForAttention(attention(), { visibleSessionId: null })).toBe(false);
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('reports unsupported when Notification is absent', () => {
    Reflect.deleteProperty(globalThis, 'Notification');

    expect(browserNotificationPermission()).toBe('unsupported');
    expect(maybeNotifyForAttention(attention(), { visibleSessionId: null })).toBe(false);
  });

  it('clicking focuses the window, navigates, and closes the notification', () => {
    const onClick = vi.fn();
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    maybeNotifyForAttention(attention(), { visibleSessionId: null, onClick });

    FakeNotification.instances[0]!.onclick?.call(
      FakeNotification.instances[0]! as unknown as Notification,
      new Event('click'),
    );
    expect(focus).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(FakeNotification.instances[0]!.close).toHaveBeenCalledTimes(1);
  });
});

describe('native notification visibility context', () => {
  it('reports a Session only while its conversation surface is actually visible', () => {
    expect(visibleSessionForNativeNotification({
      mode: 'sessions',
      viewState: 'main',
      activeSessionId: 'sess-1',
      activeSubtaskId: null,
    })).toBe('sess-1');
    expect(visibleSessionForNativeNotification({
      mode: 'sessions',
      viewState: 'both',
      activeSessionId: 'sess-1',
      activeSubtaskId: null,
    })).toBe('sess-1');
    expect(visibleSessionForNativeNotification({
      mode: 'sessions',
      viewState: 'workbench',
      activeSessionId: 'sess-1',
      activeSubtaskId: null,
    })).toBeNull();
  });

  it('reports only the active Tasks subtask, never Spaces', () => {
    expect(visibleSessionForNativeNotification({
      mode: 'tasks',
      viewState: 'main',
      activeSessionId: 'sub-1',
      activeSubtaskId: 'sub-1',
    })).toBe('sub-1');
    expect(visibleSessionForNativeNotification({
      mode: 'tasks',
      viewState: 'main',
      activeSessionId: 'sub-1',
      activeSubtaskId: 'sub-2',
    })).toBeNull();
    expect(visibleSessionForNativeNotification({
      mode: 'spaces',
      viewState: 'main',
      activeSessionId: 'sess-1',
      activeSubtaskId: null,
    })).toBeNull();
  });
});
