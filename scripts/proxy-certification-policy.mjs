const deterministicOnlyTriggers = new Set([
  'fault_fixture',
  'external_fixture',
  'real_or_contract',
]);
const deterministicOnlyScenarios = new Set(['transport.invalid_frames']);
const realNotApplicableStatuses = new Set([
  'unsupported',
  'contract_only',
  'fake_only',
  'catalog_only',
  'policy_blocked',
]);
const realOptionalStatuses = new Set(['conditional']);

export function realScenarioRequirement(scenario, provider) {
  const providerStatus = scenario.providers[provider];
  if (deterministicOnlyTriggers.has(scenario.trigger)
    || deterministicOnlyScenarios.has(scenario.id)
    || realNotApplicableStatuses.has(providerStatus)) {
    return 'not_applicable';
  }
  if (realOptionalStatuses.has(providerStatus)) return 'optional';
  return 'required';
}

export function finalizeProviderScenarioResults(provider, scenarios, results) {
  const byScenario = new Map(results.map(result => [result.scenarioId, result]));
  const completed = [...results];
  for (const scenario of scenarios) {
    if (byScenario.has(scenario.id)) continue;
    const requirement = realScenarioRequirement(scenario, provider);
    completed.push({
      scenarioId: scenario.id,
      status: requirement === 'not_applicable'
        ? 'NOT_APPLICABLE'
        : requirement === 'optional'
          ? 'NOT_OBSERVED'
          : 'BLOCKED',
      requirement,
      issues: requirement === 'required'
        ? ['required real Provider scenario has no executed handler result']
        : [],
    });
  }
  const failed = completed.some(result => (
    result.status === 'SCHEMA_FAIL'
    || result.status === 'BEHAVIOR_FAIL'
  ));
  const blocked = completed.some(result => {
    const scenario = scenarios.find(candidate => candidate.id === result.scenarioId);
    return scenario
      && realScenarioRequirement(scenario, provider) === 'required'
      && result.status !== 'PASS';
  });
  return {
    results: completed,
    status: failed ? 'FAIL' : blocked ? 'BLOCKED' : 'PASS',
  };
}
