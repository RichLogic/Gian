import assert from 'node:assert/strict';
import test from 'node:test';

import { CordisDshHost } from '../src/cordis-host.js';

test('real Cordis host catalog projects registered providers and models', async () => {
  const host = new CordisDshHost({
    llm: {
      listProviders: () => [{ id: 'opencode-go', name: 'OpenCode Go' }],
      listModels: async () => [{
        id: 'deepseek-v4-flash',
        provider: 'opencode-go',
        name: 'DeepSeek V4 Flash',
      }],
    },
  }, '0.1.0');

  const catalog = await host.catalogList();
  assert.deepEqual(catalog.providers, [{ id: 'opencode-go', label: 'OpenCode Go' }]);
  assert.deepEqual(catalog.models, [{
    id: 'deepseek-v4-flash',
    provider: 'opencode-go',
    label: 'DeepSeek V4 Flash',
  }]);
});
