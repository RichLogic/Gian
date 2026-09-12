import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MAX_CATALOG_DOCUMENT_BYTES,
  compileOfficialCatalogSource,
  ephemeralCatalogSigningKey,
  loadOfficialCatalogSource,
  verifyOfficialCatalogSource,
} from '../src/index.js';

function officialSourceRoot(): string {
  const fromSrc = fileURLToPath(new URL('../../../catalog/official-source', import.meta.url));
  const fromDist = fileURLToPath(new URL('../../../../catalog/official-source', import.meta.url));
  return existsSync(fromSrc) ? fromSrc : fromDist;
}

async function copyOfficialSource(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gian-official-source-'));
  await cp(officialSourceRoot(), root, { recursive: true });
  return root;
}

test('installable official-source coordinates compile when they satisfy the URL policy', async () => {
  const root = await copyOfficialSource();
  try {
    const sidecar = await readFile(join(root, 'plugins', 'claude', 'sidecar.json'));
    const entryPath = join(root, 'plugins', 'claude', 'entry.json');
    const entry = JSON.parse(await readFile(entryPath, 'utf8')) as {
      channels: { stable: Record<string, unknown> };
    };
    entry.channels.stable.manifest = {
      url: 'https://github.com/RichLogic/Gian/releases/download/proxy-claude-v0.2.4/gian-proxy-claude-0.2.4-darwin-arm64.tar.gz.manifest.json',
      sha256: createHash('sha256').update(sidecar).digest('hex'),
      size: sidecar.byteLength,
    };
    entry.channels.stable.artifacts = {
      'darwin-arm64': {
        url: 'https://github.com/RichLogic/Gian/releases/download/proxy-claude-v0.2.4/gian-proxy-claude-0.2.4-darwin-arm64.tar.gz',
        sha256: createHash('sha256').update('archive').digest('hex'),
        size: 1234,
      },
    };
    await writeFile(entryPath, `${JSON.stringify(entry, null, 2)}\n`);
    const plugins = await loadOfficialCatalogSource(root);
    verifyOfficialCatalogSource(plugins);
    const bundle = await compileOfficialCatalogSource({
      sourceRoot: root,
      sequence: 9,
      issuedAt: '2026-09-03T00:00:00.000Z',
      signingKey: ephemeralCatalogSigningKey(),
    });
    const claude = bundle.index.plugins.find((plugin) => plugin.pluginId === 'claude');
    assert.ok(claude?.stable.manifest);
    assert.ok(claude?.stable.artifacts['darwin-arm64']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('official source rejects symlink escape, undeclared files, duplicates, and oversized docs', async () => {
  const root = await copyOfficialSource();
  try {
    const plugin = join(root, 'plugins', 'claude');
    await unlink(join(plugin, 'overview.md'));
    await symlink('/etc/passwd', join(plugin, 'overview.md'));
    await assert.rejects(loadOfficialCatalogSource(root), /symlink/);

    await unlink(join(plugin, 'overview.md'));
    await writeFile(join(plugin, 'overview.md'), '# Overview\n');
    await writeFile(join(plugin, 'extra.bin'), 'undeclared');
    await assert.rejects(loadOfficialCatalogSource(root), /undeclared file/);
    await unlink(join(plugin, 'extra.bin'));

    const entryPath = join(plugin, 'entry.json');
    const entry = JSON.parse(await readFile(entryPath, 'utf8')) as {
      documentation: Record<string, string>;
    };
    entry.documentation.setup = 'overview.md';
    await writeFile(entryPath, `${JSON.stringify(entry, null, 2)}\n`);
    await assert.rejects(loadOfficialCatalogSource(root), /duplicate path/);
    entry.documentation.setup = 'setup.md';
    await writeFile(entryPath, `${JSON.stringify(entry, null, 2)}\n`);

    await writeFile(join(plugin, 'overview.md'), `${'A'.repeat(MAX_CATALOG_DOCUMENT_BYTES + 1)}\n`);
    await assert.rejects(loadOfficialCatalogSource(root), /exceeds size bound/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('official source rejects a special file when the platform can create one', async () => {
  const root = await copyOfficialSource();
  try {
    const fifo = join(root, 'plugins', 'claude', 'extra.fifo');
    const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
    if (created.status !== 0) {
      return;
    }
    await assert.rejects(loadOfficialCatalogSource(root), /special file|undeclared/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('production official source stays documentation-only', async () => {
  const plugins = await loadOfficialCatalogSource(officialSourceRoot());
  verifyOfficialCatalogSource(plugins);
  for (const plugin of plugins) {
    assert.equal(plugin.entry.channels.stable.manifest, undefined);
    assert.equal(
      Object.values(plugin.entry.channels.stable.artifacts ?? {}).some(Boolean),
      false,
    );
  }
});
