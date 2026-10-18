import { createHash } from 'node:crypto';
import type {
  AttentionControlMessage,
  AttentionEvent,
  AttentionInboxRef,
  AttentionKind,
  AttentionMessage,
  AttentionNavigationTarget,
  ScheduleConfirmationAttentionMessage,
  SessionAttentionMessage,
} from '@gian/shared';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export interface DesktopNotificationPreferences {
  /** Device-level OS consent. User-level master/kind switches live in the
   *  Host config and gate the attention signal before it ever reaches this
   *  process — they are deliberately NOT duplicated here. */
  desktop: boolean;
  sound: boolean;
}

export interface DesktopNotificationContext {
  windowFocused: boolean;
  visibleSessionId: string | null;
}

/** Session fields stay camelCase on the existing `desktop:navigation` object.
 *  `event`, `sessionName`, `inboxRef`, and `target` are additive. Completion
 *  and failure omit `inboxRef`. Schedule and settings targets are unchanged.
 *  `schedule_confirmation` is additive: confirmation id, control session, and
 *  the Inbox ref. It has no turn. */
export type DesktopNotificationTarget =
  | {
      type: 'session';
      sessionId: string;
      turn: number;
      kind: AttentionKind;
      event?: AttentionEvent;
      sessionName?: string;
      inboxRef?: { id: string; generation: number } | null;
      target?: AttentionNavigationTarget;
    }
  | {
      type: 'schedule';
      scheduleId: string;
      runId: string;
    }
  | {
      type: 'schedule_confirmation';
      confirmationId: string;
      controlSessionId: string;
      sessionName?: string;
      inboxRef: { id: string; generation: number };
    };

export interface DesktopNotificationState {
  supported: boolean;
  preferences: DesktopNotificationPreferences;
  lastError: 'delivery_failed' | 'withdraw_failed' | null;
  /** Registry write failed. In-memory refs stay until a later save rewrites them. */
  registryError: 'persist_failed' | null;
}

/** User interface language. Matches `SystemConfig.locale`. Null means unset. */
export type DesktopAttentionLocale = 'zh-CN' | 'en';

export interface DesktopAttentionLocaleStore {
  loadLocale(): DesktopAttentionLocale | null;
  saveLocale(locale: DesktopAttentionLocale): void;
}

export const DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES: DesktopNotificationPreferences = {
  // Native delivery must begin with an explicit renderer-side permission
  // gesture. Existing Browser Notification users are migrated only when that
  // permission is already granted.
  desktop: false,
  sound: false,
};

export interface DesktopNotificationPreferenceStore {
  load(): DesktopNotificationPreferences;
  save(preferences: DesktopNotificationPreferences): void;
}

export interface NativeNotificationPayload {
  /** Stable non-empty Electron `Notification` id. An empty id becomes a random UUID. */
  id: string;
  title: string;
  body: string;
  silent: boolean;
}

export interface NativeNotificationHandle {
  close?(): void;
}

export interface NativeNotificationCallbacks {
  onClick: () => void;
  onClose: () => void;
  onFailed: () => void;
}

export interface NativeNotificationDelivery {
  show(
    payload: NativeNotificationPayload,
    callbacks: NativeNotificationCallbacks,
  ): NativeNotificationHandle;
  /** Per-id OS delete. `false` keeps the ref. The service retries that os id
   *  on its own bounded schedule. Must not call `removeAll` or `removeGroup`. */
  remove?(id: string): boolean | Promise<boolean>;
  /** Reattach a notification still in Notification Center. Must not call `show()`.
   *  `null` means it was not in history, including an unsigned empty `getHistory()`. */
  reclaim?(
    id: string,
    callbacks: Pick<NativeNotificationCallbacks, 'onClick' | 'onClose'>,
  ): NativeNotificationHandle | null | Promise<NativeNotificationHandle | null>;
}

/** Click payload persisted with the Inbox ref so a restart can withdraw and navigate.
 *  A schedule confirmation keeps the confirmation id and does not store a turn.
 *  An older client that only accepts `type: 'session'` drops that record. */
export type DesktopAttentionActivation =
  | {
      type: 'session';
      sessionId: string;
      turn: number;
      kind: AttentionKind;
      event?: AttentionEvent;
      sessionName?: string;
      inboxRef: { id: string; generation: number };
      target?: AttentionNavigationTarget;
    }
  | {
      type: 'schedule_confirmation';
      confirmationId: string;
      controlSessionId: string;
      sessionName?: string;
      inboxRef: { id: string; generation: number };
    };

/** One shown OS notification and the Inbox ref that can withdraw it. */
export interface DesktopAttentionRefRecord {
  hostId: string;
  osId: string;
  notificationId: string;
  id: string;
  generation: number;
  revision: number;
  activation?: DesktopAttentionActivation;
}

export interface DesktopAttentionRefStore {
  loadRefs(): readonly DesktopAttentionRefRecord[];
  saveRefs(refs: readonly DesktopAttentionRefRecord[]): void;
}

