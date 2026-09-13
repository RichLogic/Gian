import assert from 'node:assert/strict';
import test from 'node:test';

import {
  finalizeProviderScenarioResults,
  providerCapabilityNames,
  realScenarioRequirement,
  resolveCatalogCandidateValue,
} from './proxy-certification-policy.mjs';

function scenario(id, trigger, status) {
  return { id, trigger, providers: { codex: status } };
}

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
