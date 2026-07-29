import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ensureHostAvailable,
  isHostHealthy,
  type HealthRequest,
} from '../src/host-service.js';

function healthRequest(values: boolean[]): HealthRequest {
  let index = 0;
  return async () => {
    const healthy = values[Math.min(index, values.length - 1)] ?? false;
    index += 1;
    return {
      ok: true,
      json: async () => ({ ok: healthy }),
    };
  };
}

test('health probe requires the Gian JSON health shape', async () => {
  assert.equal(await isHostHealthy('http://gian.test/health', healthRequest([true])), true);
  assert.equal(await isHostHealthy('http://gian.test/health', healthRequest([false])), false);
  assert.equal(
    await isHostHealthy('http://gian.test/health', async () => ({
      ok: true,
      json: async () => ({ status: 'ok' }),
    })),
    false,
  );
});

test('healthy host returns without touching launchd', async () => {
  let kickstarts = 0;
  const result = await ensureHostAvailable({
    healthUrl: 'http://gian.test/health',
    manageLaunchAgent: true,
    request: healthRequest([true]),
    kickstart: async () => {
      kickstarts += 1;
    },
    sleep: async () => undefined,
    maxChecks: 3,
  });

  assert.deepEqual(result, {
    ready: true,
    checks: 1,
    kickstartAttempted: false,
  });
  assert.equal(kickstarts, 0);
});

test('packaged host is kicked once and then polled until healthy', async () => {
  let kickstarts = 0;
  let sleeps = 0;
  const result = await ensureHostAvailable({
    healthUrl: 'http://gian.test/health',
    manageLaunchAgent: true,
    request: healthRequest([false, false, true]),
    kickstart: async () => {
      kickstarts += 1;
    },
    sleep: async () => {
      sleeps += 1;
    },
    maxChecks: 4,
  });

  assert.deepEqual(result, {
    ready: true,
    checks: 3,
    kickstartAttempted: true,
  });
  assert.equal(kickstarts, 1);
  assert.equal(sleeps, 2);
});

test('development polling never manages the production launch agent', async () => {
  let kickstarts = 0;
  const result = await ensureHostAvailable({
    healthUrl: 'http://gian.test/health',
    manageLaunchAgent: false,
    request: healthRequest([false]),
    kickstart: async () => {
      kickstarts += 1;
    },
    sleep: async () => undefined,
    maxChecks: 3,
  });

  assert.deepEqual(result, {
    ready: false,
    checks: 3,
    kickstartAttempted: false,
  });
  assert.equal(kickstarts, 0);
});

test('a noisy launchctl failure does not stop health polling', async () => {
  const result = await ensureHostAvailable({
    healthUrl: 'http://gian.test/health',
    manageLaunchAgent: true,
    request: healthRequest([false, true]),
    kickstart: async () => {
      throw new Error('already running');
    },
    sleep: async () => undefined,
    maxChecks: 2,
  });

  assert.equal(result.ready, true);
  assert.equal(result.kickstartAttempted, true);
});
