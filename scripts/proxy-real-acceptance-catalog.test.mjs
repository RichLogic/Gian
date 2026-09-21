import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  loadProxyRealAcceptanceCatalog,
  resolveAcceptanceTargets,
  renderProxyRealAcceptanceHtml,
  validateProxyRealAcceptanceCatalog,
} from './proxy-real-acceptance-catalog.mjs';
import {
  concurrencyHoldStrategy,
  configuredProviderBinary,
  reasoningExpectedFor,
  verifyWorkspaceToolOutcome,
} from './run-proxy-real-acceptance.mjs';

test('scenario templates follow the selected source version without overwriting explicit pins or claiming execution', () => {
  const template = { providers: { kimi: { displayName: 'Kimi' } }, scenarios: [] };
  const first = resolveAcceptanceTargets(template, [{ id: 'kimi', pluginVersion: '0.3.1' }]);
  const next = resolveAcceptanceTargets(template, [{ id: 'kimi', pluginVersion: '0.3.2' }]);
  assert.equal(first.providers.kimi.pluginVersion, '0.3.1');
  assert.equal(next.providers.kimi.pluginVersion, '0.3.2');
  assert.equal(template.providers.kimi.pluginVersion, undefined);
  assert.equal(next.status, undefined);
  const pinned = resolveAcceptanceTargets({
    providers: { kimi: { pluginVersion: '99.0.0' } },
  }, [{ id: 'kimi', pluginVersion: '0.3.2' }]);
  assert.equal(pinned.providers.kimi.pluginVersion, '99.0.0');
});

test('real Proxy catalog covers every request and notification schema', async () => {
  const catalog = await loadProxyRealAcceptanceCatalog();
  assert.equal(validateProxyRealAcceptanceCatalog(catalog), catalog);
  assert.ok(catalog.scenarios.length >= 25);
  assert.deepEqual(
    Object.keys(catalog.providers).sort(),
    ['claude', 'codex', 'dsh', 'grok', 'kimi', 'zcode'],
  );
  assert.equal(catalog.providers.codex.cheapestConfig.service_tier, false);
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

test('optional real notifications must remain declared in their scenario', async () => {
  const catalog = structuredClone(await loadProxyRealAcceptanceCatalog());
  const basic = catalog.scenarios.find(scenario => scenario.id === 'turn.basic_content_reasoning_usage');
  basic.optionalNotifications = ['history.changed'];
  assert.throws(
    () => validateProxyRealAcceptanceCatalog(catalog),
    /marks history\.changed optional without declaring it/,
  );
});

test('certification catalog fails closed when package or shipping inventory drifts', async () => {
  const missing = structuredClone(await loadProxyRealAcceptanceCatalog());
  delete missing.providers.dsh;
  assert.throws(
    () => validateProxyRealAcceptanceCatalog(missing),
    /must match every Proxy definition exactly/,
  );

  const stale = structuredClone(await loadProxyRealAcceptanceCatalog());
  stale.providers.codex.pluginVersion = '99.0.0';
  assert.throws(
    () => validateProxyRealAcceptanceCatalog(stale),
    /does not match package/,
  );
});

test('real Proxy runner lets an explicit latest DSH binary override the catalog fixture path', () => {
  assert.equal(
    configuredProviderBinary('dsh', { binary: 'packages/old/dsh' }, {
      DSH_BIN: '/managed/latest/node_modules/.bin/dsh',
    }),
    '/managed/latest/node_modules/.bin/dsh',
  );
});

test('real Proxy workspace-tool evidence requires the final marker and deleted obsolete file', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'gian-real-proxy-tools-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, 'final.txt'), 'TOOL_FLOW_OK\n');
  assert.deepEqual(await verifyWorkspaceToolOutcome(workspace), {
    ok: true,
    finalMarker: 'TOOL_FLOW_OK',
    obsoleteMissing: true,
  });
  await writeFile(join(workspace, 'obsolete.txt'), 'still here');
  assert.equal((await verifyWorkspaceToolOutcome(workspace)).ok, false);
});

test('real Proxy concurrency uses a running activity when interaction is not advertised', () => {
  assert.equal(concurrencyHoldStrategy({ capabilities: ['event.step'] }), 'running_activity');
  assert.equal(concurrencyHoldStrategy({ capabilities: ['interaction'] }), 'interaction');
});

test('real Proxy reasoning expectation respects a resolved Off effort', () => {
  const catalog = { specialCatalogs: { thinking: 'effort' } };
  assert.equal(reasoningExpectedFor(catalog, { effort: 'off' }), false);
  assert.equal(reasoningExpectedFor(catalog, { effort: 'high' }), true);
  assert.equal(reasoningExpectedFor({ specialCatalogs: {} }, {}), false);
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