export interface NativeNotificationServiceOptions {
  /** Host data-directory identity. Another Host's refs in the same file are ignored. */
  hostId: string;
  supported: boolean;
  store: DesktopNotificationPreferenceStore;
  /** Durable exact refs. Omitted in tests that do not reconcile withdrawals. */
  refs?: DesktopAttentionRefStore;
  delivery: NativeNotificationDelivery;
  onActivate: (target: DesktopNotificationTarget) => void;
  /** Native title/body. The service stays Electron-free; Main supplies locale.
   *  `locale` is the persisted user choice, or null when the choice has not arrived. */
  format?: (
    message: AttentionMessage,
    locale: DesktopAttentionLocale | null,
  ) => { title: string; body: string };
  /** Last user language. Omitted locale updates must not fall through to the OS. */
  localeStore?: DesktopAttentionLocaleStore;
  /** Failed-remove retry. Independent of the next attention control. */
  scheduleWithdrawRetry?: (run: () => void) => () => void;
  /** Failed removes of one os id before this process stops retrying it. */
  maxWithdrawFailures?: number;
  maxRememberedIds?: number;
  maxActiveNotifications?: number;
}

const DEFAULT_WITHDRAW_FAILURES = 4;
const DEFAULT_WITHDRAW_RETRY_MS = 1000;

function defaultScheduleWithdrawRetry(run: () => void): () => void {
  const timer = setTimeout(run, DEFAULT_WITHDRAW_RETRY_MS);
  timer.unref();
  return () => clearTimeout(timer);
}

/**
 * User English stays English on a Chinese OS. A missing choice uses the OS
 * locale; `zh*` is Chinese and every other OS locale is English.
 */
export function attentionLocaleOf(value: unknown): DesktopAttentionLocale | null {
  return value === 'zh-CN' || value === 'en' ? value : null;
}

export function nativeAttentionUsesChinese(
  choice: DesktopAttentionLocale | null,
  osLocale: string,
): boolean {
  if (choice === 'en') return false;
  if (choice === 'zh-CN') return true;
  return osLocale.toLowerCase().startsWith('zh');
}

/**
 * Mark-read uses the Desktop token and, when the window session has one, the
 * existing `gian_session` cookie. The token is not a user session. A missing
 * token does not send. A missing cookie still sends so an auth-off Host works.
 */
export function inboxMarkReadHeaders(input: {
  desktopToken: string;
  sessionCookie: string | null;
  desktopTokenHeader: string;
}): Record<string, string> | null {
  if (input.desktopToken.length === 0 || input.desktopTokenHeader.length === 0) return null;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    [input.desktopTokenHeader]: input.desktopToken,
  };
  if (input.sessionCookie && /^[A-Za-z0-9_-]{16,256}$/.test(input.sessionCookie)) {
    headers.cookie = `gian_session=${input.sessionCookie}`;
  }
  return headers;
}

const ATTENTION_EVENT_OK: Record<AttentionEvent, true> = {
  turn_complete: true,
  answer_needed: true,
  approval_needed: true,
  plan_review_needed: true,
  turn_failed: true,
};

function isAttentionKind(value: unknown): value is AttentionKind {
  return value === 'turn-completed'
    || value === 'approval'
    || value === 'question'
    || value === 'error';
}

/**
 * A missing or old-generation lookup is revision 0 and terminal. That sentinel
 * withdraws the exact ref even when this client already stored a higher
 * revision. A smaller non-zero revision is stale and must not win.
 */
export function attentionControlWithdraws(
  item: { revision: number; read: boolean; terminal: boolean },
  storedRevision: number,
): boolean {
  if (item.revision === 0 && item.terminal) return true;
  if (item.revision < storedRevision) return false;
  return item.read || item.terminal;
}

/** Stable across restarts for one Host data directory. Not a filesystem path. */
export function desktopNotificationHostId(dataDirectory: string): string {
  return createHash('sha256').update(`gian-notification-host\0${dataDirectory}`).digest('base64url');
}

/** Same id across restarts so `Notification.remove` hits the delivered notification. */
export function desktopNotificationOsId(
  hostId: string,
  identity: { kind: 'inbox'; id: string; generation: number } | { kind: 'attention'; notificationId: string },
): string {
  const parts = identity.kind === 'inbox'
    ? ['inbox', hostId, identity.id, String(identity.generation)]
    : ['attention', hostId, identity.notificationId];
  return createHash('sha256').update(parts.join('\0')).digest('base64url');
}

/**
 * Mark read only for the navigation object that was actually delivered.
 * A later object, a Timer target, or a completion without `inboxRef` does not match.
 * A schedule confirmation matches only that same delivered object.
 */
export function deliveredInboxRead(
  delivered: DesktopNotificationTarget | null,
  sent: DesktopNotificationTarget,
): { id: string; generation: number } | null {
  if (delivered !== sent) return null;
  if (sent.type === 'schedule_confirmation') {
    return { id: sent.inboxRef.id, generation: sent.inboxRef.generation };
  }
  if (sent.type !== 'session' || !sent.inboxRef) return null;
  return { id: sent.inboxRef.id, generation: sent.inboxRef.generation };
}

/** Ack equality for session, Timer, and schedule-confirmation navigation. */
export function desktopNavigationTargetsEqual(
  expected: DesktopNotificationTarget,
  actual: unknown,
): boolean {
  if (!actual || typeof actual !== 'object') return false;
  const candidate = actual as Record<string, unknown>;
  if (candidate.type !== expected.type) return false;
  if (expected.type === 'schedule') {
    return candidate.scheduleId === expected.scheduleId
      && candidate.runId === expected.runId;
  }
  if (expected.type === 'schedule_confirmation') {
    return candidate.confirmationId === expected.confirmationId
      && candidate.controlSessionId === expected.controlSessionId
      && inboxRefsEqual(expected.inboxRef, candidate.inboxRef);
  }
  if (candidate.type !== 'session') return false;
  return candidate.sessionId === expected.sessionId
    && candidate.turn === expected.turn
    && candidate.kind === expected.kind
    && inboxRefsEqual(expected.inboxRef, candidate.inboxRef);
}

