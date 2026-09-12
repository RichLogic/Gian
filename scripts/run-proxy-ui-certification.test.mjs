import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseProxyUiOptions,
  proxyUiPlan,
} from './run-proxy-ui-certification.mjs';
import { shippingProxyIds } from './build-proxy-artifacts.mjs';

test('Proxy UI certification defaults to every shipping Proxy', () => {
  const options = parseProxyUiOptions([]);
  assert.deepEqual(options.providers, shippingProxyIds);
  const plan = proxyUiPlan(options.providers);
  assert.deepEqual(plan.map(step => step.provider), options.providers);
  for (const step of plan) {
    assert.deepEqual(step.args.slice(0, 4), [
      'scripts/run-e2e.mjs',
      '--proxy-mock',
      '--proxy-provider',
      step.provider,
    ]);
  }
});

test('Proxy UI certification rejects hidden or unknown Proxies', () => {
  assert.throws(
    () => parseProxyUiOptions(['--provider', 'grok']),
    /only accepts shipping Proxies: grok/,
  );
  assert.throws(
    () => parseProxyUiOptions(['--provider', 'new-proxy']),
    /only accepts shipping Proxies: new-proxy/,
  );
});

test('Proxy UI certification accepts pnpm passthrough and a focused shipping subset', () => {
  assert.deepEqual(
    parseProxyUiOptions(['--', '--provider', 'kimi', '--provider', 'kimi']).providers,
    ['kimi'],
  );
});
