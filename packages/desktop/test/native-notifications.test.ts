import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AttentionMessage } from '@gian/shared';
import type { ScheduleConfirmationAttentionMessage } from '../../shared/src/attention.js';
import {
  attentionControlWithdraws,
  DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES,
  deliveredInboxRead,
  desktopNavigationTargetsEqual,
  desktopNotificationOsId,
  FileDesktopNotificationPreferenceStore,
  inboxMarkReadHeaders,
  NativeNotificationService,
  nativeAttentionUsesChinese,
  sanitizeAttentionRefs,
  sanitizeDesktopNotificationPreferences,
  type DesktopAttentionRefRecord,
  type DesktopNotificationPreferences,
  type DesktopNotificationTarget,
  type NativeNotificationDelivery,
  type NativeNotificationPayload,
} from '../src/native-notifications.js';

const HOST_ID = 'host-a';

const attention: AttentionMessage = {
  type: 'attention',
  id: 'gian:s1:2:turn-completed:done',
  session_id: 's1',
  turn: 2,
  kind: 'turn-completed',
  timestamp: 100,
  title: 'Gian · Session completed',
  body: 'Turn 2 completed.',
  provider: 'codex',
};

function fixture(
  initial: DesktopNotificationPreferences = {
    ...DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES,
    desktop: true,
  },
  initializeContext = true,
) {
  let saved = { ...initial };
  const shown: Array<{
    payload: NativeNotificationPayload;
    callbacks: Parameters<NativeNotificationDelivery['show']>[1];
  }> = [];
  const activated: unknown[] = [];
  let closed = 0;
  const service = new NativeNotificationService({
    hostId: HOST_ID,
    supported: true,
    store: {
      load: () => saved,
      save: value => { saved = { ...value }; },
    },
    delivery: {
      show(payload, callbacks) {
        shown.push({ payload, callbacks });
        return { close: () => { closed += 1; } };
      },
    },
    onActivate: target => activated.push(target),
  });
  if (initializeContext) {
    service.setWindowFocused(false);
    service.setContext({ visibleSessionId: null });
  }
  return { service, shown, activated, saved: () => saved, closed: () => closed };
}

test('notifies in the background, dedupes, and preserves a safe click target', () => {
  const { service, shown, activated, closed } = fixture();
  assert.equal(service.handleAttention(attention), true);
  assert.equal(service.handleAttention(attention), false);
  assert.deepEqual(shown.map(item => item.payload), [{
    id: desktopNotificationOsId(HOST_ID, { kind: 'attention', notificationId: attention.id }),
    title: attention.title,
    body: attention.body,
    silent: true,
  }]);
  shown[0]!.callbacks.onClick();
  assert.deepEqual(activated, [{
    type: 'session',
    sessionId: 's1',
    turn: 2,
    kind: 'turn-completed',
  }]);
  service.close();
  assert.equal(closed(), 0, 'clicked notifications do not retain active handles');
});

test('a scheduled-run attention activates the Timer run-log target, not a session turn', () => {
  const { service, shown, activated } = fixture();
  const scheduledAttention: AttentionMessage = {
    ...attention,
    id: 'gian:attention:schedule-run-run-1',
    session_id: 'control-session',
    kind: 'error',
    title: 'Scheduled run failed',
    body: 'A scheduled run failed (SCHEDULE_FORK_FAILED). Open the schedule run log for details.',
    schedule: { schedule_id: 'sched-1', run_id: 'run-1' },
  };
  assert.equal(service.handleAttention(scheduledAttention), true);
  shown[0]!.callbacks.onClick();
  assert.deepEqual(activated, [{
    type: 'schedule',
    scheduleId: 'sched-1',
    runId: 'run-1',
  }]);
});

test('suppresses only the session currently visible in a focused window', () => {
  const { service, shown } = fixture();
  service.setWindowFocused(true);
  service.setContext({ visibleSessionId: 's1' });
  assert.equal(service.handleAttention(attention), false);
  assert.equal(service.handleAttention({ ...attention, id: 'other', session_id: 's2' }), true);
  assert.equal(shown.length, 1);
});

test('waits for first renderer visibility context before deciding foreground delivery', () => {
  const { service, shown } = fixture(undefined, false);
  assert.equal(service.handleAttention(attention), false);
  assert.equal(shown.length, 0);
  service.setWindowFocused(true);
  service.setContext({ visibleSessionId: 's1' });
  assert.equal(shown.length, 0);

  const background = { ...attention, id: 'background', session_id: 's2' };
  const next = fixture(undefined, false);
  assert.equal(next.service.handleAttention(background), false);
  next.service.setWindowFocused(true);
  next.service.setContext({ visibleSessionId: 's1' });
  assert.equal(next.shown.length, 1);
});

test('rechecks consent before flushing attention queued during renderer startup', () => {
  const master = fixture(undefined, false);
  assert.equal(master.service.handleAttention(attention), false);
  master.service.updatePreferences({ desktop: false });
  master.service.setWindowFocused(false);
  master.service.setContext({ visibleSessionId: null });
  assert.equal(master.shown.length, 0);
});

test('reset context defers suppression decisions across a renderer reload', () => {
  const { service, shown } = fixture();
  service.setWindowFocused(true);
  service.setContext({ visibleSessionId: 's1' });
  service.resetContext();
  assert.equal(service.handleAttention(attention), false);
  assert.equal(shown.length, 0);
  service.setWindowFocused(false);
  service.setContext({ visibleSessionId: null });
  assert.equal(shown.length, 1);
});

