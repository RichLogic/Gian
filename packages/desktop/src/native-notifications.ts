import type { AttentionKind, AttentionMessage } from '@gian/shared';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export interface DesktopNotificationPreferences {
  desktop: boolean;
  sessionDone: boolean;
  approvalNeeded: boolean;
  errors: boolean;
  sound: boolean;
}

export interface DesktopNotificationContext {
  windowFocused: boolean;
  visibleSessionId: string | null;
}

export interface DesktopNotificationTarget {
  type: 'session';
  sessionId: string;
  turn: number;
  kind: AttentionKind;
}

export interface DesktopNotificationState {
  supported: boolean;
  preferences: DesktopNotificationPreferences;
  lastError: 'delivery_failed' | null;
}

export const DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES: DesktopNotificationPreferences = {
  // Native delivery must begin with an explicit renderer-side permission
  // gesture. Existing Browser Notification users are migrated only when that
  // permission is already granted.
  desktop: false,
  sessionDone: true,
  approvalNeeded: true,
  errors: true,
  sound: false,
};

export interface DesktopNotificationPreferenceStore {
  load(): DesktopNotificationPreferences;
  save(preferences: DesktopNotificationPreferences): void;
}

export interface NativeNotificationPayload {
  title: string;
  body: string;
  silent: boolean;
}

export interface NativeNotificationHandle {
  close?(): void;
}

export interface NativeNotificationDelivery {
  show(
    payload: NativeNotificationPayload,
    callbacks: {
      onClick: () => void;
      onClose: () => void;
      onFailed: () => void;
    },
  ): NativeNotificationHandle;
}

export interface NativeNotificationServiceOptions {
  supported: boolean;
  store: DesktopNotificationPreferenceStore;
  delivery: NativeNotificationDelivery;
  onActivate: (target: DesktopNotificationTarget) => void;
  maxRememberedIds?: number;
  maxActiveNotifications?: number;
}

/** Electron-free core so privacy, suppression, preference, and dedupe rules
 * can be tested without launching a GUI process. */
export class NativeNotificationService {
  private readonly options: NativeNotificationServiceOptions;
  private readonly maxRememberedIds: number;
  private readonly maxActiveNotifications: number;
  private preferences: DesktopNotificationPreferences;
  private context: DesktopNotificationContext = {
    windowFocused: false,
    visibleSessionId: null,
  };
  private hasRendererContext = false;
  private lastError: DesktopNotificationState['lastError'] = null;
  private rememberedIds = new Set<string>();
  private pendingAttention = new Map<string, AttentionMessage>();
  private listeners = new Set<(state: DesktopNotificationState) => void>();
  private active = new Map<string, NativeNotificationHandle>();

  constructor(options: NativeNotificationServiceOptions) {
    this.options = options;
    this.maxRememberedIds = Math.max(32, options.maxRememberedIds ?? 512);
    this.maxActiveNotifications = Math.max(1, options.maxActiveNotifications ?? 64);
    this.preferences = sanitizeDesktopNotificationPreferences(options.store.load());
  }

  getState(): DesktopNotificationState {
    return {
      supported: this.options.supported,
      preferences: { ...this.preferences },
      lastError: this.lastError,
    };
  }

  updatePreferences(value: unknown): DesktopNotificationState {
    this.preferences = sanitizeDesktopNotificationPreferences(value, this.preferences);
    this.options.store.save(this.preferences);
    this.emit();
    return this.getState();
  }

  resetContext(): void {
    this.hasRendererContext = false;
  }

  setContext(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const candidate = value as Partial<DesktopNotificationContext>;
    if (typeof candidate.windowFocused !== 'boolean') return;
    if (candidate.visibleSessionId !== null && typeof candidate.visibleSessionId !== 'string') return;
    this.context = {
      windowFocused: candidate.windowFocused,
      visibleSessionId: candidate.visibleSessionId?.slice(0, 512) ?? null,
    };
    this.hasRendererContext = true;
    this.flushPendingAttention();
  }

