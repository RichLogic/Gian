import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadProxyRealAcceptanceCatalog,
  renderProxyRealAcceptanceHtml,
  validateProxyRealAcceptanceCatalog,
} from './proxy-real-acceptance-catalog.mjs';

test('real Proxy catalog covers every request and notification schema', async () => {
  const catalog = await loadProxyRealAcceptanceCatalog();
  assert.equal(validateProxyRealAcceptanceCatalog(catalog), catalog);
  assert.ok(catalog.scenarios.length >= 25);
  assert.deepEqual(Object.keys(catalog.providers).sort(), ['claude', 'codex', 'dsh', 'grok', 'kimi']);
});

test('real Proxy catalog rejects a missing provider classification', async () => {
  const catalog = structuredClone(await loadProxyRealAcceptanceCatalog());
  delete catalog.scenarios[0].providers.grok;
  assert.throws(
    () => validateProxyRealAcceptanceCatalog(catalog),
    /must classify every provider/,
  );
});

test('real Proxy catalog rejects incomplete notification coverage', async () => {
  const catalog = structuredClone(await loadProxyRealAcceptanceCatalog());
  for (const scenario of catalog.scenarios) {
    scenario.notifications = scenario.notifications.filter(method => method !== 'request.updated');
  }
  assert.throws(
    () => validateProxyRealAcceptanceCatalog(catalog),
    /missing notification\(s\): request\.updated/,
  );
});

test('HTML report exposes scenarios, prompts and expected schemas', async () => {
  const catalog = await loadProxyRealAcceptanceCatalog();
  const html = renderProxyRealAcceptanceHtml(catalog);
  assert.match(html, /activity\.workspace_tools/);
  assert.match(html, /Perform every step using tools/);
  assert.match(html, /Expected Notification Schema/);
  assert.match(html, /request\.updated/);
  assert.match(html, /GPT-5\.6-Luna|Codex/);
});