test('device-level preferences hold only consent and sound; sound drives silent delivery', () => {
  const { service, shown, saved } = fixture();
  const state = service.updatePreferences({ desktop: true, sound: true });
  assert.deepEqual(state.preferences, { desktop: true, sound: true });
  assert.deepEqual(saved(), { desktop: true, sound: true });
  // Kind gating is Host-side now: every kind the Host broadcasts is delivered.
  assert.equal(service.handleAttention(attention), true);
  assert.equal(shown[0]!.payload.silent, false);
  service.updatePreferences({ desktop: false });
  assert.equal(service.handleAttention({ ...attention, id: 'question', kind: 'question' }), false);
});

test('legacy preference files migrate to the device-level shape', () => {
  const legacy = {
    desktop: true,
    sessionDone: false,
    approvalNeeded: false,
    errors: true,
    sound: true,
  };
  assert.deepEqual(sanitizeDesktopNotificationPreferences(legacy), {
    desktop: true,
    sound: true,
  });
  assert.deepEqual(sanitizeDesktopNotificationPreferences({}), {
    ...DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES,
  });
});

test('native delivery failure is surfaced without leaking platform details', () => {
  const { service, shown } = fixture();
  const states: string[] = [];
  service.subscribe(state => states.push(String(state.lastError)));
  assert.equal(service.handleAttention(attention), true);
  shown[0]!.callbacks.onFailed();
  assert.equal(service.getState().lastError, 'delivery_failed');
  assert.equal(service.handleAttention({ ...attention, id: 'recovered' }), true);
  assert.equal(service.getState().lastError, null);
  assert.deepEqual(states, ['null', 'delivery_failed', 'null']);
});

test('caps retained native handles when the platform never emits close', () => {
  let closed = 0;
  const callbacks: Array<Parameters<NativeNotificationDelivery['show']>[1]> = [];
  const service = new NativeNotificationService({
    hostId: HOST_ID,
    supported: true,
    maxActiveNotifications: 2,
    store: {
      load: () => ({
        ...DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES,
        desktop: true,
      }),
      save: () => undefined,
    },
    delivery: {
      show(_payload, nextCallbacks) {
        callbacks.push(nextCallbacks);
        return { close: () => { closed += 1; } };
      },
    },
    onActivate: () => undefined,
  });
  service.setWindowFocused(false);
  service.setContext({ visibleSessionId: null });

  for (let index = 0; index < 3; index += 1) {
    assert.equal(service.handleAttention({
      ...attention,
      id: `attention-${index}`,
      turn: index + 1,
    }), true);
  }
  assert.equal(closed, 1, 'the oldest native handle is released at the cap');

  callbacks[1]!.onClick();
  service.close();
  assert.equal(closed, 2, 'clicked handles are removed and only the remaining handle closes');
});

test('revision 0 terminal sentinel withdraws an exact ref ahead of a higher local revision', () => {
  assert.equal(attentionControlWithdraws(
    { revision: 0, read: false, terminal: true },
    5,
  ), true);
  assert.equal(attentionControlWithdraws(
    { revision: 3, read: true, terminal: false },
    5,
  ), false);
  assert.equal(attentionControlWithdraws(
    { revision: 6, read: false, terminal: false },
    5,
  ), false);
  assert.equal(attentionControlWithdraws(
    { revision: 6, read: true, terminal: false },
    5,
  ), true);

  const saved: DesktopAttentionRefRecord[][] = [];
  const shown: Array<Parameters<NativeNotificationDelivery['show']>[1]> = [];
  const removed: string[] = [];
  let allowRemove = true;
  let closed = 0;
  const service = new NativeNotificationService({
    hostId: HOST_ID,
    supported: true,
    store: {
      load: () => ({ ...DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES, desktop: true }),
      save: () => undefined,
    },
    refs: {
      loadRefs: () => [],
      saveRefs: refs => { saved.push(refs.map(ref => ({ ...ref }))); },
    },
    delivery: {
      show(_payload, callbacks) {
        shown.push(callbacks);
        return { close: () => { closed += 1; } };
      },
      remove(id) {
        removed.push(id);
        return allowRemove;
      },
    },
    onActivate: () => undefined,
  });
  service.setWindowFocused(false);
  service.setContext({ visibleSessionId: null });

  const tracked: AttentionMessage = {
    ...attention,
    id: 'os-item-01',
    inbox_ref: { id: 'item-01', generation: 4 },
  };
  const other: AttentionMessage = {
    ...attention,
    id: 'os-item-02',
    inbox_ref: { id: 'item-02', generation: 2 },
  };
  assert.equal(service.handleAttention(tracked), true);
  assert.equal(service.handleAttention(other), true);
  service.applyAttentionControl({
    type: 'attention:control',
    items: [{ id: 'item-01', generation: 4, revision: 5, read: false, terminal: false }],
  });
  service.applyAttentionControl({
    type: 'attention:control',
    items: [{ id: 'item-01', generation: 9, revision: 0, read: false, terminal: true }],
  });
  assert.equal(closed, 0, 'a different generation does not withdraw the shown ref');
  service.applyAttentionControl({
    type: 'attention:control',
    items: [{ id: 'item-01', generation: 4, revision: 3, read: true, terminal: false }],
  });
  assert.equal(closed, 0, 'a stale lower revision does not withdraw');
  assert.equal(shown.length, 2);
  service.applyAttentionControl({
    type: 'attention:control',
    items: [{ id: 'item-01', generation: 4, revision: 8, read: false, terminal: false }],
  });
  assert.equal(shown.length, 2, 'a newer non-terminal revision does not show the notification again');
  assert.equal(closed, 0);
  service.applyAttentionControl({
    type: 'attention:control',
    items: [{ id: 'item-01', generation: 4, revision: 0, read: false, terminal: true }],
  });
  assert.equal(closed, 1, 'revision 0 terminal withdraws the exact ref');
  assert.deepEqual(removed, [
    desktopNotificationOsId(HOST_ID, { kind: 'inbox', id: 'item-01', generation: 4 }),
  ]);
  assert.deepEqual(service.attentionLookupRefs(), [{ id: 'item-02', generation: 2 }]);
  assert.equal(service.handleAttention({ ...tracked, id: 'os-item-01-replay' }), false);
  assert.equal(shown.length, 2, 'withdrawn history does not pop up again');

  service.applyAttentionControl({
    type: 'attention:control',
    items: [{ id: 'item-02', generation: 2, revision: 4, read: false, terminal: false }],
  });
  allowRemove = false;
  const beforeClick = service.attentionLookupRefs();
  shown[1]!.onClick();
  assert.deepEqual(service.attentionLookupRefs(), beforeClick, 'a failed remove keeps the inbox ref');
  shown[1]!.onClose();
  assert.deepEqual(service.attentionLookupRefs(), beforeClick, 'OS dismiss does not retire the inbox ref');
  assert.deepEqual(saved.at(-1), [{
    hostId: HOST_ID,
    osId: desktopNotificationOsId(HOST_ID, { kind: 'inbox', id: 'item-02', generation: 2 }),
    notificationId: 'os-item-02',
    id: 'item-02',
    generation: 2,
    revision: 4,
    activation: {
      type: 'session',
      sessionId: 's1',
      turn: 2,
      kind: 'turn-completed',
      inboxRef: { id: 'item-02', generation: 2 },
    },
  }]);
});