function inboxRefsEqual(
  expected: { id: string; generation: number } | null | undefined,
  actual: unknown,
): boolean {
  if (expected == null) return actual == null;
  if (!actual || typeof actual !== 'object') return false;
  const ref = actual as { id?: unknown; generation?: unknown };
  return ref.id === expected.id && ref.generation === expected.generation;
}

/** Electron-free core so privacy, suppression, preference, and dedupe rules
 * can be tested without launching a GUI process. */
export class NativeNotificationService {
  private readonly options: NativeNotificationServiceOptions;
  private readonly hostId: string;
  private readonly maxRememberedIds: number;
  private readonly maxActiveNotifications: number;
  private preferences: DesktopNotificationPreferences;
  private context: DesktopNotificationContext = {
    windowFocused: false,
    visibleSessionId: null,
  };
  private hasRendererContext = false;
  private lastError: DesktopNotificationState['lastError'] = null;
  private registryError: DesktopNotificationState['registryError'] = null;
  private attentionLocale: DesktopAttentionLocale | null = null;
  private localeDirty = false;
  private disposed = false;
  private readonly maxWithdrawFailures: number;
  private readonly scheduleWithdrawRetry: (run: () => void) => () => void;
  /** Failed remove attempts per os id. A successful remove clears that id only. */
  private withdrawFailures = new Map<string, number>();
  private withdrawRetryCancels = new Map<string, () => void>();
  private rememberedIds = new Set<string>();
  private pendingAttention = new Map<string, AttentionMessage>();
  private listeners = new Set<(state: DesktopNotificationState) => void>();
  private active = new Map<string, NativeNotificationHandle>();
  private shownRefs: DesktopAttentionRefRecord[] = [];
  /** Exact `{host, inbox id, generation}` values that must not pop later. */
  private withdrawnKeys = new Set<string>();
  /** OS ids that were shown or restored. Pending-only refs are absent. */
  private posted = new Set<string>();
  private withdrawingOsIds = new Set<string>();

  constructor(options: NativeNotificationServiceOptions) {
    if (!isBoundedString(options.hostId, 1, 128)) {
      throw new Error('notification host id is required');
    }
    this.options = options;
    this.hostId = options.hostId;
    this.maxRememberedIds = Math.max(32, options.maxRememberedIds ?? 512);
    this.maxActiveNotifications = Math.max(1, options.maxActiveNotifications ?? 64);
    this.maxWithdrawFailures = Math.max(1, options.maxWithdrawFailures ?? DEFAULT_WITHDRAW_FAILURES);
    this.scheduleWithdrawRetry = options.scheduleWithdrawRetry ?? defaultScheduleWithdrawRetry;
    this.preferences = sanitizeDesktopNotificationPreferences(options.store.load());
    try {
      const loaded = options.localeStore?.loadLocale() ?? null;
      this.attentionLocale = loaded === 'zh-CN' || loaded === 'en' ? loaded : null;
    } catch (error) {
      this.noteRegistryFailure(error);
    }
    this.shownRefs = sanitizeAttentionRefs(options.refs?.loadRefs() ?? [])
      .filter(ref => ref.hostId === this.hostId)
      .slice(0, this.maxRememberedIds);
    for (const ref of this.shownRefs) this.posted.add(ref.osId);
    this.reclaimRestored();
  }

