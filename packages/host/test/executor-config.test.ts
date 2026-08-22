import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { NativeConfigOption } from '@gian/shared';

import { executorConfigFromOptions } from '../src/session/repository.js';

function option(
  overrides: Pick<NativeConfigOption, 'id' | 'scope' | 'currentValue'>,
): NativeConfigOption {
  return {
    name: overrides.id,
    type: 'text',
    ...overrides,
  };
}

test('executorConfigFromOptions keeps only session-scoped values', () => {
  assert.deepEqual(executorConfigFromOptions([]), {
    schemaVersion: 1,
    values: {},
  });

  assert.deepEqual(executorConfigFromOptions([
    option({ id: 'model', scope: 'session', currentValue: 'sonnet' }),
    option({ id: 'effort', scope: 'turn', currentValue: 'high' }),
    option({ id: 'thinking', scope: 'session', currentValue: true }),
  ]), {
    schemaVersion: 1,
    values: {
      model: 'sonnet',
      thinking: true,
    },
  });
});
