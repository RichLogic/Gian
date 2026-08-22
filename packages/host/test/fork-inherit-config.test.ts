import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { ConfigOption } from '@gian/shared';
import { inheritedSessionBoundConfig } from '../src/session/fork.js';

function option(id: string, binding: ConfigOption['binding']): ConfigOption {
  return {
    id,
    displayName: id,
    binding,
    control: 'text',
    required: false,
    defaultValue: null,
  };
}

test('inheritedSessionBoundConfig keeps session-bound and unknown values', () => {
  const inherited = inheritedSessionBoundConfig(
    [option('mode', 'session'), option('model', 'session')],
    { mode: 'ask', model: 'gpt-5', extra: 'keep' },
  );
  assert.deepEqual(inherited, { mode: 'ask', model: 'gpt-5', extra: 'keep' });
});

test('inheritedSessionBoundConfig rejects a turn-bound advertised option', () => {
  assert.throws(
    () => inheritedSessionBoundConfig(
      [option('vision', 'turn')],
      { vision: true },
    ),
    /CONFIG_BINDING_INVALID|turn-bound/i,
  );
});

test('inheritedSessionBoundConfig returns an empty object for empty values', () => {
  assert.deepEqual(inheritedSessionBoundConfig([option('mode', 'session')], {}), {});
});
