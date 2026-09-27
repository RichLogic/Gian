/** Regression: the version-gated `catalog.modeSemantics` increment.
 *
 *  - `configOptionSchema` accepts the additive `modeKind` discriminator;
 *  - unknown fields still fail (strict contract, no silent env/command
 *    channels);
 *  - old Proxies (no modeKind) keep parsing unchanged (compat). */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  configOptionSchema,
  catalogResultSchema,
} from '../src/schemas.js';

function baseOption(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'mode',
    displayName: 'Mode',
    binding: 'turn',
    role: 'approval_mode',
    control: 'select',
    required: true,
    defaultValue: 'ask',
    choices: [
      { value: 'ask', displayName: 'Ask' },
      { value: 'code', displayName: 'Code' },
    ],
    ...overrides,
  };
}

test('configOption accepts modeKind gian-preset and provider-native', () => {
  const preset = configOptionSchema.parse(baseOption({ modeKind: 'gian-preset' }));
  assert.equal(preset.modeKind, 'gian-preset');
  const native = configOptionSchema.parse(baseOption({ modeKind: 'provider-native', binding: 'session' }));
  assert.equal(native.modeKind, 'provider-native');
});

test('configOption still parses without modeKind (Proxies below the gate)', () => {
  const option = configOptionSchema.parse(baseOption());
  assert.equal(option.modeKind, undefined);
});

test('modeKind only allows the two semantic values', () => {
  assert.throws(() => configOptionSchema.parse(baseOption({ modeKind: 'verbatim' })));
  assert.throws(() => configOptionSchema.parse(baseOption({ modeKind: 1 })));
});

test('strict contract: env/command channels cannot ride a config option', () => {
  assert.throws(() => configOptionSchema.parse(baseOption({ env: [{ name: 'GROK_HOME', value: '/x' }] })));
  assert.throws(() => configOptionSchema.parse(baseOption({ command: 'rm -rf /' })));
  assert.throws(() => configOptionSchema.parse(baseOption({ exec: '/bin/sh' })));
});

test('catalog.list schema round-trips modeKind options end to end', () => {
  const list = {
    catalogRevision: 'rev-1',
    input: [{ type: 'text' }],
    configOptions: [baseOption({ modeKind: 'provider-native' })],
    specialCatalogs: { approvalMode: 'mode' },
    actions: [],
    slashCommands: [],
  };
  const parsed = catalogResultSchema.parse(list);
  assert.equal(parsed.configOptions[0]?.modeKind, 'provider-native');
  assert.throws(() => catalogResultSchema.parse({
    ...list,
    configOptions: [baseOption({ env: [{ name: 'X', value: 'Y' }] })],
  }));
});
