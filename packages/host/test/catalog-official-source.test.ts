import { createPublicKey } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { compileOfficialCatalogSource, ephemeralCatalogSigningKey } from '@gian/proxy-catalog-contract';

import { CatalogService } from '../src/catalog/service.js';
import { CatalogStore } from '../src/catalog/store.js';
import { PluginStore } from '../src/plugin-store/store.js';

function officialSourceRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const fromHost = join(here, '../../../catalog/official-source');
  return existsSync(fromHost) ? fromHost : join(here, '../../../../catalog/official-source');
}

test('official source sidecars project external Runtime and CatalogService reports setup_required', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gian-official-source-service-'));
  try {
    const signingKey = ephemeralCatalogSigningKey();
    const bundle = await compileOfficialCatalogSource({
      sourceRoot: officialSourceRoot(),
      sequence: 1,
      issuedAt: '2026-09-03T00:00:00.000Z',
      signingKey,
    });
    assert.equal(bundle.index.plugins.length, 5);
    for (const plugin of bundle.index.plugins) {
      assert.equal(plugin.stable.runtime?.kind, 'external');
    }
    const policy = {
      sourceId: 'gian-official' as const,
      repository: 'RichLogic/Gian',
      artifactRepositories: ['RichLogic/Gian'],
      pinnedPublicKeys: {
        [signingKey.keyId]: createPublicKey(signingKey.privateKey)
          .export({ type: 'spki', format: 'der' })
          .subarray(-32)
          .toString('hex'),
      },
    };
    const store = new CatalogStore({ rootDir: root, policy });
    await store.ingest(bundle.files, '"official-1"');
    const service = new CatalogService({
      store,
      plugins: new PluginStore({
        dataDir: root,
        pluginsDir: join(root, 'plugins'),
        network: { async download() { throw new Error('unused'); } },
        allowedArtifactRepositories: ['RichLogic/Gian'],
        hostVersion: '0.1.0',
      }),
      policy,
    });
    const list = await service.list();
    assert.equal(list.items.length, 5);
    for (const item of list.items) {
      assert.equal(item.runtime.state, 'setup_required');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
