import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  catalogChoiceDowngradeWarning,
  catalogProbeEnv,
  droppedCatalogChoice,
  supportedCatalogChoice,
} from '../src/session/proxy-session-coordinator.js';

test('a model id missing from the catalog is reported when it is not kept', () => {
  const choices = [{ value: 'claude-default' }, { value: 'claude-alias-sonnet' }];
  assert.equal(
    droppedCatalogChoice(choices, ['retired-opus', 'retired-opus'], 'claude-default'),
    'retired-opus',
  );
  assert.equal(
    catalogChoiceDowngradeWarning('sess-1', 'model', 'retired-opus', 'claude-default'),
    '[session] sess-1 catalog option model dropped "retired-opus"; using "claude-default".',
  );
});

test('a persisted model missing from the catalog is dropped before the default is used', () => {
  const choices = [{ value: 'claude-default' }, { value: 'claude-alias-sonnet' }];
  const persisted = supportedCatalogChoice(choices, 'retired-opus');
  const used = persisted ?? 'claude-default';
  assert.equal(persisted, undefined);
  assert.equal(droppedCatalogChoice(choices, ['retired-opus'], used), 'retired-opus');
  assert.equal(supportedCatalogChoice(undefined, 'retired-opus'), 'retired-opus');
});

test('catalog probe env maps dsh and zcode aliases before reading the home', () => {
  assert.deepEqual(catalogProbeEnv('dsh', '/tmp/dsh-home'), {
    GIAN_AGENT_HOME: '/tmp/dsh-home',
    DSH_HOME: '/tmp/dsh-home',
  });
  assert.deepEqual(catalogProbeEnv('zcode', '/tmp/zcode-home/.zcode'), {
    GIAN_AGENT_HOME: '/tmp/zcode-home/.zcode',
    HOME: '/tmp/zcode-home',
  });
  assert.equal(catalogProbeEnv('claude', null), undefined);
});

test('a catalog value that is still used is not a downgrade', () => {
  const choices = [{ value: 'claude-default' }];
  assert.equal(droppedCatalogChoice(choices, ['retired-opus'], 'retired-opus'), undefined);
  assert.equal(droppedCatalogChoice(choices, ['claude-default'], 'claude-default'), undefined);
  assert.equal(droppedCatalogChoice(undefined, ['retired-opus'], 'claude-default'), undefined);
  assert.equal(droppedCatalogChoice(choices, [null, '', 'claude-default'], 'claude-default'), undefined);
});
