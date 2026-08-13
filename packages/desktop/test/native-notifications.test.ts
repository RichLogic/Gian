import assert from 'node:assert/strict';
import test from 'node:test';
import type { AttentionMessage } from '@gian/shared';
import {
  DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES,
  NativeNotificationService,
  type DesktopNotificationPreferences,
  type NativeNotificationDelivery,
  type NativeNotificationPayload,
} from '../src/native-notifications.js';

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
    service.setContext({ windowFocused: false, visibleSessionId: null });
  }
  return { service, shown, activated, saved: () => saved, closed: () => closed };
}

test('notifies in the background, dedupes, and preserves a safe click target', () => {
  const { service, shown, activated, closed } = fixture();
  assert.equal(service.handleAttention(attention), true);
  assert.equal(service.handleAttention(attention), false);
  assert.deepEqual(shown.map(item => item.payload), [{
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

test('suppresses only the session currently visible in a focused window', () => {
  const { service, shown } = fixture();
  service.setContext({ windowFocused: true, visibleSessionId: 's1' });
  assert.equal(service.handleAttention(attention), false);
  assert.equal(service.handleAttention({ ...attention, id: 'other', session_id: 's2' }), true);
  assert.equal(shown.length, 1);
});

test('waits for first renderer visibility context before deciding foreground delivery', () => {
  const { service, shown } = fixture(undefined, false);
  assert.equal(service.handleAttention(attention), false);
  assert.equal(shown.length, 0);
  service.setContext({ windowFocused: true, visibleSessionId: 's1' });
  assert.equal(shown.length, 0);

  const background = { ...attention, id: 'background', session_id: 's2' };
  const next = fixture(undefined, false);
  assert.equal(next.service.handleAttention(background), false);
  next.service.setContext({ windowFocused: true, visibleSessionId: 's1' });
  assert.equal(next.shown.length, 1);
});

test('rechecks consent before flushing attention queued during renderer startup', () => {
  const master = fixture(undefined, false);
  assert.equal(master.service.handleAttention(attention), false);
  master.service.updatePreferences({ desktop: false });
  master.service.setContext({ windowFocused: false, visibleSessionId: null });
  assert.equal(master.shown.length, 0);

  const category = fixture(undefined, false);
  assert.equal(category.service.handleAttention(attention), false);
  category.service.updatePreferences({ sessionDone: false });
  category.service.setContext({ windowFocused: false, visibleSessionId: null });
  assert.equal(category.shown.length, 0);
});

test('reset context defers suppression decisions across a renderer reload', () => {
  const { service, shown } = fixture();
  service.setContext({ windowFocused: true, visibleSessionId: 's1' });
  service.resetContext();
  assert.equal(service.handleAttention(attention), false);
  assert.equal(shown.length, 0);
  service.setContext({ windowFocused: false, visibleSessionId: null });
  assert.equal(shown.length, 1);
});

test('event preferences and master switch are enforced and persisted', () => {
  const { service, shown, saved } = fixture();
  const state = service.updatePreferences({
    desktop: true,
    sessionDone: false,
    approvalNeeded: true,
    errors: false,
    sound: true,
  });
  assert.deepEqual(saved(), state.preferences);
  assert.equal(service.handleAttention(attention), false);
  assert.equal(service.handleAttention({ ...attention, id: 'approval', kind: 'approval' }), true);
  assert.equal(shown[0]!.payload.silent, false);
  service.updatePreferences({ desktop: false });
  assert.equal(service.handleAttention({ ...attention, id: 'question', kind: 'question' }), false);
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
  service.setContext({ windowFocused: false, visibleSessionId: null });

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
