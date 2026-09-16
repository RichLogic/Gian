import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemConfig } from '@gian/shared';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  DEFAULT_TERMINAL_PREFERENCES,
} from '@gian/shared';
import { SettingsBody } from '../src/components/SettingsBody.js';
import type {
  GianDesktopNotificationPreferences,
  GianDesktopNotificationsApi,
  GianDesktopNotificationState,
} from '../src/desktop-bridge.js';
import { loadDeviceNotificationPrefs } from '../src/notifications.js';
import { renderWithOperations } from './operation-test-utils.js';
import * as api from '../src/api.js';

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    saveSettings: vi.fn().mockImplementation(async partial => ({ ...config(), ...partial })),
  };
});

class FakeNotification {
  static permission: NotificationPermission = 'default';
  static requestPermission = vi.fn(async () => FakeNotification.permission);
}

const originalNotification = globalThis.Notification;

function config(overrides: Partial<SystemConfig> = {}): SystemConfig {
  return {
    host: '127.0.0.1', port: 8991, workspace_root: '~/Coding',
    theme: 'warm', accent: 'ember', density: 'cozy', locale: 'en',
    font_scale_chrome: 'md', font_scale_chat: 'md', font_scale_code: 'md',
    chat_font_size: 14, chat_font_family: 'system',
    terminal: { ...DEFAULT_TERMINAL_PREFERENCES },
    default_claude_model: '', default_claude_effort: '',
    default_codex_model: '', default_codex_effort: '',
    auth_username: '', external_editors: [],
    notifications: { ...DEFAULT_NOTIFICATION_PREFERENCES },
    ...overrides,
  };
}

function installNotification(permission: NotificationPermission) {
  FakeNotification.permission = permission;
  FakeNotification.requestPermission = vi.fn(async () => FakeNotification.permission);
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    writable: true,
    value: FakeNotification,
  });
}

function installNativeNotifications(
  initialPreferences: GianDesktopNotificationPreferences,
) {
  let current: GianDesktopNotificationState = {
    supported: true,
    preferences: initialPreferences,
    lastError: null,
  };
  let listener: ((state: GianDesktopNotificationState) => void) | null = null;
  const notifications: GianDesktopNotificationsApi = {
    native: true,
    getState: vi.fn(async () => current),
    updatePreferences: vi.fn(async preferences => {
      current = { ...current, preferences };
      listener?.(current);
      return current;
    }),
    setContext: vi.fn(async () => true),
    openSystemSettings: vi.fn(async () => true),
    onStateChanged: vi.fn(next => {
      listener = next;
      return () => { listener = null; };
    }),
  };
  window.gianDesktop = { notifications };
  return notifications;
}

describe('SettingsBody Notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    delete window.gianDesktop;
    installNotification('default');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    delete window.gianDesktop;
    Object.defineProperty(globalThis, 'Notification', {
      configurable: true,
      writable: true,
      value: originalNotification,
    });
  });

  it('patches the user-level master switch and performs the device consent flow', async () => {
    const notifications = installNativeNotifications({ desktop: false, sound: false });
    FakeNotification.requestPermission = vi.fn(async () => 'granted');
    renderWithOperations(<SettingsBody
      config={config({ notifications: { ...DEFAULT_NOTIFICATION_PREFERENCES, enabled: false } })}
      activeSection="notifications"
    />);

    fireEvent.click(await screen.findByRole('checkbox', { name: 'System notifications' }));

    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({
      notifications: { ...DEFAULT_NOTIFICATION_PREFERENCES, enabled: true },
    }));
    await waitFor(() => expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(notifications.updatePreferences).toHaveBeenCalledWith({
      desktop: true,
      sound: false,
    }));
    expect(loadDeviceNotificationPrefs().desktop).toBe(true);
  });

  it('keeps the master switch on when the OS permission is denied and offers macOS Settings', async () => {
    const notifications = installNativeNotifications({ desktop: false, sound: false });
    installNotification('denied');
    renderWithOperations(<SettingsBody
      config={config({ notifications: { ...DEFAULT_NOTIFICATION_PREFERENCES, enabled: false } })}
      activeSection="notifications"
    />);

    fireEvent.click(await screen.findByRole('checkbox', { name: 'System notifications' }));

    // Denied consent must not silently revert the user-level switch…
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({
      notifications: { ...DEFAULT_NOTIFICATION_PREFERENCES, enabled: true },
    }));
    // …and must not grant device-level consent.
    expect(notifications.updatePreferences).not.toHaveBeenCalledWith({
      desktop: true,
      sound: false,
    });
    expect(await screen.findByText('Blocked by macOS')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open macOS Settings' }));
    expect(notifications.openSystemSettings).toHaveBeenCalledTimes(1);
  });

  it('patches a kind switch through the Host settings section', async () => {
    installNotification('granted');
    installNativeNotifications({ desktop: true, sound: false });
    renderWithOperations(<SettingsBody config={config()} activeSection="notifications" />);

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Completed turns' }));

    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({
      notifications: { ...DEFAULT_NOTIFICATION_PREFERENCES, session_done: false },
    }));
  });

  it('disables the kind switches while the master switch is off', async () => {
    installNotification('granted');
    installNativeNotifications({ desktop: true, sound: false });
    renderWithOperations(<SettingsBody
      config={config({ notifications: { ...DEFAULT_NOTIFICATION_PREFERENCES, enabled: false } })}
      activeSection="notifications"
    />);

    expect(await screen.findByRole('checkbox', { name: 'Completed turns' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Approvals and questions' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Agent errors' })).toBeDisabled();
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  it('keeps sound device-level through the native service', async () => {
    installNotification('granted');
    const notifications = installNativeNotifications({ desktop: true, sound: false });
    renderWithOperations(<SettingsBody config={config()} activeSection="notifications" />);

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Sound' }));

    await waitFor(() => expect(notifications.updatePreferences).toHaveBeenCalledWith({
      desktop: true,
      sound: true,
    }));
    // Sound never enters the user-level Host settings patch.
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  it('stores sound in v2 localStorage on the browser fallback', async () => {
    installNotification('granted');
    renderWithOperations(<SettingsBody config={config()} activeSection="notifications" />);

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Sound' }));

    await waitFor(() => expect(loadDeviceNotificationPrefs().sound).toBe(true));
    expect(JSON.parse(localStorage.getItem('gian.notificationPrefs.v2')!)).toEqual({
      desktop: true,
      sound: true,
    });
  });
});
