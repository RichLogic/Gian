import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { startHarness, type Harness } from './harness.js';

async function initialize(h: Harness, versions: string[]): Promise<Record<string, unknown>> {
  const response = await h.request('initialize', {
    protocol: { name: 'gian.proxy', versions },
    host: { name: 'Gian', version: '0.0.0-test' },
  });
  assert.equal(response.kind, 'result', `initialize failed: ${JSON.stringify(response)}`);
  return (response.payload as { result: Record<string, unknown> }).result;
}

test('ZCode Proxy negotiates 2.3 with customization.list and answers proxy_unsupported', async () => {
  const harness = startHarness({ scenario: {} });
  try {
    const result = await initialize(harness, ['2.3', '2.1']);
    assert.equal((result.protocol as { version: string }).version, '2.3');
    const capabilities = result.capabilities as Record<string, number>;
    assert.equal(capabilities['customization.list'], 1);

    const listed = await harness.request('customization.list', { kind: 'skill' });
    assert.equal(listed.kind, 'result', JSON.stringify(listed));
    const payload = (listed.payload as { result: {
      kind: string;
      status: string;
      completeness: string;
      items: unknown[];
      diagnostics: Array<{ code: string }>;
    } }).result;
    assert.equal(payload.kind, 'skill');
    assert.equal(payload.status, 'proxy_unsupported');
    assert.equal(payload.completeness, 'none');
    assert.deepEqual(payload.items, []);
    assert.equal(payload.diagnostics[0]!.code, 'SOURCE_NOT_ENUMERABLE');

    const detail = await harness.request('customization.detail', {
      kind: 'skill',
      id: 'ci1_' + 'a'.repeat(32),
    });
    assert.equal(detail.kind, 'result');
    const detailResult = (detail.payload as { result: { status: string; text: string } }).result;
    assert.equal(detailResult.status, 'unavailable');
    assert.equal(detailResult.text, '');

    await harness.request('shutdown', {});
  } finally {
    harness.close?.();
  }
});

test('ZCode Proxy downgrades to 2.1 without customization when 2.3 is not offered', async () => {
  const harness = startHarness({ scenario: {} });
  try {
    const result = await initialize(harness, ['2.1', '2.0']);
    assert.equal((result.protocol as { version: string }).version, '2.1');
    const capabilities = result.capabilities as Record<string, number>;
    assert.equal(capabilities['customization.list'], undefined);
    await harness.request('shutdown', {});
  } finally {
    harness.close?.();
  }
});
