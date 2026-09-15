import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemConfig } from '@gian/shared';
import { DEFAULT_TERMINAL_PREFERENCES } from '@gian/shared';
import { SettingsBody } from '../src/components/SettingsBody.js';
import type {
  GianDesktopNotificationPreferences,
  GianDesktopNotificationsApi,
  GianDesktopNotificationState,
} from '../src/desktop-bridge.js';
import { loadNotificationPrefs } from '../src/notifications.js';
import { renderWithOperations } from './operation-test-utils.js';

class FakeNotification {
  static permission: NotificationPermission = 'default';
  static requestPermission = vi.fn(async () => FakeNotification.permission);
}

const originalNotification = globalThis.Notification;

function config(): SystemConfig {
  return {
    host: '127.0.0.1', port: 8991, workspace_root: '~/Coding',
    theme: 'warm', accent: 'ember', density: 'cozy', locale: 'en',
    font_scale_chrome: 'md', font_scale_chat: 'md', font_scale_code: 'md',
    chat_font_size: 14, chat_font_family: 'system',
    terminal: { ...DEFAULT_TERMINAL_PREFERENCES },
    default_claude_model: '', default_claude_effort: '',
    default_codex_model: '', default_codex_effort: '',
    auth_username: '', external_editors: [],
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

const disabledPreferences: GianDesktopNotificationPreferences = {
  desktop: false,
  sessionDone: true,
  approvalNeeded: true,
  errors: true,
  sound: false,
};

describe('SettingsBody Notifications', () => {
  beforeEach(() => {
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

  it('requests permission from the notification toggle and persists granted consent', async () => {
    const notifications = installNativeNotifications(disabledPreferences);
    FakeNotification.requestPermission = vi.fn(async () => 'granted');
    renderWithOperations(<SettingsBody config={config()} activeSection="notifications" />);

    fireEvent.click(await screen.findByRole('checkbox', { name: 'System notifications' }));

    await waitFor(() => expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(notifications.updatePreferences).toHaveBeenCalledWith({
      ...disabledPreferences,
      desktop: true,
    }));
    expect(loadNotificationPrefs().desktop).toBe(true);
    expect(screen.getByText('Enabled')).toBeInTheDocument();
  });

  it('keeps denied consent off and opens macOS notification settings', async () => {
    const notifications = installNativeNotifications(disabledPreferences);
    installNotification('denied');
    renderWithOperations(<SettingsBody config={config()} activeSection="notifications" />);

    fireEvent.click(await screen.findByRole('checkbox', { name: 'System notifications' }));

    await waitFor(() => expect(notifications.updatePreferences).toHaveBeenCalledWith({
      ...disabledPreferences,
      desktop: false,
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Open macOS Settings' }));
    expect(notifications.openSystemSettings).toHaveBeenCalledTimes(1);
  });

  it('persists event and sound preferences through the native service', async () => {
    installNotification('granted');
    const enabled = { ...disabledPreferences, desktop: true };
    const notifications = installNativeNotifications(enabled);
    renderWithOperations(<SettingsBody config={config()} activeSection="notifications" />);

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Completed turns' }));

    await waitFor(() => expect(notifications.updatePreferences).toHaveBeenCalledWith({
      ...enabled,
      sessionDone: false,
    }));
    expect(loadNotificationPrefs().sessionDone).toBe(false);
  });

  it('persists an explicit disable so startup migration cannot re-enable it', async () => {
    installNotification('granted');
    const enabled = { ...disabledPreferences, desktop: true };
    const notifications = installNativeNotifications(enabled);
    renderWithOperations(<SettingsBody config={config()} activeSection="notifications" />);

    fireEvent.click(await screen.findByRole('checkbox', { name: 'System notifications' }));

    await waitFor(() => expect(notifications.updatePreferences).toHaveBeenCalledWith({
      ...enabled,
      desktop: false,
    }));
    expect(loadNotificationPrefs().desktop).toBe(false);
  });
});
