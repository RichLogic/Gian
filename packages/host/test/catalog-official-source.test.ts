import { createPublicKey } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { compileOfficialCatalogSource, ephemeralCatalogSigningKey, parseGitHubReleaseAssetUrl, isApprovedRuntimeAssetUrl } from '@gian/proxy-catalog-contract';
import { officialCatalogSourcePolicy, OFFICIAL_PROXY_REPOSITORY } from '@gian/shared';

import { CatalogService } from '../src/catalog/service.js';
import { CatalogStore } from '../src/catalog/store.js';
import { PluginStore } from '../src/plugin-store/store.js';

function officialSourceRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const fromHost = join(here, '../../../catalog/official-source');
  return existsSync(fromHost) ? fromHost : join(here, '../../../../catalog/official-source');
}

test('official source moves to Gian-Proxies without rotating identity, signing key or retained artifact trust', () => {
  const policy = officialCatalogSourcePolicy();
  assert.equal(OFFICIAL_PROXY_REPOSITORY, 'RichLogic/Gian-Proxies');
  assert.equal(policy.repository, OFFICIAL_PROXY_REPOSITORY);
  assert.equal(policy.sourceId, 'gian-official');
  assert.deepEqual(policy.pinnedPublicKeys, {
    'gian-official-catalog-2026-09': '8721796e6bdf8798804745396bd2181cd999f261d077f09a6fdaa180091344df',
  });
  for (const repository of ['RichLogic/Gian-Proxies', 'RichLogic/Gian']) {
    const url = `https://github.com/${repository}/releases/download/proxy-dsh-v0.3.1/runtime.tar.gz`;
    assert.equal(parseGitHubReleaseAssetUrl(url, policy.artifactRepositories)?.repository, repository);
    assert.equal(isApprovedRuntimeAssetUrl(url, policy.runtimeAssetPrefixes!), true);
  }
  assert.equal(parseGitHubReleaseAssetUrl('https://github.com/untrusted/Gian-Proxies/releases/download/proxy-dsh-v0.3.1/runtime.tar.gz', policy.artifactRepositories), null);
});

test('official source sidecars project external Runtime and CatalogService reports setup_required', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gian-official-source-service-'));
  try {
    const signingKey = ephemeralCatalogSigningKey();
    const englishDocs = { overview: '# English history', setup: '# English setup', usage: '# English usage', troubleshooting: '# English help' };
    const chineseDocs = { overview: '# 中文日志', setup: '# 中文安装', usage: '# 中文使用', troubleshooting: '# 中文排障' };
    const bundle = await compileOfficialCatalogSource({
      sourceRoot: officialSourceRoot(),
      sequence: 1,
      issuedAt: '2026-09-03T00:00:00.000Z',
      signingKey,
      localizations: { codex: {
        en: { displayName: 'Codex', tagline: 'English summary', documents: englishDocs },
        'zh-CN': { displayName: 'Codex', tagline: '中文简介', documents: chineseDocs },
      } },
    });
    assert.equal(bundle.index.plugins.length, 5);
    for (const plugin of bundle.index.plugins) {
      assert.equal(plugin.stable.runtime?.kind, 'external');
    }
    const policy = {
      sourceId: 'gian-official' as const,
      repository: 'RichLogic/Gian-Proxy-Catalog',
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
    const codex = list.items.find(item => item.pluginId === 'codex')!;
    assert.equal(codex.localizations?.en?.tagline, 'English summary');
    assert.equal(codex.localizations?.['zh-CN']?.tagline, '中文简介');
    assert.equal(codex.localizations?.en?.documentation.overview, '/api/proxies/codex/docs/overview?locale=en');
    assert.equal((await service.documentation('codex', 'overview', 'en'))?.bytes.toString(), englishDocs.overview);
    assert.equal((await service.documentation('codex', 'overview', 'zh-CN'))?.bytes.toString(), chineseDocs.overview);
    assert.deepEqual(await service.documentation('claude', 'overview', 'en'), await service.documentation('claude', 'overview'));
    const legacy = await compileOfficialCatalogSource({ sourceRoot: officialSourceRoot(), sequence: 2,
      issuedAt: '2026-09-04T00:00:00.000Z', signingKey });
    await store.ingest(legacy.files);
    assert.equal((await service.list()).items.find(item => item.pluginId === 'codex')?.localizations, undefined);
    for (const item of list.items) {
      assert.equal(item.runtime.state, 'setup_required');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
