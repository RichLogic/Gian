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

test('healthy host returns without starting another process', async () => {
  let starts = 0;
  const result = await ensureHostAvailable({
    healthUrl: 'http://gian.test/health',
    manageHost: true,
    request: healthRequest([true]),
    startHost: async () => {
      starts += 1;
    },
    sleep: async () => undefined,
    maxChecks: 3,
  });

  assert.deepEqual(result, {
    ready: true,
    checks: 1,
    startAttempted: false,
  });
  assert.equal(starts, 0);
});

test('packaged host is started once and then polled until healthy', async () => {
  let starts = 0;
  let sleeps = 0;
  const result = await ensureHostAvailable({
    healthUrl: 'http://gian.test/health',
    manageHost: true,
    request: healthRequest([false, false, true]),
    startHost: async () => {
      starts += 1;
    },
    sleep: async () => {
      sleeps += 1;
    },
    maxChecks: 4,
  });

  assert.deepEqual(result, {
    ready: true,
    checks: 3,
    startAttempted: true,
  });
  assert.equal(starts, 1);
  assert.equal(sleeps, 2);
});

test('development polling never starts the production host', async () => {
  let starts = 0;
  const result = await ensureHostAvailable({
    healthUrl: 'http://gian.test/health',
    manageHost: false,
    request: healthRequest([false]),
    startHost: async () => {
      starts += 1;
    },
    sleep: async () => undefined,
    maxChecks: 3,
  });

  assert.deepEqual(result, {
    ready: false,
    checks: 3,
    startAttempted: false,
  });
  assert.equal(starts, 0);
});

test('a noisy spawn failure does not stop health polling', async () => {
  const result = await ensureHostAvailable({
    healthUrl: 'http://gian.test/health',
    manageHost: true,
    request: healthRequest([false, true]),
    startHost: async () => {
      throw new Error('already running');
    },
    sleep: async () => undefined,
    maxChecks: 2,
  });

  assert.equal(result.ready, true);
  assert.equal(result.startAttempted, true);
});

test('managed health checks require the expected instance and send its token', async () => {
  let token = '';
  const request: HealthRequest = async (_url, init) => {
    token = init.headers['X-Gian-Desktop-Token'] ?? '';
    return {
      ok: true,
      json: async () => ({ ok: true, instanceId: 'desktop-2' }),
    };
  };

  assert.equal(
    await isHostHealthy(
      'http://gian.test/health',
      request,
      100,
      { 'X-Gian-Desktop-Token': 'secret' },
      'desktop-1',
    ),
    false,
  );
  assert.equal(token, 'secret');
  assert.equal(
    await isHostHealthy(
      'http://gian.test/health',
      request,
      100,
      { 'X-Gian-Desktop-Token': 'secret' },
      'desktop-2',
    ),
    true,
  );
});

test('desktop health negotiation rejects a missing or mismatched Host version', async () => {
  const requestWithVersion = (version?: string): HealthRequest => async () => ({
    ok: true,
    json: async () => ({ ok: true, ...(version ? { version } : {}) }),
  });

  assert.equal(
    await isHostHealthy(
      'http://gian.test/health',
      requestWithVersion(),
      100,
      {},
      undefined,
      '0.3.0',
    ),
    false,
  );
  assert.equal(
    await isHostHealthy(
      'http://gian.test/health',
      requestWithVersion('0.2.0'),
      100,
      {},
      undefined,
      '0.3.0',
    ),
    false,
  );
  assert.equal(
    await isHostHealthy(
      'http://gian.test/health',
      requestWithVersion('0.3.0'),
      100,
      {},
      undefined,
      '0.3.0',
    ),
    true,
  );
});