  subscribe(listener: (state: DesktopNotificationState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  handleAttention(message: AttentionMessage): boolean {
    if (this.rememberedIds.has(message.id)) return false;
    if (!this.options.supported || !this.preferences.desktop) return false;
    if (!this.kindEnabled(message.kind)) return false;
    // A newly created renderer has not supplied visibility context yet. Keep
    // the low-frequency signal bounded until it does, so an active Session is
    // never notified merely because IPC initialization lost a race.
    if (!this.hasRendererContext) {
      this.pendingAttention.set(message.id, message);
      while (this.pendingAttention.size > this.maxRememberedIds) {
        const oldest = this.pendingAttention.keys().next().value as string | undefined;
        if (!oldest) break;
        this.pendingAttention.delete(oldest);
      }
      return false;
    }
    return this.deliverAttention(message);
  }

  private deliverAttention(message: AttentionMessage): boolean {
    if (this.rememberedIds.has(message.id)) return false;
    this.remember(message.id);
    if (
      this.context.windowFocused
      && this.context.visibleSessionId === message.session_id
    ) {
      return false;
    }

    const target: DesktopNotificationTarget = {
      type: 'session',
      sessionId: message.session_id,
      turn: message.turn,
      kind: message.kind,
    };
    try {
      const handle = this.options.delivery.show({
        title: message.title,
        body: message.body,
        silent: !this.preferences.sound,
      }, {
        onClick: () => {
          // Some Electron/macOS versions do not emit `close` after `click`.
          // Release our strong handle here as well so delivered notifications
          // cannot accumulate for the lifetime of the App.
          this.active.delete(message.id);
          this.options.onActivate(target);
        },
        onClose: () => { this.active.delete(message.id); },
        onFailed: () => {
          this.active.delete(message.id);
          this.lastError = 'delivery_failed';
          this.emit();
        },
      });
      this.active.set(message.id, handle);
      while (this.active.size > this.maxActiveNotifications) {
        const oldestId = this.active.keys().next().value as string | undefined;
        if (!oldestId) break;
        const oldest = this.active.get(oldestId);
        this.active.delete(oldestId);
        oldest?.close?.();
      }
      if (this.lastError !== null) {
        this.lastError = null;
        this.emit();
      }
      return true;
    } catch {
      this.lastError = 'delivery_failed';
      this.emit();
      return false;
    }
  }

  private flushPendingAttention(): void {
    const messages = [...this.pendingAttention.values()];
    this.pendingAttention.clear();
    // Consent/preferences may have changed while renderer context was not
    // ready. Re-enter the full eligibility gate instead of blindly showing a
    // notification that the user has since disabled.
    for (const message of messages) this.handleAttention(message);
  }

  close(): void {
    for (const notification of this.active.values()) notification.close?.();
    this.active.clear();
    this.pendingAttention.clear();
    this.listeners.clear();
  }

  private kindEnabled(kind: AttentionKind): boolean {
    if (kind === 'turn-completed') return this.preferences.sessionDone;
    if (kind === 'approval' || kind === 'question') return this.preferences.approvalNeeded;
    return this.preferences.errors;
  }

  private remember(id: string): void {
    this.rememberedIds.add(id);
    while (this.rememberedIds.size > this.maxRememberedIds) {
      const oldest = this.rememberedIds.values().next().value as string | undefined;
      if (!oldest) break;
      this.rememberedIds.delete(oldest);
    }
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }
}

export class FileDesktopNotificationPreferenceStore implements DesktopNotificationPreferenceStore {
  constructor(private readonly path: string) {}

  load(): DesktopNotificationPreferences {
    try {
      return sanitizeDesktopNotificationPreferences(
        JSON.parse(readFileSync(this.path, 'utf8')),
      );
    } catch {
      return { ...DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES };
    }
  }

  save(preferences: DesktopNotificationPreferences): void {
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

export function sanitizeDesktopNotificationPreferences(
  value: unknown,
  fallback: DesktopNotificationPreferences = DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES,
): DesktopNotificationPreferences {
  const candidate = value && typeof value === 'object'
    ? value as Partial<DesktopNotificationPreferences>
    : {};
  return {
    desktop: typeof candidate.desktop === 'boolean' ? candidate.desktop : fallback.desktop,
    sessionDone: typeof candidate.sessionDone === 'boolean' ? candidate.sessionDone : fallback.sessionDone,
    approvalNeeded: typeof candidate.approvalNeeded === 'boolean' ? candidate.approvalNeeded : fallback.approvalNeeded,
    errors: typeof candidate.errors === 'boolean' ? candidate.errors : fallback.errors,
    sound: typeof candidate.sound === 'boolean' ? candidate.sound : fallback.sound,
  };
}
