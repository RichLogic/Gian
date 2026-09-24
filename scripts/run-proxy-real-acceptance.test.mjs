import assert from 'node:assert/strict';
import test from 'node:test';

import {
  finalizeProviderScenarioResults,
  providerCapabilityNames,
  realScenarioRequirement,
  resolveCatalogCandidateValue,
  resolveAcceptanceConfig,
  resolveModelDependentAcceptanceConfig,
  candidateProcessEnvironment,
  runCustomizationAcceptance,
} from './proxy-certification-policy.mjs';

function scenario(id, trigger, status) {
  return { id, trigger, providers: { codex: status } };
}

test('Customization acceptance exercises all kinds, listed details and missing ids without turns', async () => {
  const calls = [];
  const client = { async request(method, params) {
    calls.push(method);
    if (method === 'customization.list') return { status: 'ok', completeness: 'configured', items: params.kind === 'skill'
      ? [{ id: 'fixture', name: 'proxy-acceptance-skill' }] : [] };
    return params.id === 'fixture' ? { status: 'ok', text: 'PROXY_SKILL_OK' } : { status: 'unavailable' };
  } };
  const result = await runCustomizationAcceptance({ client, provider: 'kimi', workspace: '/fixture' }, true);
  assert.equal(result.status, 'PASS');
  assert.equal(result.inventory.length, 4);
  assert.equal(calls.filter(method => method === 'customization.detail').length, 5);
  assert.ok(calls.every(method => method.startsWith('customization.')));
});

test('Customization acceptance distinguishes unsupported DSH from missing supported inventory', async () => {
  const client = { async request() { return { status: 'proxy_unsupported', completeness: 'none', items: [] }; } };
  assert.equal((await runCustomizationAcceptance({ client, provider: 'dsh' })).status, 'PASS');
  assert.equal((await runCustomizationAcceptance({ client, provider: 'claude' })).status, 'BEHAVIOR_FAIL');
});

test('candidate processes use their own identity and never inherit the calling Gian Session', () => {
  assert.deepEqual(candidateProcessEnvironment({
    HOME: '/test/home', PATH: '/bin', GIAN_PLUGIN_ID: 'codex',
    GIAN_PLUGIN_DATA_DIR: '/production/data', GIAN_TOOL_TOKEN: 'fake-parent-secret',
  }, { GIAN_PLUGIN_ID: 'com.zhipu.zcode', GIAN_PLUGIN_DATA_DIR: '/test/data' }), {
    HOME: '/test/home', PATH: '/bin', GIAN_PLUGIN_ID: 'com.zhipu.zcode', GIAN_PLUGIN_DATA_DIR: '/test/data',
  });
});

test('explicit model selection replaces a stale default before catalog validation', () => {
  const catalog = { configOptions: [
    { id: 'model', binding: 'turn', choices: [{ value: 'glm-flash' }] },
    { id: 'effort', binding: 'turn', choices: [{ value: 'low' }] },
  ] };
  assert.deepEqual(resolveAcceptanceConfig(catalog,
    { model: 'removed-deepseek-alias', effort: 'low' }, { model: 'glm-flash' }), {
    sessionConfig: {}, turnConfig: { model: 'glm-flash', effort: 'low' },
  });
  assert.throws(() => resolveAcceptanceConfig(catalog, {}, { model: 'unknown' }), /does not offer/);
  assert.throws(() => resolveAcceptanceConfig(catalog, {}, { invented: 'low' }), /no config option/);
});

test('real candidate thinking is validated after resolving the selected model', async () => {
  const catalog = {
    catalogRevision: 'k3', specialCatalogs: { model: 'model', thinking: 'thinking' },
    configOptions: [
      { id: 'model', binding: 'turn', defaultValue: 'k3', choices: [{ value: 'k3' }, { value: 'k2.7' }] },
      { id: 'thinking', binding: 'turn', defaultValue: 'high', choices: [{ value: 'low' }, { value: 'high' }] },
    ],
  };
  const result = await resolveModelDependentAcceptanceConfig(catalog, { model: 'k3' },
    { model: 'k2.7', thinking: 'off' }, async request => {
      assert.deepEqual(request, { catalogRevision: 'k3', sessionConfig: {}, turnConfig: { model: 'k2.7' } });
      return { ...catalog, configOptions: [catalog.configOptions[0],
        { id: 'thinking', binding: 'turn', choices: [{ value: 'off' }, { value: 'on' }] },
      ] };
    });
  assert.deepEqual(result.turnConfig, { model: 'k2.7', thinking: 'off' });
});

test('real Provider completion fails closed for a missing required handler', () => {
  const scenarios = [scenario('turn.basic', 'real_prompt', 'required')];
  const finalized = finalizeProviderScenarioResults('codex', scenarios, []);
  assert.equal(finalized.status, 'BLOCKED');
  assert.deepEqual(finalized.results, [{
    scenarioId: 'turn.basic',
    status: 'BLOCKED',
    requirement: 'required',
    issues: ['required real Provider scenario has no executed handler result'],
  }]);
});

test('deterministic-only and unsupported scenarios are explicit but do not fake real evidence', () => {
  const scenarios = [
    scenario('transport.invalid_frames', 'control', 'required'),
    scenario('activity.notice_unknown', 'fault_fixture', 'fake_only'),
    scenario('control.steer', 'real_control', 'unsupported'),
  ];
  for (const item of scenarios) {
    assert.equal(realScenarioRequirement(item, 'codex'), 'not_applicable');
  }
  const finalized = finalizeProviderScenarioResults('codex', scenarios, []);
  assert.equal(finalized.status, 'PASS');
  assert.ok(finalized.results.every(result => result.status === 'NOT_APPLICABLE'));
});

test('required real evidence accepts only PASS', () => {
  const scenarios = [scenario('control.interrupt', 'real_control', 'required')];
  assert.equal(finalizeProviderScenarioResults('codex', scenarios, [{
    scenarioId: 'control.interrupt',
    status: 'UNOBSERVED',
  }]).status, 'BLOCKED');
  assert.equal(finalizeProviderScenarioResults('codex', scenarios, [{
    scenarioId: 'control.interrupt',
    status: 'PASS',
  }]).status, 'PASS');
});

test('provider capability comparison excludes only protocol-managed control capabilities', () => {
  assert.deepEqual(providerCapabilityNames({
    'runtime.discover': 1,
    'runtime.probe': 1,
    'customization.list': 1,
    'catalog.resolve': 1,
    interaction: 1,
  }), ['catalog.resolve', 'interaction']);
  assert.deepEqual(providerCapabilityNames({
    'integration.mcp.streamableHttp': 1,
  }), ['integration.mcp.streamableHttp']);
});

test('real Provider candidate config resolves explicit Catalog defaults at runtime', () => {
  assert.equal(resolveCatalogCandidateValue({ defaultValue: 'workspace-write' }, '$catalog-default'), 'workspace-write');
  assert.equal(resolveCatalogCandidateValue({ defaultValue: 'workspace-write' }, 'read-only'), 'read-only');
});