  getState(): DesktopNotificationState {
    return {
      supported: this.options.supported,
      preferences: { ...this.preferences },
      lastError: this.lastError,
      registryError: this.registryError,
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
    // The renderer reports only which Session is visible. Window focus is
    // owned by the main process (setWindowFocused) — a renderer-reported
    // focus flag would be dead state overwritten at the IPC boundary.
    if (!value || typeof value !== 'object') return;
    const candidate = value as { visibleSessionId?: unknown; locale?: unknown };
    if (candidate.visibleSessionId !== null && typeof candidate.visibleSessionId !== 'string') return;
    this.context = {
      windowFocused: this.context.windowFocused,
      visibleSessionId: candidate.visibleSessionId?.slice(0, 512) ?? null,
    };
    if (candidate.locale === 'zh-CN' || candidate.locale === 'en') {
      this.rememberAttentionLocale(candidate.locale);
    }
    this.hasRendererContext = true;
    this.flushPendingAttention();
  }

  setWindowFocused(focused: boolean): void {
    if (this.context.windowFocused === focused) return;
    this.context = { ...this.context, windowFocused: focused };
  }

  subscribe(listener: (state: DesktopNotificationState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  handleAttention(message: AttentionMessage): boolean {
    if (this.rememberedIds.has(message.id)) return false;
    if (this.refWithdrawn(message.inbox_ref)) {
      this.remember(message.id);
      return false;
    }
    if (!this.options.supported || !this.preferences.desktop) {
      this.forgetShownNotification(message.id);
      return false;
    }
    // A newly created renderer has not supplied visibility context yet. Keep
    // the low-frequency signal bounded until it does, so an active Session is
    // never notified merely because IPC initialization lost a race.
    if (!this.hasRendererContext) {
      this.pendingAttention.set(message.id, message);
      this.trackShownRef(message, 0, false);
      while (this.pendingAttention.size > this.maxRememberedIds) {
        const oldest = this.pendingAttention.keys().next().value as string | undefined;
        if (!oldest) break;
        this.pendingAttention.delete(oldest);
        this.forgetShownNotification(oldest);
      }
      return false;
    }
    return this.deliverAttention(message);
  }

  /** Exact `{id, generation}` read/terminal state from the attention socket. */
  applyAttentionControl(message: AttentionControlMessage): void {
    let revisionChanged = false;
    for (const item of message.items) {
      const index = this.shownRefs.findIndex(ref => (
        ref.hostId === this.hostId
        && ref.id === item.id
        && ref.generation === item.generation
      ));
      if (index < 0) {
        // Control won the race. Suppress this generation only; a later
        // generation of the same id, and every other session, can still show.
        if (item.read || item.terminal) this.noteWithdrawn(item.id, item.generation);
        continue;
      }
      const stored = this.shownRefs[index]!;
      if (!attentionControlWithdraws(item, stored.revision)) {
        if (item.revision > stored.revision) {
          this.shownRefs[index] = { ...stored, revision: item.revision };
          revisionChanged = true;
        }
        continue;
      }
      this.withdrawShown(stored);
    }
    if (revisionChanged) this.persistRefs();
  }

  attentionLookupRefs(): AttentionInboxRef[] {
    return this.shownRefs
      .filter(ref => ref.hostId === this.hostId)
      .map(ref => ({ id: ref.id, generation: ref.generation }));
  }

  private deliverAttention(message: AttentionMessage): boolean {
    if (this.rememberedIds.has(message.id)) return false;
    if (this.refWithdrawn(message.inbox_ref)) {
      this.remember(message.id);
      this.forgetShownNotification(message.id);
      return false;
    }
    this.remember(message.id);
    const target = navigationTargetFor(message);
    if (!target) {
      this.forgetShownNotification(message.id);
      return false;
    }
    if (
      this.context.windowFocused
      && this.context.visibleSessionId === message.session_id
    ) {
      this.forgetShownNotification(message.id);
      return false;
    }

    const osId = osIdForMessage(this.hostId, message);
    const copy = this.copyFor(message);
    try {
      const handle = this.options.delivery.show({
        id: osId,
        title: copy.title,
        body: copy.body,
        silent: !this.preferences.sound,
      }, {
        onClick: () => {
          // Some Electron/macOS versions do not emit `close` after `click`.
          // Drop the strong handle here. The OS notification is removed by id;
          // the persisted ref stays until that remove succeeds.
          this.active.delete(message.id);
          this.withdrawOsId(osId);
          this.options.onActivate(target);
        },
        onClose: () => { this.active.delete(message.id); },
        onFailed: () => {
          this.active.delete(message.id);
          this.lastError = 'delivery_failed';
          this.emit();
        },
      });
      this.posted.add(osId);
      this.active.set(message.id, handle);
      this.trackShownRef(message, this.storedRevision(message), true);
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
      this.forgetShownNotification(message.id);
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
    this.disposed = true;
    for (const cancel of this.withdrawRetryCancels.values()) cancel();
    this.withdrawRetryCancels.clear();
    for (const notification of this.active.values()) notification.close?.();
    this.active.clear();
    this.pendingAttention.clear();
    this.listeners.clear();
  }

  private reclaimRestored(): void {
    const reclaim = this.options.delivery.reclaim;
    if (!reclaim) return;
    for (const ref of [...this.shownRefs]) this.attachRestored(ref, reclaim);
  }

  private attachRestored(
    ref: DesktopAttentionRefRecord,
    reclaim: NonNullable<NativeNotificationDelivery['reclaim']>,
  ): void {
    let outcome: NativeNotificationHandle | null | Promise<NativeNotificationHandle | null>;
    try {
      outcome = reclaim(ref.osId, {
        onClick: () => {
          this.active.delete(ref.notificationId);
          this.withdrawShown(ref);
          const target = storedNavigationTarget(ref);
          if (target) this.options.onActivate(target);
        },
        onClose: () => { this.active.delete(ref.notificationId); },
      });
    } catch {
      return;
    }
    const store = (handle: NativeNotificationHandle | null): void => {
      if (!handle) return;
      const stillShown = this.shownRefs.some(item => (
        item.hostId === ref.hostId && item.osId === ref.osId
      ));
      if (!stillShown) {
        handle.close?.();
        return;
      }
      if (!this.active.has(ref.notificationId)) this.active.set(ref.notificationId, handle);
    };
    if (isPromise(outcome)) {
      void outcome.then(store, () => undefined);
      return;
    }
    store(outcome);
  }

  private withdrawOsId(osId: string): void {
    const stored = this.shownRefs.find(ref => (
      ref.hostId === this.hostId && ref.osId === osId
    ));
    if (stored) {
      this.withdrawShown(stored);
      return;
    }
    try {
      const outcome = this.requestRemove(osId);
      if (isPromise(outcome)) void outcome.then(() => undefined, () => undefined);
    } catch {
      // A completion has no persisted ref to retry. The click still navigates.
    }
  }

  private withdrawShown(stored: DesktopAttentionRefRecord): void {
    if (this.disposed) return;
    if (!this.posted.has(stored.osId)) {
      this.completeWithdraw(stored);
      return;
    }
    if (this.withdrawingOsIds.has(stored.osId)) return;
    this.withdrawingOsIds.add(stored.osId);
    let outcome: boolean | Promise<boolean>;
    try {
      outcome = this.requestRemove(stored.osId);
    } catch {
      this.withdrawingOsIds.delete(stored.osId);
      this.failWithdraw(stored.osId);
      return;
    }
    if (isPromise(outcome)) {
      void outcome.then(
        removed => { this.settleWithdraw(stored, removed === true); },
        () => { this.settleWithdraw(stored, false); },
      );
      return;
    }
    this.withdrawingOsIds.delete(stored.osId);
    if (outcome) this.completeWithdraw(stored);
    else this.failWithdraw(stored.osId);
  }

  private settleWithdraw(stored: DesktopAttentionRefRecord, removed: boolean): void {
    this.withdrawingOsIds.delete(stored.osId);
    try {
      if (removed) this.completeWithdraw(stored);
      else this.failWithdraw(stored.osId);
    } catch (error) {
      this.noteRegistryFailure(error);
    }
  }

  private requestRemove(osId: string): boolean | Promise<boolean> {
    const remove = this.options.delivery.remove;
    if (!remove) return false;
    return remove(osId);
  }

  private completeWithdraw(stored: DesktopAttentionRefRecord): void {
    const index = this.shownRefs.findIndex(ref => (
      ref.hostId === stored.hostId && ref.osId === stored.osId
    ));
    if (index >= 0) this.shownRefs.splice(index, 1);
    this.posted.delete(stored.osId);
    this.noteWithdrawn(stored.id, stored.generation);
    this.remember(stored.notificationId);
    this.dropPending(stored.id, stored.generation);
    this.closeHandle(stored.notificationId);
    this.withdrawFailures.delete(stored.osId);
    this.cancelWithdrawRetry(stored.osId);
    this.persistRefs();
    if (this.lastError === 'withdraw_failed' && !this.hasWithdrawFailure()) {
      this.lastError = null;
      this.emit();
    }
  }

  private failWithdraw(osId: string): void {
    if (this.lastError !== 'withdraw_failed') {
      this.lastError = 'withdraw_failed';
      this.emit();
    }
    if (this.disposed || !this.options.delivery.remove) return;
    const failures = (this.withdrawFailures.get(osId) ?? 0) + 1;
    this.withdrawFailures.set(osId, failures);
    if (failures >= this.maxWithdrawFailures) return;
    if (this.withdrawRetryCancels.has(osId)) return;
    const cancel = this.scheduleWithdrawRetry(() => {
      this.withdrawRetryCancels.delete(osId);
      if (this.disposed) return;
      const stored = this.shownRefs.find(ref => ref.hostId === this.hostId && ref.osId === osId);
      if (!stored || !this.posted.has(osId)) return;
      this.withdrawShown(stored);
    });
    this.withdrawRetryCancels.set(osId, cancel);
  }

  private hasWithdrawFailure(): boolean {
    for (const osId of this.withdrawFailures.keys()) {
      if (this.shownRefs.some(ref => ref.hostId === this.hostId && ref.osId === osId)) return true;
    }
    return false;
  }

  private cancelWithdrawRetry(osId: string): void {
    const cancel = this.withdrawRetryCancels.get(osId);
    if (!cancel) return;
    this.withdrawRetryCancels.delete(osId);
    cancel();
  }

  private copyFor(message: AttentionMessage): { title: string; body: string } {
    let formatted: { title?: unknown; body?: unknown } | undefined;
    try {
      formatted = this.options.format?.(message, this.attentionLocale);
    } catch {
      formatted = undefined;
    }
    return {
      title: displayText(formatted?.title) ?? displayText(message.title) ?? 'Untitled',
      body: displayText(formatted?.body) ?? displayText(message.body) ?? '',
    };
  }

  private storedRevision(message: AttentionMessage): number {
    const ref = message.inbox_ref;
    if (!ref) return 0;
    return this.shownRefs.find(item => (
      item.hostId === this.hostId && item.id === ref.id && item.generation === ref.generation
    ))?.revision ?? 0;
  }

  private trackShownRef(message: AttentionMessage, revision: number, posted: boolean): void {
    const ref = message.inbox_ref;
    if (!ref) return;
    const osId = desktopNotificationOsId(this.hostId, {
      kind: 'inbox',
      id: ref.id,
      generation: ref.generation,
    });
    if (posted) this.posted.add(osId);
    const activation = activationFor(message, ref);
    const existing = this.shownRefs.findIndex(item => (
      item.hostId === this.hostId && item.id === ref.id && item.generation === ref.generation
    ));
    if (existing >= 0) {
      const previous = this.shownRefs[existing]!;
      if (previous.notificationId !== message.id) {
        if (previous.osId !== osId) this.closeHandle(previous.notificationId);
        else this.active.delete(previous.notificationId);
      }
      this.shownRefs[existing] = {
        hostId: this.hostId,
        osId,
        notificationId: message.id,
        id: ref.id,
        generation: ref.generation,
        revision: Math.max(previous.revision, revision),
        ...(activation ? { activation } : {}),
      };
    } else {
      this.shownRefs.push({
        hostId: this.hostId,
        osId,
        notificationId: message.id,
        id: ref.id,
        generation: ref.generation,
        revision,
        ...(activation ? { activation } : {}),
      });
    }
    while (this.shownRefs.length > this.maxRememberedIds) {
      const oldest = this.shownRefs.shift();
      if (!oldest) break;
      this.posted.delete(oldest.osId);
      this.pendingAttention.delete(oldest.notificationId);
      this.closeHandle(oldest.notificationId);
      this.withdrawFailures.delete(oldest.osId);
      this.cancelWithdrawRetry(oldest.osId);
    }
    this.persistRefs();
  }

  private forgetShownNotification(notificationId: string | undefined): void {
    if (!notificationId) return;
    const dropped = this.shownRefs.filter(item => item.notificationId === notificationId);
    const next = this.shownRefs.filter(item => item.notificationId !== notificationId);
    if (next.length === this.shownRefs.length) return;
    this.shownRefs = next;
    for (const ref of dropped) {
      this.posted.delete(ref.osId);
      this.withdrawFailures.delete(ref.osId);
      this.cancelWithdrawRetry(ref.osId);
    }
    this.persistRefs();
  }

  private dropPending(id: string, generation: number): void {
    for (const [notificationId, pending] of this.pendingAttention) {
      if (pending.inbox_ref?.id !== id || pending.inbox_ref.generation !== generation) continue;
      this.pendingAttention.delete(notificationId);
      this.remember(notificationId);
    }
  }

  private closeHandle(notificationId: string): void {
    const handle = this.active.get(notificationId);
    if (!handle) return;
    this.active.delete(notificationId);
    handle.close?.();
  }

  private refWithdrawn(ref: AttentionMessage['inbox_ref']): boolean {
    if (!ref) return false;
    return this.withdrawnKeys.has(attentionRefKey(this.hostId, ref.id, ref.generation));
  }

  private noteWithdrawn(id: string, generation: number): void {
    const key = attentionRefKey(this.hostId, id, generation);
    this.withdrawnKeys.delete(key);
    this.withdrawnKeys.add(key);
    while (this.withdrawnKeys.size > this.maxRememberedIds) {
      const oldest = this.withdrawnKeys.values().next().value as string | undefined;
      if (!oldest) break;
      this.withdrawnKeys.delete(oldest);
    }
  }

  private rememberAttentionLocale(locale: DesktopAttentionLocale): void {
    if (this.attentionLocale === locale && !this.localeDirty) return;
    this.attentionLocale = locale;
    if (!this.options.localeStore) {
      this.localeDirty = false;
      return;
    }
    this.localeDirty = true;
    this.persistLocale();
  }

  private persistLocale(): void {
    if (!this.localeDirty || !this.attentionLocale || !this.options.localeStore) return;
    try {
      this.options.localeStore.saveLocale(this.attentionLocale);
      this.localeDirty = false;
      this.clearRegistryErrorIfClean();
    } catch (error) {
      this.noteRegistryFailure(error);
    }
  }

  private persistRefs(): void {
    this.persistLocale();
    if (!this.options.refs) {
      this.clearRegistryErrorIfClean();
      return;
    }
    try {
      this.options.refs.saveRefs(this.shownRefs.map(ref => ({ ...ref })));
      this.clearRegistryErrorIfClean();
    } catch (error) {
      this.noteRegistryFailure(error);
    }
  }

  private noteRegistryFailure(error: unknown): void {
    console.warn('[desktop] notification registry persist failed', error);
    if (this.registryError === 'persist_failed') return;
    this.registryError = 'persist_failed';
    this.emit();
  }

  private clearRegistryErrorIfClean(): void {
    if (this.localeDirty || this.registryError === null) return;
    this.registryError = null;
    this.emit();
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

interface NotificationProfileFile {
  desktop?: unknown;
  sound?: unknown;
  attentionRefs?: unknown;
  locale?: unknown;
}

export class FileDesktopNotificationPreferenceStore
  implements DesktopNotificationPreferenceStore, DesktopAttentionRefStore {
  constructor(
    private readonly path: string,
    private readonly hostId?: string,
  ) {}

  load(): DesktopNotificationPreferences {
    return sanitizeDesktopNotificationPreferences(this.read());
  }

  save(preferences: DesktopNotificationPreferences): void {
    const file = this.read();
    this.writeProfile(
      preferences,
      sanitizeAttentionRefs(file.attentionRefs),
      attentionLocaleOf(file.locale),
    );
  }

  loadRefs(): readonly DesktopAttentionRefRecord[] {
    const refs = sanitizeAttentionRefs(this.read().attentionRefs);
    return this.hostId ? refs.filter(ref => ref.hostId === this.hostId) : refs;
  }

  loadLocale(): DesktopAttentionLocale | null {
    return attentionLocaleOf(this.read().locale);
  }

  saveLocale(locale: DesktopAttentionLocale): void {
    const file = this.read();
    this.writeProfile(
      sanitizeDesktopNotificationPreferences(file),
      sanitizeAttentionRefs(file.attentionRefs),
      locale,
    );
  }

  saveRefs(refs: readonly DesktopAttentionRefRecord[]): void {
    const file = this.read();
    const existing = sanitizeAttentionRefs(file.attentionRefs);
    const clean = sanitizeAttentionRefs(refs);
    const merged = this.hostId
      ? [
          ...existing.filter(ref => ref.hostId !== this.hostId),
          ...clean.filter(ref => ref.hostId === this.hostId),
        ]
      : clean;
    this.writeProfile(
      sanitizeDesktopNotificationPreferences(file),
      merged,
      attentionLocaleOf(file.locale),
    );
  }

  private writeProfile(
    preferences: DesktopNotificationPreferences,
    refs: readonly DesktopAttentionRefRecord[],
    locale: DesktopAttentionLocale | null,
  ): void {
    const payload: NotificationProfileFile = { ...preferences };
    if (refs.length > 0) payload.attentionRefs = refs;
    if (locale) payload.locale = locale;
    this.write(payload);
  }

  private read(): NotificationProfileFile {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return parsed as NotificationProfileFile;
    } catch {
      return {};
    }
  }

  private write(value: unknown): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
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

export function sanitizeAttentionRefs(value: unknown): DesktopAttentionRefRecord[] {
  if (!Array.isArray(value)) return [];
  const refs: DesktopAttentionRefRecord[] = [];
  for (const item of value) {
    const ref = sanitizeAttentionRef(item);
    if (!ref) continue;
    refs.push(ref);
    if (refs.length >= 4096) break;
  }
  return refs;
}

function sanitizeAttentionRef(item: unknown): DesktopAttentionRefRecord | null {
  if (!item || typeof item !== 'object') return null;
  const candidate = item as Partial<DesktopAttentionRefRecord>;
  const generation = candidate.generation;
  const revision = candidate.revision;
  if (
    !isBoundedString(candidate.hostId, 1, 128)
    || !isBoundedString(candidate.osId, 1, 128)
    || !isBoundedString(candidate.notificationId, 1, 512)
    || !isBoundedString(candidate.id, 1, 128)
    || !isSafeInteger(generation)
    || generation < 1
    || !isSafeInteger(revision)
    || revision < 0
  ) return null;
  const activation = sanitizeActivation(candidate.activation, candidate.id, generation);
  return {
    hostId: candidate.hostId,
    osId: candidate.osId,
    notificationId: candidate.notificationId,
    id: candidate.id,
    generation,
    revision,
    ...(activation ? { activation } : {}),
  };
}

function sanitizeActivation(
  value: unknown,
  id: string,
  generation: number,
): DesktopAttentionActivation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.type === 'schedule_confirmation') {
    return sanitizeScheduleConfirmationActivation(record, id, generation);
  }
  const candidate = value as Partial<Extract<DesktopAttentionActivation, { type: 'session' }>>;
  const turn = candidate.turn;
  if (
    candidate.type !== 'session'
    || !isBoundedString(candidate.sessionId, 1, 512)
    || !isSafeInteger(turn)
    || turn < 1
    || !isAttentionKind(candidate.kind)
    || !candidate.inboxRef
    || candidate.inboxRef.id !== id
    || candidate.inboxRef.generation !== generation
  ) return undefined;
  if (candidate.event !== undefined && !isAttentionEvent(candidate.event)) return undefined;
  if (
    candidate.sessionName !== undefined
    && (typeof candidate.sessionName !== 'string' || candidate.sessionName.length > 120)
  ) return undefined;
  const target = sanitizeSessionTarget(candidate.target);
  return {
    type: 'session',
    sessionId: candidate.sessionId,
    turn,
    kind: candidate.kind,
    ...(candidate.event ? { event: candidate.event } : {}),
    ...(candidate.sessionName !== undefined ? { sessionName: candidate.sessionName } : {}),
    inboxRef: { id, generation },
    ...(target ? { target } : {}),
  };
}

function sanitizeSessionTarget(value: unknown): AttentionNavigationTarget | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const target = value as Record<string, unknown>;
  if (target.type !== 'session') return undefined;
  if (!isBoundedString(target.session_id, 1, 512)) return undefined;
  if (!isSafeInteger(target.turn) || target.turn < 1) return undefined;
  if (target.interaction_id !== null && !isBoundedString(target.interaction_id, 1, 4096)) return undefined;
  const keys = Object.keys(target);
  if (keys.some(key => key !== 'type' && key !== 'session_id' && key !== 'turn' && key !== 'interaction_id')) {
    return undefined;
  }
  return {
    type: 'session',
    session_id: target.session_id,
    turn: target.turn,
    interaction_id: target.interaction_id as string | null,
  };
}

function attentionRefKey(hostId: string, id: string, generation: number): string {
  return `${hostId}\0${generation}\0${id}`;
}

function osIdForMessage(hostId: string, message: AttentionMessage): string {
  const ref = message.inbox_ref;
  if (ref) {
    return desktopNotificationOsId(hostId, {
      kind: 'inbox',
      id: ref.id,
      generation: ref.generation,
    });
  }
  return desktopNotificationOsId(hostId, {
    kind: 'attention',
    notificationId: message.id,
  });
}

const SCHEDULE_CONFIRMATION_ACTIVATION_KEYS = new Set([
  'type', 'confirmationId', 'controlSessionId', 'sessionName', 'inboxRef',
]);

function sanitizeScheduleConfirmationActivation(
  candidate: Record<string, unknown>,
  id: string,
  generation: number,
): DesktopAttentionActivation | undefined {
  if (Object.keys(candidate).some(key => !SCHEDULE_CONFIRMATION_ACTIVATION_KEYS.has(key))) {
    return undefined;
  }
  if (!isBoundedString(candidate.confirmationId, 1, 128)) return undefined;
  if (!isBoundedString(candidate.controlSessionId, 1, 512)) return undefined;
  const sessionName = candidate.sessionName;
  if (
    sessionName !== undefined
    && (typeof sessionName !== 'string' || sessionName.length > 120)
  ) return undefined;
  if (!candidate.inboxRef || typeof candidate.inboxRef !== 'object' || Array.isArray(candidate.inboxRef)) {
    return undefined;
  }
  const ref = candidate.inboxRef as { id?: unknown; generation?: unknown };
  if (ref.id !== id || ref.generation !== generation) return undefined;
  return {
    type: 'schedule_confirmation',
    confirmationId: candidate.confirmationId,
    controlSessionId: candidate.controlSessionId,
    ...(typeof sessionName === 'string' ? { sessionName } : {}),
    inboxRef: { id, generation },
  };
}

/**
 * Local narrowing. This module does not value-import `@gian/shared`.
 * `isScheduleConfirmationAttentionMessage` is the shared wire guard.
 * A present `turn` stays on the session arm and cannot open a confirmation.
 */
function isScheduleConfirmationAttention(
  message: AttentionMessage,
): message is ScheduleConfirmationAttentionMessage {
  if ('turn' in message) return false;
  if (message.target.type !== 'schedule_confirmation') return false;
  return message.target.confirmation_id.length > 0
    && message.inbox_ref.id.length > 0
    && Number.isInteger(message.inbox_ref.generation)
    && message.inbox_ref.generation >= 1;
}

function hasSessionTurn(message: AttentionMessage): message is SessionAttentionMessage {
  if (message.target?.type === 'schedule_confirmation') return false;
  if (!('turn' in message)) return false;
  return Number.isInteger(message.turn) && message.turn >= 1;
}

function scheduleConfirmationNavigation(
  message: ScheduleConfirmationAttentionMessage,
): Extract<DesktopNotificationTarget, { type: 'schedule_confirmation' }> {
  return {
    type: 'schedule_confirmation',
    confirmationId: message.target.confirmation_id,
    controlSessionId: message.session_id,
    sessionName: message.session_name,
    inboxRef: {
      id: message.inbox_ref.id,
      generation: message.inbox_ref.generation,
    },
  };
}

function navigationTargetFor(message: AttentionMessage): DesktopNotificationTarget | null {
  if (isScheduleConfirmationAttention(message)) return scheduleConfirmationNavigation(message);
  if (!hasSessionTurn(message)) return null;
  if (message.schedule) {
    return {
      type: 'schedule',
      scheduleId: message.schedule.schedule_id,
      runId: message.schedule.run_id,
    };
  }
  return {
    type: 'session',
    sessionId: message.session_id,
    turn: message.turn,
    kind: message.kind,
    ...(message.event ? { event: message.event } : {}),
    ...(message.session_name !== undefined ? { sessionName: message.session_name } : {}),
    ...(message.inbox_ref
      ? { inboxRef: { id: message.inbox_ref.id, generation: message.inbox_ref.generation } }
      : {}),
    ...(message.target ? { target: message.target } : {}),
  };
}

function activationFor(
  message: AttentionMessage,
  ref: AttentionInboxRef,
): DesktopAttentionActivation | undefined {
  if (isScheduleConfirmationAttention(message)) {
    const target = scheduleConfirmationNavigation(message);
    if (target.confirmationId !== message.target.confirmation_id) return undefined;
    if (target.inboxRef.id !== ref.id || target.inboxRef.generation !== ref.generation) return undefined;
    return sanitizeActivation(target, ref.id, ref.generation);
  }
  if (!hasSessionTurn(message)) return undefined;
  return sanitizeActivation({
    type: 'session',
    sessionId: message.session_id,
    turn: message.turn,
    kind: message.kind,
    ...(message.event ? { event: message.event } : {}),
    ...(message.session_name !== undefined ? { sessionName: message.session_name } : {}),
    inboxRef: { id: ref.id, generation: ref.generation },
    ...(message.target ? { target: message.target } : {}),
  }, ref.id, ref.generation);
}

/** Reclaim uses the stored confirmation id. A missing id does not become a session turn. */
function storedNavigationTarget(ref: DesktopAttentionRefRecord): DesktopNotificationTarget | null {
  const activation = ref.activation;
  if (!activation) return null;
  if (activation.inboxRef.id !== ref.id || activation.inboxRef.generation !== ref.generation) return null;
  if (activation.type === 'schedule_confirmation') {
    if (activation.confirmationId.length === 0) return null;
    return {
      type: 'schedule_confirmation',
      confirmationId: activation.confirmationId,
      controlSessionId: activation.controlSessionId,
      ...(activation.sessionName !== undefined ? { sessionName: activation.sessionName } : {}),
      inboxRef: { id: ref.id, generation: ref.generation },
    };
  }
  if (!Number.isInteger(activation.turn) || activation.turn < 1) return null;
  return activation;
}

function isAttentionEvent(value: unknown): value is AttentionEvent {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ATTENTION_EVENT_OK, value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isBoundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string'
    && !value.includes('\0')
    && value.length >= min
    && value.length <= max;
}

function displayText(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.length > 180 ? value.slice(0, 180) : value;
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T> | null)?.then === 'function';
}

export function sanitizeDesktopNotificationPreferences(
  value: unknown,
  fallback: DesktopNotificationPreferences = DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES,
): DesktopNotificationPreferences {
  const candidate = value && typeof value === 'object'
    ? value as Partial<DesktopNotificationPreferences>
    : {};
  // Legacy 0.6.x files carry the retired user-level kind switches
  // (sessionDone/approvalNeeded/errors). They now live in the Host config;
  // only the device-level fields migrate forward.
  return {
    desktop: typeof candidate.desktop === 'boolean' ? candidate.desktop : fallback.desktop,
    sound: typeof candidate.sound === 'boolean' ? candidate.sound : fallback.sound,
  };
}
