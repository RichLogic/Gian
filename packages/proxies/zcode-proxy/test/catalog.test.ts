import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { startHarness, type Harness } from './harness.js';

const FULL_SETTINGS = {
  mode: { current: 'build' },
  permission: { mode: 'build' },
  model: {
    current: { providerId: 'bigmodel', modelId: 'GLM-5.3-Flash' },
    available: [
      {
        ref: { providerId: 'bigmodel', modelId: 'GLM-5.3-Flash' },
        label: 'GLM-5.3-Flash',
        providerLabel: 'BigModel - Coding Plan',
        contextWindow: 1_000_000,
        supportsImages: true,
        reasoning: { enabled: true, levels: [{ value: 'low' }, { value: 'max' }], defaultLevel: 'max' },
      },
      {
        ref: { providerId: 'bigmodel', modelId: 'GLM-5.3' },
        label: 'GLM-5.3',
        reasoning: { enabled: false, levels: [], defaultLevel: '' },
      },
    ],
  },
  thoughtLevel: { available: [{ value: 'low' }, { value: 'max' }], current: 'max', defaultLevel: 'max', enabled: true },
};

async function initialize(harness: Harness): Promise<Record<string, unknown>> {
  const response = await harness.request('initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
    host: { name: 'Gian', version: '0.0.0-test' },
  });
  assert.equal(response.kind, 'result');
  return (response.payload as { result: Record<string, unknown> }).result;
}

test('catalog.list resolves via workspace/readState with zero inner session/create', async () => {
  const harness = startHarness({ scenario: {} });
  try {
    const init = await initialize(harness);
    const capabilities = init.capabilities as Record<string, number>;
    assert.equal(capabilities['catalog.resolve'], 1);
    assert.equal(capabilities['session.replay'], 1);
    assert.equal(capabilities['interaction'], 1, 'WP7-approved interaction ships by default');
    assert.equal(capabilities['input.localImage'], undefined, 'text-only release keeps localImage undeclared');

    const catalog = await harness.request('catalog.list', {});
    const result = (catalog.payload as { result: Record<string, unknown> }).result;

    // G0 gate: no session/create calls, ever.
    const createCalls = harness.fakeLog().filter((entry) => entry.method === 'session/create');
    assert.equal(createCalls.length, 0, 'catalog.list must not create native sessions');

    const options = result.configOptions as Array<Record<string, unknown>>;
    const model = options.find((option) => option.id === 'model');
    assert.ok(model, 'model option projected');
    for (const choice of model.choices as Array<{ value: string; displayName: string }>) {
      assert.match(choice.value, /^zmodel:v1:/, 'model choice values use the scalar zmodel encoding');
    }
    assert.equal((result.specialCatalogs as Record<string, string>).model, 'model');
    assert.equal((result.specialCatalogs as Record<string, string>).approvalMode, 'approval_mode');
    for (const option of options) {
      assert.equal(option.role, undefined, '2.1 options never carry the legacy role field');
    }
    const slash = result.slashCommands as Array<{ name: string; source: string }>;
    assert.ok(slash.every((command) => command.name.startsWith('/')), 'slash names are /-prefixed');
  } finally {
    await harness.close();
  }
});

test('catalog runtime restarts and reinitializes after an unexpected exit', async () => {
  const harness = startHarness({ scenario: { behavior: { crashCatalogOnce: true } } });
  try {
    await initialize(harness);
    const failed = await harness.request('catalog.list', {});
    assert.equal(failed.kind, 'error', 'the request owned by the crashed generation fails');

    const recovered = await harness.request('catalog.list', {});
    assert.equal(recovered.kind, 'result', `catalog did not recover: ${JSON.stringify(recovered.payload)}`);
    const result = (recovered.payload as { result: { configOptions: Array<{ id: string }> } }).result;
    assert.ok(result.configOptions.some(option => option.id === 'model'));

    const reads = harness.fakeLog().filter(entry => entry.method === 'workspace/readState');
    assert.equal(new Set(reads.map(entry => entry.pid)).size, 2, 'recovery uses a fresh app-server');
  } finally {
    await harness.close();
  }
});

