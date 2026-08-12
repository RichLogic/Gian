import assert from 'node:assert/strict';
import test from 'node:test';
import { proxyNotificationSchema } from '@gian/proxy-protocol';
import { projectNotification } from '../src/event/project-notification.js';

test('protocol v1 notice.created projects to a generic display notice', () => {
  const notification = proxyNotificationSchema.parse({
    method: 'notice.created',
    params: {
      eventId: 'event-notice-1',
      streamId: 'stream-1',
      sequence: 1,
      sessionId: 'session-1',
      turnId: 'turn-1',
      emittedAt: '2026-08-10T05:30:00.000Z',
      data: {
        noticeId: 'notice-1',
        severity: 'warning',
        code: 'PROVIDER_POLICY_NOTICE',
        title: 'Action blocked',
        message: 'The provider rejected this action.',
      },
    },
  });

  const [event] = projectNotification('claude', notification, 'session-1', 1);
  assert.equal(event?.call_id, 'notice-1');
  assert.equal(event?.event, 'notice.created');
  assert.deepEqual(event?.display, {
    type: 'activity.notice',
    data: {
      severity: 'warning',
      code: 'PROVIDER_POLICY_NOTICE',
      title: 'Action blocked',
      message: 'The provider rejected this action.',
    },
  });
});
