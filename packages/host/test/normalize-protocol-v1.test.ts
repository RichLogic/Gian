import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { projectProtocolV1Notification } from '../src/event/normalize-protocol-v1.js';

function v1(
  method: string,
  data: Record<string, unknown>,
  params: Record<string, unknown> = {},
) {
  return {
    method,
    params: {
      eventId: 'ev-1',
      sessionId: 'session-1',
      emittedAt: '2026-08-18T05:30:00.000Z',
      data,
      ...params,
    },
  };
}

test('projectProtocolV1Notification drops envelopes without a sessionId', () => {
  assert.deepEqual(projectProtocolV1Notification({
    method: 'diff.updated',
    params: {
      emittedAt: '2026-08-18T05:30:00.000Z',
      data: { diffId: 'd1', diff: '+++ b/a.ts\n' },
    },
  }, 'session-1', 1), []);
});

test('diff.updated extracts paths from a unified diff when files are absent', () => {
  const [event] = projectProtocolV1Notification(v1('diff.updated', {
    diffId: 'd1',
    diff: [
      '--- a/src/old.ts',
      '+++ b/src/foo.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '+++ /dev/null',
    ].join('\n'),
  }), 'session-1', 2);

  assert.equal(event?.type, 'activity.file-change');
  assert.equal(event?.call_id, 'd1');
  assert.deepEqual(event?.data.files, [{ path: 'src/foo.ts', kind: 'update' }]);
});

test('agent.updated maps running and completed statuses', () => {
  const [running] = projectProtocolV1Notification(v1('agent.updated', {
    agentId: 'a1',
    status: 'running',
    description: 'explore',
  }), 'session-1', 1);
  assert.equal(running?.type, 'agent');
  assert.equal(running?.data.status, 'running');

  const [done] = projectProtocolV1Notification(v1('agent.updated', {
    agentId: 'a1',
    status: 'completed',
    output: 'done',
  }), 'session-1', 1);
  assert.equal(done?.data.status, 'done');
});