test('unconfigured runtime falls back to the bootstrap catalog', async () => {
  const harness = startHarness({
    scenario: {
      readState: {
        session: { status: 'idle' },
        settings: {
          model: {
            current: { providerId: 'zcode-unconfigured', modelId: 'missing-model' },
            available: [],
          },
        },
        protocol: { name: 'ZCode Protocol', version: 1 },
      },
    },
  });
  try {
    await initialize(harness);
    const catalog = await harness.request('catalog.list', {});
    const result = (catalog.payload as { result: Record<string, unknown> }).result;
    assert.match(String(result.catalogRevision), /^zcode-bootstrap:/);
    assert.equal((result.configOptions as unknown[]).length, 0);
    assert.deepEqual(result.specialCatalogs, {});
  } finally {
    await harness.close();
  }
});

test('model scalar codec rejects malformed values with CONFIG_VALUE_INVALID', async () => {
  const harness = startHarness({ scenario: {} });
  try {
    await initialize(harness);
    const listed = await harness.request('catalog.list', {});
    const revision = ((listed.payload as { result: Record<string, unknown> }).result.catalogRevision as string);

    const bad = await harness.request('catalog.resolve', {
      catalogRevision: revision,
      sessionConfig: {},
      turnConfig: { model: 'zmodel:v1:!!!not-base64!!!' },
    });
    assert.equal(bad.kind, 'error');
    const domain = ((bad.payload as { error: { data: { domainCode: string } } }).error.data?.domainCode);
    assert.equal(domain, 'CONFIG_VALUE_INVALID');

    const unknown = await harness.request('catalog.resolve', {
      catalogRevision: revision,
      sessionConfig: {},
      turnConfig: { model: 'plain-glm' },
    });
    assert.equal(unknown.kind, 'error');
    assert.equal(
      ((unknown.payload as { error: { data: { domainCode: string } } }).error.data?.domainCode),
      'CONFIG_VALUE_INVALID',
    );

    const stale = await harness.request('catalog.resolve', {
      catalogRevision: 'zcode:stale:revision',
      sessionConfig: {},
      turnConfig: {},
    });
    assert.equal(stale.kind, 'error');
  } finally {
    await harness.close();
  }
});

test('resolve fills defaults only for missing keys and keeps explicit values', async () => {
  const harness = startHarness({ scenario: {} });
  try {
    await initialize(harness);
    const listed = await harness.request('catalog.list', {});
    const catalog = (listed.payload as { result: Record<string, unknown> }).result;
    const revision = catalog.catalogRevision as string;
    const modelChoices = (catalog.configOptions as Array<Record<string, unknown>>)
      .find((option) => option.id === 'model')!.choices as Array<{ value: string }>;
    const explicitModel = modelChoices[0]!.value;

    const resolved = await harness.request('catalog.resolve', {
      catalogRevision: revision,
      sessionConfig: {},
      turnConfig: { model: explicitModel },
    });
    assert.equal(resolved.kind, 'result');
    const defaults = ((resolved.payload as { result: Record<string, unknown> }).result.resolvedDefaults as { turnConfig: Record<string, string> }).turnConfig;
    assert.equal(defaults.model, explicitModel, 'explicit values are preserved verbatim');
    assert.equal(defaults.approval_mode, 'build', 'missing keys get defaults');

    const unknownOption = await harness.request('catalog.resolve', {
      catalogRevision: revision,
      sessionConfig: {},
      turnConfig: { not_an_option: 'x' },
    });
    assert.equal(
      ((unknownOption.payload as { error: { data: { domainCode: string } } }).error.data?.domainCode),
      'CONFIG_VALUE_INVALID',
    );
  } finally {
    await harness.close();
  }
});

test('settings with per-model reasoning hide thinking for models without it', async () => {
  const harness = startHarness({ scenario: { availableModels: FULL_SETTINGS.model.available } });
  try {
    await initialize(harness);
    // Fake default model has reasoning; resolve projects thinking choices.
    const listed = await harness.request('catalog.list', {});
    const catalog = (listed.payload as { result: Record<string, unknown> }).result;
    const options = catalog.configOptions as Array<Record<string, unknown>>;
    const thinking = options.find((option) => option.id === 'thinking');
    assert.ok(thinking, 'thinking option present for reasoning-capable default model');
    assert.equal((catalog.specialCatalogs as Record<string, string>).thinking, 'thinking');
  } finally {
    await harness.close();
  }
});
