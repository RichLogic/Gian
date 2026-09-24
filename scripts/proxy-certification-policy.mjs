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
const protocolManagedCapabilities = new Set([
  'customization.list',
  'runtime.discover',
  'runtime.probe',
]);

export function providerCapabilityNames(capabilities) {
  return Object.keys(capabilities ?? {})
    .filter(name => !protocolManagedCapabilities.has(name))
    .sort();
}

export function resolveCatalogCandidateValue(option, configuredValue) {
  return configuredValue === '$catalog-default' ? option.defaultValue : configuredValue;
}

export function candidateProcessEnvironment(environment, selected) {
  // A canary launched from Gian must not inherit its owning Session's plugin
  // identity, data directory, broker endpoints or control credentials.
  return {
    ...Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith('GIAN_'))),
    ...selected,
  };
}

export async function runCustomizationAcceptance({ client, provider, workspace }, includeDetail = false) {
  const issues = [];
  const inventory = [];
  for (const kind of ['skill', 'mcp', 'hook', 'rule']) {
    const result = await client.request('customization.list', { kind, cwd: workspace });
    const expected = provider === 'dsh' ? 'proxy_unsupported' : 'ok';
    if (result.status !== expected) issues.push(`${kind}: expected ${expected}, received ${result.status}`);
    const evidence = { kind, status: result.status, completeness: result.completeness, count: result.items.length };
    const fixture = result.items.find(item => item.name === 'proxy-acceptance-skill');
    if (kind === 'skill' && provider !== 'dsh' && !fixture) issues.push('isolated workspace skill was not discovered');
    if (includeDetail) {
      const selected = fixture ?? result.items[0];
      if (selected) {
        const detail = await client.request('customization.detail', { kind, id: selected.id, cwd: workspace });
        evidence.detailStatus = detail.status;
        if (detail.status !== 'ok') issues.push(`${kind}: listed item detail was unavailable`);
        if (fixture && !detail.text.includes('PROXY_SKILL_OK')) issues.push('workspace skill detail lost its content');
      }
      const unknown = await client.request('customization.detail', { kind, id: `ci1_${'0'.repeat(32)}`, cwd: workspace });
      if (unknown.status !== 'unavailable') issues.push(`${kind}: unknown stable id did not fail closed`);
    }
    inventory.push(evidence);
  }
  return { status: issues.length ? 'BEHAVIOR_FAIL' : 'PASS', issues, inventory };
}

export function resolveAcceptanceConfig(catalog, defaults, overrides = {}) {
  const options = new Map(catalog.configOptions.map(option => [option.id, option]));
  const sessionConfig = {};
  const turnConfig = {};
  // The selected Agent/profile can advertise a different model menu from the
  // historical canary defaults. Validate the final explicit selection only.
  for (const [id, value] of Object.entries({ ...defaults, ...overrides })) {
    const option = options.get(id);
    if (!option) throw new Error(`Current catalog has no config option ${id}.`);
    const selectedValue = resolveCatalogCandidateValue(option, value);
    if (option.choices && !option.choices.some(choice => Object.is(choice.value, selectedValue))) {
      throw new Error(`Current catalog does not offer ${id}=${String(selectedValue)}.`);
    }
    (option.binding === 'session' ? sessionConfig : turnConfig)[id] = selectedValue;
  }
  return { sessionConfig, turnConfig };
}

export async function resolveModelDependentAcceptanceConfig(catalog, defaults, overrides, resolveCatalog) {
  const values = { ...defaults, ...overrides };
  const modelId = catalog.specialCatalogs?.model;
  const modelOption = catalog.configOptions.find(option => option.id === modelId);
  if (resolveCatalog && modelOption && values[modelId] !== undefined
    && resolveCatalogCandidateValue(modelOption, values[modelId]) !== modelOption.defaultValue) {
    const draft = { ...values };
    // Resolve the new model first: its thinking vocabulary may be on/off,
    // even while the initial catalog describes low/high/max for another model.
    delete draft[catalog.specialCatalogs?.thinking];
    const requested = resolveAcceptanceConfig(catalog, {}, draft);
    const resolved = await resolveCatalog({ catalogRevision: catalog.catalogRevision, ...requested });
    return {
      catalog: resolved,
      ...resolveAcceptanceConfig(resolved, {
        ...defaults,
        ...resolved.resolvedDefaults?.sessionConfig,
        ...resolved.resolvedDefaults?.turnConfig,
      }, overrides),
    };
  }
  return { catalog, ...resolveAcceptanceConfig(catalog, defaults, overrides) };
}

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