function storedRef(id: string, generation: number, hostId = HOST_ID): DesktopAttentionRefRecord {
  return {
    hostId,
    osId: `os-${hostId}-${id}-${generation}`,
    notificationId: `notification-${id}-${generation}`,
    id,
    generation,
    revision: 5,
    activation: {
      type: 'session',
      sessionId: 's1',
      turn: 2,
      kind: 'question',
      event: 'answer_needed',
      sessionName: 'Design',
      inboxRef: { id, generation },
      target: {
        type: 'session',
        session_id: 's1',
        turn: 2,
        interaction_id: 'call-1',
      },
    },
  };
}

test('preference save keeps this host registry and leaves another host untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-notification-refs-'));
  try {
    const path = join(dir, 'notification-preferences.json');
    const store = new FileDesktopNotificationPreferenceStore(path, HOST_ID);
    const other = new FileDesktopNotificationPreferenceStore(path, 'host-b');
    const kept = storedRef('item-01', 4);
    const foreign = storedRef('item-02', 2, 'host-b');
    store.save({ desktop: true, sound: false });
    store.saveRefs([kept, {
      ...kept,
      notificationId: '',
    }]);
    other.saveRefs([foreign]);
    store.save({ desktop: true, sound: true });
    const reloaded = new FileDesktopNotificationPreferenceStore(path, HOST_ID);
    assert.deepEqual(reloaded.load(), { desktop: true, sound: true });
    assert.deepEqual(reloaded.loadRefs(), [kept]);
    assert.deepEqual(other.loadRefs(), [foreign]);

    let removed = false;
    const blocked = new NativeNotificationService({
      hostId: HOST_ID,
      supported: true,
      store: reloaded,
      refs: reloaded,
      delivery: {
        show: () => ({ close() {} }),
        remove() {
          removed = true;
          return false;
        },
      },
      onActivate: () => undefined,
      scheduleWithdrawRetry: () => () => undefined,
    });
    blocked.applyAttentionControl({
      type: 'attention:control',
      items: [{ id: 'item-01', generation: 4, revision: 0, read: false, terminal: true }],
    });
    assert.equal(removed, true, 'restart withdraw calls per-id remove without an in-memory handle');
    assert.equal(blocked.getState().lastError, 'withdraw_failed');
    assert.deepEqual(blocked.attentionLookupRefs(), [{ id: 'item-01', generation: 4 }]);
    assert.deepEqual(reloaded.loadRefs(), [kept]);
    assert.deepEqual(other.loadRefs(), [foreign]);

    const released = new NativeNotificationService({
      hostId: HOST_ID,
      supported: true,
      store: reloaded,
      refs: reloaded,
      delivery: {
        show() { throw new Error('restored history must not be shown again'); },
        remove: () => true,
      },
      onActivate: () => undefined,
    });
    released.applyAttentionControl({
      type: 'attention:control',
      items: [{ id: 'item-01', generation: 4, revision: 0, read: false, terminal: true }],
    });
    assert.deepEqual(released.attentionLookupRefs(), []);
    assert.deepEqual(reloaded.loadRefs(), []);
    assert.deepEqual(other.loadRefs(), [foreign]);
    assert.deepEqual(reloaded.load(), { desktop: true, sound: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('semantic click carries the exact inbox ref and dismiss does not activate', () => {
  const { service, shown, activated } = fixture();
  const message: AttentionMessage = {
    ...attention,
    id: 'os-semantic',
    kind: 'question',
    event: 'answer_needed',
    session_name: 'Design',
    title: 'Design',
    body: 'Answer needed',
    inbox_ref: { id: 'item-9', generation: 3 },
    target: { type: 'session', session_id: 's1', turn: 2, interaction_id: 'call-9' },
  };
  assert.equal(service.handleAttention(message), true);
  assert.equal(
    shown[0]!.payload.id,
    desktopNotificationOsId(HOST_ID, { kind: 'inbox', id: 'item-9', generation: 3 }),
  );
  shown[0]!.callbacks.onClose();
  assert.deepEqual(activated, []);
  shown[0]!.callbacks.onClick();
  assert.deepEqual(activated, [{
    type: 'session',
    sessionId: 's1',
    turn: 2,
    kind: 'question',
    event: 'answer_needed',
    sessionName: 'Design',
    inboxRef: { id: 'item-9', generation: 3 },
    target: { type: 'session', session_id: 's1', turn: 2, interaction_id: 'call-9' },
  }]);
});

test('native copy uses the injected locale formatter', () => {
  const shown: NativeNotificationPayload[] = [];
  const service = new NativeNotificationService({
    hostId: HOST_ID,
    supported: true,
    store: {
      load: () => ({ ...DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES, desktop: true }),
      save: () => undefined,
    },
    delivery: {
      show(payload) {
        shown.push(payload);
        return { close() {} };
      },
    },
    format: message => ({
      title: message.session_name?.length ? message.session_name : '未命名会话',
      body: message.event === 'answer_needed' ? '需要回答' : '回合完成',
    }),
    onActivate: () => undefined,
  });
  service.setWindowFocused(false);
  service.setContext({ visibleSessionId: null });
  assert.equal(service.handleAttention({
    ...attention,
    id: 'os-locale',
    event: 'answer_needed',
    session_name: '',
    title: '',
    body: 'Answer needed',
    kind: 'question',
  }), true);
  assert.deepEqual(shown, [{
    id: desktopNotificationOsId(HOST_ID, { kind: 'attention', notificationId: 'os-locale' }),
    title: '未命名会话',
    body: '需要回答',
    silent: true,
  }]);
});

test('control before attention suppresses only that generation', () => {
  const { service, shown } = fixture();
  service.applyAttentionControl({
    type: 'attention:control',
    items: [
      { id: 'item-01', generation: 4, revision: 1, read: true, terminal: false },
      { id: 'item-03', generation: 1, revision: 2, read: false, terminal: false },
    ],
  });
  assert.equal(service.handleAttention({
    ...attention,
    id: 'late-4',
    kind: 'question',
    inbox_ref: { id: 'item-01', generation: 4 },
  }), false);
  assert.equal(service.handleAttention({
    ...attention,
    id: 'late-5',
    session_id: 's1',
    kind: 'question',
    inbox_ref: { id: 'item-01', generation: 5 },
  }), true);
  assert.equal(service.handleAttention({
    ...attention,
    id: 'other-item',
    session_id: 's2',
    kind: 'approval',
    inbox_ref: { id: 'item-03', generation: 1 },
  }), true);
  assert.equal(shown.length, 2);
});

test('suppression is bounded by exact ref and does not cover a session', () => {
  const shown: string[] = [];
  const service = new NativeNotificationService({
    hostId: HOST_ID,
    supported: true,
    maxRememberedIds: 32,
    store: {
      load: () => ({ ...DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES, desktop: true }),
      save: () => undefined,
    },
    delivery: {
      show(payload) {
        shown.push(payload.id);
        return { close() {} };
      },
    },
    onActivate: () => undefined,
  });
  service.setWindowFocused(false);
  service.setContext({ visibleSessionId: null });
  for (let generation = 1; generation <= 33; generation += 1) {
    service.applyAttentionControl({
      type: 'attention:control',
      items: [{ id: 'item-01', generation, revision: 1, read: true, terminal: false }],
    });
  }
  assert.equal(service.handleAttention({
    ...attention,
    id: 'evicted',
    inbox_ref: { id: 'item-01', generation: 1 },
  }), true);
  assert.equal(service.handleAttention({
    ...attention,
    id: 'held',
    inbox_ref: { id: 'item-01', generation: 33 },
  }), false);
  assert.equal(service.handleAttention({
    ...attention,
    id: 'other',
    session_id: 's9',
    inbox_ref: { id: 'item-09', generation: 33 },
  }), true);
  assert.equal(shown.length, 2);
});

test('restored history is reattached without show, and a failed remove can be retried', async () => {
  const record = storedRef('item-01', 4);
  let shows = 0;
  const reclaimed: string[] = [];
  const restored = new NativeNotificationService({
    hostId: HOST_ID,
    supported: true,
    store: {
      load: () => ({ ...DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES, desktop: true }),
      save: () => undefined,
    },
    refs: { loadRefs: () => [record], saveRefs: () => undefined },
    delivery: {
      show() {
        shows += 1;
        return { close() {} };
      },
      reclaim(id) {
        reclaimed.push(id);
        return { close() {} };
      },
    },
    onActivate: () => undefined,
  });
  assert.equal(shows, 0);
  assert.deepEqual(reclaimed, [record.osId]);
  assert.deepEqual(restored.attentionLookupRefs(), [{ id: 'item-01', generation: 4 }]);

  const missed = new NativeNotificationService({
    hostId: HOST_ID,
    supported: true,
    store: {
      load: () => ({ ...DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES, desktop: true }),
      save: () => undefined,
    },
    refs: { loadRefs: () => [record], saveRefs: () => undefined },
    delivery: {
      show() { throw new Error('empty history must not show'); },
      reclaim: () => null,
      remove: () => false,
    },
    onActivate: () => undefined,
  });
  assert.deepEqual(missed.attentionLookupRefs(), [{ id: 'item-01', generation: 4 }]);

  let allowRemove = false;
  const removed: string[] = [];
  const saved: DesktopAttentionRefRecord[][] = [];
  const queued: Array<() => void> = [];
  const service = new NativeNotificationService({
    hostId: HOST_ID,
    supported: true,
    store: {
      load: () => ({ ...DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES, desktop: true }),
      save: () => undefined,
    },
    refs: {
      loadRefs: () => [],
      saveRefs: refs => { saved.push(refs.map(ref => ({ ...ref }))); },
    },
    delivery: {
      show: () => ({ close() {} }),
      remove(id) {
        removed.push(id);
        return Promise.resolve(allowRemove);
      },
    },
    onActivate: () => undefined,
    scheduleWithdrawRetry(run) {
      queued.push(run);
      return () => {
        const index = queued.indexOf(run);
        if (index >= 0) queued.splice(index, 1);
      };
    },
  });
  service.setWindowFocused(false);
  service.setContext({ visibleSessionId: null });
  assert.equal(service.handleAttention({
    ...attention,
    id: 'os-retry',
    inbox_ref: { id: 'item-01', generation: 4 },
  }), true);
  const control = {
    type: 'attention:control' as const,
    items: [{ id: 'item-01', generation: 4, revision: 0, read: false, terminal: true }],
  };
  service.applyAttentionControl(control);
  await Promise.resolve();
  assert.equal(service.getState().lastError, 'withdraw_failed');
  assert.deepEqual(service.attentionLookupRefs(), [{ id: 'item-01', generation: 4 }]);
  assert.equal(queued.length, 1);
  allowRemove = true;
  const retry = queued[0];
  assert.ok(retry);
  retry();
  await Promise.resolve();
  assert.deepEqual(service.attentionLookupRefs(), []);
  assert.equal(service.getState().lastError, null);
  const osId = desktopNotificationOsId(HOST_ID, { kind: 'inbox', id: 'item-01', generation: 4 });
  assert.deepEqual(removed, [osId, osId]);
  assert.equal(saved.at(-1)?.length, 0);
});

test('sanitizeAttentionRefs narrows generation and revision before use', () => {
  const valid = storedRef('item-01', 4);
  assert.deepEqual(sanitizeAttentionRefs([
    { ...valid, generation: undefined, revision: 1 },
    { ...valid, generation: 1.5, revision: 1 },
    { ...valid, generation: 4, revision: Number.NaN },
    { ...valid, hostId: 'other-host' },
  ]), [{ ...valid, hostId: 'other-host' }]);
});

test('delivered inbox read follows the exact navigation object', () => {
  const sent: DesktopNotificationTarget = {
    type: 'session',
    sessionId: 's1',
    turn: 2,
    kind: 'question',
    inboxRef: { id: 'item-9', generation: 3 },
  };
  assert.deepEqual(deliveredInboxRead(sent, sent), { id: 'item-9', generation: 3 });
  const replacement: DesktopNotificationTarget = {
    ...sent,
    inboxRef: { id: 'item-9', generation: 4 },
  };
  assert.equal(deliveredInboxRead(replacement, sent), null);
  assert.equal(deliveredInboxRead({ ...sent, inboxRef: null }, { ...sent, inboxRef: null }), null);
  const schedule: DesktopNotificationTarget = { type: 'schedule', scheduleId: 'sched', runId: 'run' };
  assert.equal(deliveredInboxRead(schedule, schedule), null);
});

test('a failed withdraw retries without another control, and shutdown spends no more removes', () => {
  let scheduled = 0;
  const queued: Array<() => void> = [];
  const removedIds: string[] = [];
  const osId = desktopNotificationOsId(HOST_ID, { kind: 'inbox', id: 'item-01', generation: 4 });
  const otherId = desktopNotificationOsId(HOST_ID, { kind: 'inbox', id: 'item-02', generation: 1 });
  let passId = '';
  const service = new NativeNotificationService({
    hostId: HOST_ID,
    supported: true,
    maxWithdrawFailures: 2,
    store: {
      load: () => ({ desktop: true, sound: false }),
      save: () => undefined,
    },
    refs: { loadRefs: () => [], saveRefs: () => undefined },
    delivery: {
      show: () => ({ close() {} }),
      remove(id) {
        removedIds.push(id);
        return id === passId;
      },
    },
    onActivate: () => undefined,
    scheduleWithdrawRetry(run) {
      scheduled += 1;
      queued.push(run);
      return () => {
        const index = queued.indexOf(run);
        if (index >= 0) queued.splice(index, 1);
      };
    },
  });
  service.setWindowFocused(false);
  service.setContext({ visibleSessionId: null });
  assert.equal(service.handleAttention({
    ...attention,
    id: 'bound-1',
    inbox_ref: { id: 'item-01', generation: 4 },
  }), true);
  service.applyAttentionControl({
    type: 'attention:control',
    items: [{ id: 'item-01', generation: 4, revision: 0, read: false, terminal: true }],
  });
  assert.deepEqual(removedIds, [osId]);
  assert.equal(scheduled, 1);
  assert.equal(service.getState().lastError, 'withdraw_failed');

  assert.equal(service.handleAttention({
    ...attention,
    id: 'bound-2',
    kind: 'approval',
    inbox_ref: { id: 'item-02', generation: 1 },
  }), true);
  assert.equal(service.getState().lastError, 'withdraw_failed', 'another successful show does not resolve the failed withdrawal');
  passId = otherId;
  service.applyAttentionControl({
    type: 'attention:control',
    items: [{ id: 'item-02', generation: 1, revision: 0, read: true, terminal: false }],
  });
  assert.deepEqual(service.attentionLookupRefs(), [{ id: 'item-01', generation: 4 }]);
  assert.equal(service.getState().lastError, 'withdraw_failed');

  service.applyAttentionControl({
    type: 'attention:control',
    items: [{ id: 'item-01', generation: 4, revision: 8, read: false, terminal: false }],
  });
  assert.deepEqual(removedIds, [osId, otherId]);
  assert.equal(scheduled, 1);
  queued[0]?.();
  assert.deepEqual(removedIds, [osId, otherId, osId]);
  assert.equal(scheduled, 1);
  assert.deepEqual(service.attentionLookupRefs(), [{ id: 'item-01', generation: 4 }]);
  assert.equal(service.getState().lastError, 'withdraw_failed');

  let stopped = 0;
  const later: Array<() => void> = [];
  const stopping = new NativeNotificationService({
    hostId: HOST_ID,
    supported: true,
    store: {
      load: () => ({ desktop: true, sound: false }),
      save: () => undefined,
    },
    refs: { loadRefs: () => [], saveRefs: () => undefined },
    delivery: {
      show: () => ({ close() {} }),
      remove() {
        stopped += 1;
        return false;
      },
    },
    onActivate: () => undefined,
    scheduleWithdrawRetry(run) {
      later.push(run);
      return () => {
        const index = later.indexOf(run);
        if (index >= 0) later.splice(index, 1);
      };
    },
  });
  stopping.setWindowFocused(false);
  stopping.setContext({ visibleSessionId: null });
  stopping.handleAttention({
    ...attention,
    id: 'bound-stop',
    inbox_ref: { id: 'item-03', generation: 2 },
  });
  stopping.applyAttentionControl({
    type: 'attention:control',
    items: [{ id: 'item-03', generation: 2, revision: 0, read: false, terminal: true }],
  });
  assert.equal(stopped, 1);
  const stolen = later[0];
  assert.ok(stolen);
  stopping.close();
  assert.equal(later.length, 0);
  stolen();
  assert.equal(stopped, 1);
  assert.deepEqual(stopping.attentionLookupRefs(), [{ id: 'item-03', generation: 2 }]);
});

test('delivery recovery retains per-id withdrawal failures until all clear, independently of registry errors', () => {
  const first = storedRef('item-01', 4);
  const second = storedRef('item-02', 1);
  const removedIds: string[] = [];
  let passId = '';
  let failShow = false;
  let failSave = false;
  const service = new NativeNotificationService({
    hostId: HOST_ID,
    supported: true,
    store: { load: () => ({ desktop: true, sound: false }), save: () => undefined },
    refs: {
      loadRefs: () => [first, second],
      saveRefs: () => { if (failSave) throw new Error('ENOSPC'); },
    },
    delivery: {
      show() {
        if (failShow) throw new Error('delivery unavailable');
        return { close() {} };
      },
      remove(id) { removedIds.push(id); return id === passId; },
    },
    onActivate: () => undefined,
    scheduleWithdrawRetry: () => () => undefined,
  });
  service.setContext({ visibleSessionId: null });
  const withdraw = (ref: DesktopAttentionRefRecord) => service.applyAttentionControl({
    type: 'attention:control',
    items: [{ id: ref.id, generation: ref.generation, revision: ref.revision, read: true, terminal: false }],
  });
  withdraw(first);
  withdraw(second);
  assert.equal(service.getState().lastError, 'withdraw_failed');

  failShow = true;
  assert.equal(service.handleAttention({ ...attention, id: 'delivery-fails' }), false);
  assert.equal(service.getState().lastError, 'delivery_failed');
  failShow = false;
  assert.equal(service.handleAttention({ ...attention, id: 'delivery-recovers' }), true);
  assert.equal(service.getState().lastError, 'withdraw_failed');
  assert.equal(service.getState().registryError, null);

  passId = first.osId;
  withdraw(first);
  assert.deepEqual(service.attentionLookupRefs(), [{ id: second.id, generation: second.generation }]);
  assert.equal(service.getState().lastError, 'withdraw_failed');
  passId = second.osId;
  failSave = true;
  withdraw(second);
  assert.deepEqual(service.attentionLookupRefs(), []);
  assert.equal(service.getState().lastError, null);
  assert.equal(service.getState().registryError, 'persist_failed');
  assert.deepEqual(removedIds, [first.osId, second.osId, first.osId, second.osId]);
  service.close();
  assert.deepEqual(removedIds, [first.osId, second.osId, first.osId, second.osId]);
});

test('registry save failure stays in memory, does not reject, and a later save rewrites it', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on('unhandledRejection', onUnhandled);
  let fail = true;
  let blow = false;
  const saved: DesktopAttentionRefRecord[][] = [];
  const service = new NativeNotificationService({
    hostId: HOST_ID,
    supported: true,
    store: {
      load: () => ({ desktop: true, sound: false }),
      save: () => undefined,
    },
    refs: {
      loadRefs: () => [],
      saveRefs(refs) {
        if (fail) throw new Error('ENOSPC');
        saved.push(refs.map(ref => ({ ...ref })));
      },
    },
    delivery: {
      show() {
        if (blow) throw new Error('show failed');
        return { close() {} };
      },
      remove: () => Promise.resolve(true),
    },
    onActivate: () => undefined,
    scheduleWithdrawRetry: () => () => undefined,
  });
  try {
    service.setWindowFocused(false);
    service.setContext({ visibleSessionId: null });
    assert.equal(service.handleAttention({
      ...attention,
      id: 'reg-1',
      inbox_ref: { id: 'item-01', generation: 4 },
    }), true);
    assert.deepEqual(service.attentionLookupRefs(), [{ id: 'item-01', generation: 4 }]);
    assert.equal(service.getState().registryError, 'persist_failed');
    assert.equal(service.getState().lastError, null);

    fail = false;
    service.applyAttentionControl({
      type: 'attention:control',
      items: [{ id: 'item-01', generation: 4, revision: 2, read: false, terminal: false }],
    });
    assert.equal(saved.at(-1)?.[0]?.id, 'item-01');
    assert.equal(service.getState().registryError, null);

    fail = true;
    blow = true;
    assert.equal(service.handleAttention({
      ...attention,
      id: 'reg-2',
      inbox_ref: { id: 'item-02', generation: 1 },
    }), false);
    assert.deepEqual(service.attentionLookupRefs(), [{ id: 'item-01', generation: 4 }]);

    blow = false;
    service.applyAttentionControl({
      type: 'attention:control',
      items: [{ id: 'item-01', generation: 4, revision: 2, read: true, terminal: false }],
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(unhandled.length, 0);
    assert.deepEqual(service.attentionLookupRefs(), []);
    assert.equal(service.getState().registryError, 'persist_failed');
    assert.equal(service.getState().lastError, 'delivery_failed');

    fail = false;
    assert.equal(service.handleAttention({
      ...attention,
      id: 'reg-3',
      inbox_ref: { id: 'item-03', generation: 1 },
    }), true);
    assert.deepEqual(saved.at(-1)?.map(ref => ref.id), ['item-03']);
    assert.equal(service.getState().registryError, null);
  } finally {
    service.close();
    process.off('unhandledRejection', onUnhandled);
  }
});

test('a stored interface locale is kept when the next context omits it', () => {
  assert.equal(nativeAttentionUsesChinese('en', 'zh-CN'), false);
  assert.equal(nativeAttentionUsesChinese('zh-CN', 'en-US'), true);
  assert.equal(nativeAttentionUsesChinese(null, 'zh-Hans-CN'), true);
  assert.equal(nativeAttentionUsesChinese(null, 'en-US'), false);

  const seen: Array<'zh-CN' | 'en' | null> = [];
  let stored: 'zh-CN' | 'en' | null = 'en';
  let failSave = false;
  const service = new NativeNotificationService({
    hostId: HOST_ID,
    supported: true,
    store: {
      load: () => ({ desktop: true, sound: false }),
      save: () => undefined,
    },
    localeStore: {
      loadLocale: () => stored,
      saveLocale(locale) {
        if (failSave) throw new Error('ENOSPC');
        stored = locale;
      },
    },
    format: (_message, locale) => {
      seen.push(locale);
      return { title: 'Design', body: locale ?? 'os' };
    },
    delivery: { show: () => ({ close() {} }) },
    onActivate: () => undefined,
  });
  service.setWindowFocused(false);
  service.setContext({ visibleSessionId: null });
  assert.equal(service.handleAttention({ ...attention, id: 'loc-1' }), true);
  assert.equal(seen.at(-1), 'en');

  failSave = true;
  service.setContext({ visibleSessionId: null, locale: 'zh-CN' });
  assert.equal(service.getState().registryError, 'persist_failed');
  assert.equal(service.handleAttention({ ...attention, id: 'loc-2' }), true);
  assert.equal(seen.at(-1), 'zh-CN');

  service.setContext({ visibleSessionId: null });
  assert.equal(service.handleAttention({ ...attention, id: 'loc-3' }), true);
  assert.equal(seen.at(-1), 'zh-CN');
  assert.equal(stored, 'en');

  const dir = mkdtempSync(join(tmpdir(), 'gian-notification-locale-'));
  try {
    const path = join(dir, 'notification-preferences.json');
    const file = new FileDesktopNotificationPreferenceStore(path, HOST_ID);
    file.saveLocale('en');
    file.save({ desktop: true, sound: true });
    file.saveRefs([storedRef('item-01', 4)]);
    const reloaded = new FileDesktopNotificationPreferenceStore(path, HOST_ID);
    assert.equal(reloaded.loadLocale(), 'en');
    assert.deepEqual(reloaded.load(), { desktop: true, sound: true });
    assert.equal(reloaded.loadRefs().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mark-read headers carry the desktop token and the existing session cookie', () => {
  assert.equal(inboxMarkReadHeaders({
    desktopToken: '',
    sessionCookie: 'a'.repeat(32),
    desktopTokenHeader: 'X-Gian-Desktop-Token',
  }), null);
  const cookie = 'ab'.repeat(16);
  const headers = inboxMarkReadHeaders({
    desktopToken: 'desk-token',
    sessionCookie: cookie,
    desktopTokenHeader: 'X-Gian-Desktop-Token',
  });
  assert.equal(headers?.['content-type'], 'application/json');
  assert.equal(headers?.['X-Gian-Desktop-Token'], 'desk-token');
  assert.equal(headers?.cookie, `gian_session=${cookie}`);
  const unsigned = inboxMarkReadHeaders({
    desktopToken: 'desk-token',
    sessionCookie: null,
    desktopTokenHeader: 'X-Gian-Desktop-Token',
  });
  assert.equal(unsigned?.cookie, undefined);
  assert.equal(unsigned?.['X-Gian-Desktop-Token'], 'desk-token');
  const rejected = inboxMarkReadHeaders({
    desktopToken: 'desk-token',
    sessionCookie: 'not a cookie',
    desktopTokenHeader: 'X-Gian-Desktop-Token',
  });
  assert.equal(rejected?.cookie, undefined);
});

const confirmationAttention: ScheduleConfirmationAttentionMessage = {
  type: 'attention',
  id: 'gian:attention:conf-1',
  session_id: 'control-1',
  kind: 'approval',
  timestamp: 100,
  title: 'Control conversation',
  body: 'Approval needed',
  provider: 'codex',
  event: 'approval_needed',
  session_name: 'Control conversation',
  target: { type: 'schedule_confirmation', confirmation_id: 'conf-1' },
  inbox_ref: { id: 'item-conf', generation: 1 },
};

const confirmationNavigation: DesktopNotificationTarget = {
  type: 'schedule_confirmation',
  confirmationId: 'conf-1',
  controlSessionId: 'control-1',
  sessionName: 'Control conversation',
  inboxRef: { id: 'item-conf', generation: 1 },
};

test('a new schedule confirmation names the conversation and opens that confirmation id', () => {
  const saved: DesktopAttentionRefRecord[][] = [];
  const shown: Array<{
    payload: NativeNotificationPayload;
    callbacks: Parameters<NativeNotificationDelivery['show']>[1];
  }> = [];
  const activated: unknown[] = [];
  const service = new NativeNotificationService({
    hostId: HOST_ID,
    supported: true,
    store: {
      load: () => ({ desktop: true, sound: false }),
      save: () => undefined,
    },
    refs: {
      loadRefs: () => [],
      saveRefs: refs => { saved.push(refs.map(ref => ({ ...ref }))); },
    },
    delivery: {
      show(payload, callbacks) {
        shown.push({ payload, callbacks });
        return { close() {} };
      },
    },
    onActivate: target => activated.push(target),
  });
  service.setWindowFocused(false);
  service.setContext({ visibleSessionId: null });
  assert.equal('turn' in confirmationAttention, false);
  assert.equal(service.handleAttention(confirmationAttention), true);
  assert.deepEqual(shown.map(item => item.payload), [{
    id: desktopNotificationOsId(HOST_ID, { kind: 'inbox', id: 'item-conf', generation: 1 }),
    title: 'Control conversation',
    body: 'Approval needed',
    silent: true,
  }]);
  shown[0]!.callbacks.onClick();
  assert.deepEqual(activated, [confirmationNavigation]);
  assert.equal('turn' in (activated[0] as object), false);
  const stored = saved.at(-1)?.[0];
  assert.equal(stored?.activation?.type, 'schedule_confirmation');
  if (stored?.activation?.type === 'schedule_confirmation') {
    assert.equal(stored.activation.confirmationId, 'conf-1');
    assert.equal(stored.activation.controlSessionId, 'control-1');
    assert.deepEqual(stored.activation.inboxRef, { id: 'item-conf', generation: 1 });
  }
  assert.deepEqual(deliveredInboxRead(confirmationNavigation, confirmationNavigation), {
    id: 'item-conf',
    generation: 1,
  });
  assert.equal(desktopNavigationTargetsEqual(confirmationNavigation, {
    type: 'schedule_confirmation',
    confirmationId: 'conf-1',
    controlSessionId: 'control-1',
    inboxRef: { id: 'item-conf', generation: 1 },
  }), true);
  assert.equal(desktopNavigationTargetsEqual(confirmationNavigation, {
    type: 'schedule_confirmation',
    confirmationId: 'conf-2',
    controlSessionId: 'control-1',
    inboxRef: { id: 'item-conf', generation: 1 },
  }), false);
});

test('schedule confirmation foreground suppression and withdraw use the control session and inbox ref', () => {
  const { service, shown } = fixture();
  service.setWindowFocused(true);
  service.setContext({ visibleSessionId: 'control-1' });
  assert.equal(service.handleAttention(confirmationAttention), false);
  assert.equal(shown.length, 0);

  const removed: string[] = [];
  const visible = new NativeNotificationService({
    hostId: HOST_ID,
    supported: true,
    store: {
      load: () => ({ desktop: true, sound: false }),
      save: () => undefined,
    },
    refs: { loadRefs: () => [], saveRefs: () => undefined },
    delivery: {
      show: () => ({ close() {} }),
      remove(id) {
        removed.push(id);
        return true;
      },
    },
    onActivate: () => undefined,
  });
  visible.setWindowFocused(true);
  visible.setContext({ visibleSessionId: 'other-session' });
  assert.equal(visible.handleAttention(confirmationAttention), true);
  visible.applyAttentionControl({
    type: 'attention:control',
    items: [{ id: 'item-conf', generation: 1, revision: 1, read: false, terminal: true }],
  });
  assert.deepEqual(removed, [
    desktopNotificationOsId(HOST_ID, { kind: 'inbox', id: 'item-conf', generation: 1 }),
  ]);
  assert.deepEqual(visible.attentionLookupRefs(), []);
});

test('reclaimed schedule confirmation click uses the stored confirmation id and does not show again', () => {
  const record: DesktopAttentionRefRecord = {
    hostId: HOST_ID,
    osId: 'os-conf',
    notificationId: 'note-conf',
    id: 'item-conf',
    generation: 1,
    revision: 2,
    activation: {
      type: 'schedule_confirmation',
      confirmationId: 'conf-1',
      controlSessionId: 'control-1',
      sessionName: 'Control conversation',
      inboxRef: { id: 'item-conf', generation: 1 },
    },
  };
  const activated: unknown[] = [];
  let shows = 0;
  let click: (() => void) | undefined;
  const restored = new NativeNotificationService({
    hostId: HOST_ID,
    supported: true,
    store: {
      load: () => ({ desktop: true, sound: false }),
      save: () => undefined,
    },
    refs: { loadRefs: () => [record], saveRefs: () => undefined },
    delivery: {
      show() {
        shows += 1;
        return { close() {} };
      },
      reclaim(_id, callbacks) {
        click = callbacks.onClick;
        return { close() {} };
      },
    },
    onActivate: target => activated.push(target),
  });
  assert.equal(shows, 0);
  assert.ok(click);
  click();
  assert.deepEqual(activated, [confirmationNavigation]);

  const tainted = sanitizeAttentionRefs([{
    hostId: HOST_ID,
    osId: 'os-conf',
    notificationId: 'note-conf',
    id: 'item-conf',
    generation: 1,
    revision: 2,
    activation: {
      type: 'schedule_confirmation',
      confirmationId: 'conf-1',
      controlSessionId: 'control-1',
      inboxRef: { id: 'item-conf', generation: 1 },
      turn: 3,
    },
  }]);
  assert.equal(tainted[0]?.activation, undefined);
  let forgedClick: (() => void) | undefined;
  const forgedShows: number[] = [];
  const forged = new NativeNotificationService({
    hostId: HOST_ID,
    supported: true,
    store: {
      load: () => ({ desktop: true, sound: false }),
      save: () => undefined,
    },
    refs: { loadRefs: () => tainted, saveRefs: () => undefined },
    delivery: {
      show() {
        forgedShows.push(1);
        return { close() {} };
      },
      reclaim(_id, callbacks) {
        forgedClick = callbacks.onClick;
        return { close() {} };
      },
    },
    onActivate: target => activated.push(target),
  });
  assert.deepEqual(forgedShows, []);
  forgedClick?.();
  assert.deepEqual(activated, [confirmationNavigation]);
  void forged;
});
