// Integration updates follow the projected Catalog and installed receipts. NOT_RUN.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CatalogIndexV1 } from '@gian/proxy-catalog-contract';

import { CatalogService } from '../src/catalog/service.js';
import type { CatalogSnapshot } from '../src/catalog/types.js';
import { catalogUpdateInboxObserver } from '../src/inbox/catalog-update-producer.js';
import { InboxService } from '../src/inbox/service.js';
import { openDatabase, type Db } from '../src/storage/db.js';
import type { InstalledPackageView } from '../src/plugin-store/types.js';

const HOST = ['2.0', '2.1', '2.2'];
const COMPATIBLE = '>=2.0 <2.3';

function entry(pluginId: string, version: string, range = COMPATIBLE) {
  return {
    pluginId,
    displayName: pluginId === 'claude' ? 'Claude Code' : pluginId,
    tagline: 'Proxy',
    featuredOrder: 1,
    documentation: {},
    branding: {},
    stable: {
      pluginVersion: version,
      protocolRange: range,
      processScope: 'session',
      runtime: { kind: 'none' },
      manifest: {
        url: 'https://github.com/RichLogic/Gian/releases/download/proxy/manifest.json',
        sha256: 'a'.repeat(64),
        size: 1,
      },
      artifacts: {
        'darwin-arm64': {
          url: 'https://github.com/RichLogic/Gian/releases/download/proxy/archive.tar.gz',
          sha256: 'b'.repeat(64),
          size: 1,
        },
      },
    },
  };
}

function installed(
  pluginId: string,
  version: string,
  extra: InstalledPackageView['versions'] = [],
): InstalledPackageView {
  return {
    pluginId,
    currentVersion: version,
    currentPointer: 'valid',
    versions: [
      { version, state: 'valid', receipt: null },
      ...extra,
    ],
  };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'gian-catalog-inbox-'));
  const db = openDatabase(dir);
  const packages = new Map<string, InstalledPackageView>();
  let snapshot: CatalogSnapshot = {
    index: null,
    sequence: null,
    files: null,
    state: 'empty',
    etag: null,
    error: null,
  };
  let torn = false;
  let reads = 0;
  let bumpOnPublish = false;
  let bundled: string | null = null;
  let holdRead = 0;
  let releaseHold: (() => void) | null = null;
  let markHeld: (() => void) | null = null;
  let delayed: (() => Promise<void>) | null = null;
  const plugins = {
    async listInstalled() {
      reads += 1;
      if (bumpOnPublish && reads % 2 === 0) {
        db.prepare(
          'UPDATE inbox_meta SET collection_revision = collection_revision + 1 WHERE id = 1',
        ).run();
      }
      if (reads === holdRead) {
        holdRead = 0;
        await new Promise<void>(resolve => {
          releaseHold = resolve;
          markHeld?.();
        });
      }
      const rows = [...packages.values()];
      if (!torn || reads % 2 === 1) return rows;
      return rows.map(row => ({ ...row, currentVersion: '9.9.9' }));
    },
    async currentLaunch() {
      return null;
    },
    async install(coordinate: { pluginId: string; pluginVersion: string }) {
      packages.set(coordinate.pluginId, installed(coordinate.pluginId, coordinate.pluginVersion));
      return { pluginId: coordinate.pluginId };
    },
    async rollback() {
      throw new Error('rollback is unused');
    },
  };
  const service = new CatalogService({
    store: { snapshot: () => snapshot },
    plugins,
    policy: {
      sourceId: 'gian-official',
      repository: 'RichLogic/Gian-Proxies',
      artifactRepositories: [],
      pinnedPublicKeys: {},
    },
    hostVersions: HOST,
    platform: 'darwin-arm64',
    officialPresence: async pluginId => (
      bundled === pluginId
        ? {
          pluginId,
          pluginVersion: '9.0.0',
          entryPath: '/official/proxy.js',
          processScope: 'session',
          schemaVersion: 4,
          runtime: { kind: 'none' },
        }
        : null
    ),
  } as never);
  const inbox = new InboxService(db, { broadcast() {} });
  service.setInboxObserver(catalogUpdateInboxObserver(db, inbox));
  service.setInboxRecoveryScheduler(run => {
    delayed = run;
    return () => {
      if (delayed === run) delayed = null;
    };
  });
  return {
    db,
    inbox,
    service,
    packages,
    publish(sequence: number, pluginsInCatalog: ReturnType<typeof entry>[], state: CatalogSnapshot['state'] = 'ready') {
      snapshot = {
        index: {
          schemaVersion: 1,
          sourceId: 'gian-official',
          sequence,
          issuedAt: '2026-10-12T00:00:00.000Z',
          plugins: pluginsInCatalog,
        } as unknown as CatalogIndexV1,
        sequence,
        files: null,
        state,
        etag: null,
        error: state === 'ready' ? null : { code: 'CATALOG_STALE', message: 'stale' },
      };
    },
    setTorn(value: boolean) {
      torn = value;
      reads = 0;
    },
    installedReads() {
      return reads;
    },
    bumpRevisionOnPublish(value: boolean) {
      bumpOnPublish = value;
    },
    hasDelayedRecovery() {
      return delayed !== null;
    },
    delayedRecovery() {
      return delayed;
    },
    async invokeDelayedRecovery() {
      const run = delayed;
      delayed = null;
      if (!run) throw new Error('no delayed catalog inbox recovery is waiting');
      await run();
    },
    setBundled(pluginId: string | null) {
      bundled = pluginId;
    },
    holdNextPublishRead(): Promise<void> {
      const target = reads + 2;
      return new Promise(resolve => {
        holdRead = target;
        markHeld = resolve;
      });
    },
    releaseInstalledRead() {
      const release = releaseHold;
      releaseHold = null;
      release?.();
    },
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function rows(db: Db) {
  return db.prepare(
    `SELECT id, source_key, status, generation, candidate_version, candidate_channel,
            skipped_version, source_epoch, read_at, tombstone, display_json
       FROM inbox_items
      ORDER BY source_key`,
  ).all() as Array<{
    id: string;
    source_key: string;
    status: string;
    generation: number;
    candidate_version: string | null;
    candidate_channel: string | null;
    skipped_version: string | null;
    source_epoch: number | null;
    read_at: string | null;
    tombstone: number;
    display_json: string;
  }>;
}

test('a catalog candidate keeps one generation across phase, skip, and a later version', async () => {
  const context = setup();
  try {
    context.packages.set('claude', installed('claude', '1.0.0'));
    context.publish(3, [entry('claude', '1.1.0')]);
    await context.service.list();
    let stored = rows(context.db);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.source_key, 'product.update:integration:claude');
    assert.equal(stored[0]?.status, 'pending');
    assert.equal(stored[0]?.generation, 1);
    assert.equal(stored[0]?.candidate_version, '1.1.0');
    assert.equal(stored[0]?.candidate_channel, 'stable');
    assert.equal(stored[0]?.source_epoch, 3);
    assert.equal(stored[0]?.read_at, null);
    assert.equal(stored[0]?.tombstone, 0);
    assert.equal(JSON.parse(stored[0]?.display_json ?? '{}').phase, 'available');
    const id = stored[0]!.id;

    context.inbox.markRead(id, 1);
    await context.service.list();
    stored = rows(context.db);
    assert.equal(stored[0]?.generation, 1);
    assert.equal(stored[0]?.source_epoch, 3);
    assert.ok(stored[0]?.read_at);

    context.packages.set('claude', installed('claude', '1.0.0', [
      { version: '1.1.0', state: 'quarantined', receipt: null },
    ]));
    await context.service.list();
    stored = rows(context.db);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.generation, 1);
    assert.equal(stored[0]?.status, 'pending');
    assert.equal(stored[0]?.candidate_version, '1.1.0');
    assert.equal(stored[0]?.source_epoch, 4);
    assert.ok(stored[0]?.read_at);
    assert.equal(JSON.parse(stored[0]?.display_json ?? '{}').phase, 'failed');

    context.inbox.skipVersion(id, 1, '1.1.0');
    await context.service.list();
    stored = rows(context.db);
    assert.equal(stored[0]?.status, 'cancelled');
    assert.equal(stored[0]?.generation, 1);
    assert.equal(stored[0]?.skipped_version, '1.1.0');
    assert.equal(stored[0]?.candidate_version, '1.1.0');

    context.packages.set('claude', installed('claude', '1.0.0'));
    context.publish(4, [entry('claude', '1.2.0')]);
    await context.service.list();
    stored = rows(context.db);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.id, id);
    assert.equal(stored[0]?.status, 'pending');
    assert.equal(stored[0]?.generation, 2);
    assert.equal(stored[0]?.candidate_version, '1.2.0');
    assert.equal(stored[0]?.candidate_channel, 'stable');
    assert.equal(stored[0]?.read_at, null);
    assert.equal(stored[0]?.source_epoch, 5);

    context.publish(5, [entry('claude', '1.0.9')]);
    await context.service.list();
    stored = rows(context.db);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.status, 'pending');
    assert.equal(stored[0]?.generation, 2);
    assert.equal(stored[0]?.candidate_version, '1.2.0');
  } finally {
    context.close();
  }
});

test('discovery, incompatibility, official bundles, and development proxies are not updates', async () => {
  const context = setup();
  try {
    context.packages.set('claude', installed('claude', '1.0.0'));
    context.packages.set('codex', installed('codex', '1.0.0'));
    context.publish(3, [
      entry('claude', '1.0.0'),
      entry('com.example.proxy', '2.0.0', '=2.3'),
    ]);
    await context.service.list();
    assert.equal(rows(context.db).length, 0);

    context.publish(4, [
      entry('claude', '1.4.0'),
      entry('com.example.proxy', '2.0.0'),
    ]);
    context.packages.set('com.example.proxy', installed('com.example.proxy', '1.0.0'));
    await context.service.list();
    const opened = rows(context.db);
    assert.deepEqual(opened.map(row => row.source_key), [
      'product.update:integration:claude',
      'product.update:integration:com.example.proxy',
    ]);

    context.setBundled('claude');
    await context.service.list();
    const afterOfficial = rows(context.db);
    assert.equal(afterOfficial.find(row => row.source_key.endsWith(':claude'))?.status, 'expired');
    assert.equal(afterOfficial.find(row => row.source_key.endsWith(':com.example.proxy'))?.status, 'pending');
    assert.equal(afterOfficial.some(row => row.tombstone === 1), false);
  } finally {
    context.close();
  }

  const devDir = mkdtempSync(join(tmpdir(), 'gian-catalog-inbox-dev-'));
  const devDb = openDatabase(devDir);
  try {
    const devInbox = new InboxService(devDb, { broadcast() {} });
    devInbox.applySignal({
      kind: 'product.update',
      product: 'integration',
      target_id: 'claude',
      version: '1.1.0',
      channel: 'stable',
      epoch: 1,
      phase: 'available',
      title: 'Claude Code',
      summary: '1.1.0 is available on the stable channel.',
    });
    const dev = new CatalogService({
      store: { snapshot: () => ({ state: 'ready', sequence: 4, index: { plugins: [] } }) },
      plugins: { listInstalled: async () => { throw new Error('development must not read receipts'); } },
      policy: {
        sourceId: 'gian-official',
        repository: 'RichLogic/Gian-Proxies',
        artifactRepositories: [],
        pinnedPublicKeys: {},
      },
      developmentProxies: async () => [{
        pluginId: 'claude',
        displayName: 'Claude Code',
        pluginVersion: '0.0.1-dev',
        manifestSha256: 'a'.repeat(64),
        protocolRange: COMPATIBLE,
        entryPath: '/dev/claude.js',
        processScope: 'session',
        schemaVersion: 4,
        runtime: { kind: 'none' },
        source: 'official-development',
      }],
    } as never);
    dev.setInboxObserver(catalogUpdateInboxObserver(devDb, devInbox));
    await dev.list();
    const stored = rows(devDb);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.status, 'pending');
  } finally {
    devDb.close();
    rmSync(devDir, { recursive: true, force: true });
  }
});

test('a caught-up receipt closes the candidate and a torn snapshot does not', async () => {
  const context = setup();
  try {
    context.packages.set('claude', installed('claude', '1.0.0'));
    context.publish(3, [entry('claude', '1.1.0')]);
    await context.service.list();
    assert.equal(rows(context.db)[0]?.status, 'pending');

    context.publish(3, [entry('claude', '1.1.0')], 'stale');
    await context.service.list();
    assert.equal(rows(context.db)[0]?.status, 'pending');

    context.setTorn(true);
    context.publish(3, [entry('claude', '1.1.0')]);
    await context.service.list();
    await context.service.settleInboxObservation();
    assert.equal(context.installedReads(), 4);
    assert.equal(rows(context.db)[0]?.status, 'pending');
    assert.equal(rows(context.db)[0]?.candidate_version, '1.1.0');

    context.setTorn(false);
    await context.service.update('claude');
    const stored = rows(context.db);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.status, 'expired');
    assert.equal(stored[0]?.generation, 1);
    assert.equal(stored[0]?.tombstone, 0);
    assert.equal(context.packages.get('claude')?.currentVersion, '1.1.0');
  } finally {
    context.close();
  }
});

test('a deferred receipt read does not write after inbox observation closes', async () => {
  const context = setup();
  try {
    context.packages.set('claude', installed('claude', '1.0.0'));
    context.publish(3, [entry('claude', '1.1.0')]);
    const held = context.holdNextPublishRead();
    const listing = context.service.list();
    await held;
    const closing = context.service.closeInboxObservation();
    context.releaseInstalledRead();
    await closing;
    const projected = await listing;
    assert.equal(projected.items.some(item => item.pluginId === 'claude'), true);
    assert.equal(rows(context.db).length, 0);

    const again = await context.service.list();
    assert.equal(again.items.some(item => item.pluginId === 'claude'), true);
    await context.service.update('claude');
    assert.equal(context.packages.get('claude')?.currentVersion, '1.1.0');
    assert.equal(rows(context.db).length, 0);
  } finally {
    context.close();
  }
});

test('an older catalog observation does not overwrite a newer one', async () => {
  const context = setup();
  try {
    context.packages.set('claude', installed('claude', '1.0.0'));
    context.publish(3, [entry('claude', '1.1.0')]);
    const held = context.holdNextPublishRead();
    const older = context.service.list();
    await held;
    context.publish(4, [entry('claude', '1.2.0')]);
    await context.service.list();
    context.releaseInstalledRead();
    await older;
    await context.service.settleInboxObservation();
    const stored = rows(context.db);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.status, 'pending');
    assert.equal(stored[0]?.generation, 1);
    assert.equal(stored[0]?.candidate_version, '1.2.0');
    assert.equal(stored[0]?.source_epoch, 4);
  } finally {
    context.close();
  }
});

test('a moved snapshot and a stale collection fence are observed again', async () => {
  const context = setup();
  try {
    context.packages.set('claude', installed('claude', '1.0.0'));
    context.publish(3, [entry('claude', '1.1.0')]);
    const held = context.holdNextPublishRead();
    const listing = context.service.list();
    await held;
    const recoveryHeld = context.holdNextPublishRead();
    context.publish(4, [entry('claude', '1.2.0')]);
    context.releaseInstalledRead();
    await listing;
    assert.equal(rows(context.db).some(row => row.candidate_version === '1.1.0'), false);
    await recoveryHeld;
    context.releaseInstalledRead();
    await context.service.settleInboxObservation();
    let stored = rows(context.db);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.candidate_version, '1.2.0');
    assert.equal(stored[0]?.source_epoch, 4);

    const staleHold = context.holdNextPublishRead();
    context.publish(5, [entry('claude', '1.3.0')]);
    const staleListing = context.service.list();
    await staleHold;
    const staleRecoveryHeld = context.holdNextPublishRead();
    context.db.prepare(
      'UPDATE inbox_meta SET collection_revision = collection_revision + 1 WHERE id = 1',
    ).run();
    context.releaseInstalledRead();
    await staleListing;
    await staleRecoveryHeld;
    context.releaseInstalledRead();
    await context.service.settleInboxObservation();
    stored = rows(context.db);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.candidate_version, '1.3.0');
    assert.equal(stored[0]?.status, 'pending');
    assert.equal(stored[0]?.generation, 2);
    assert.equal(stored[0]?.source_epoch, 5);
  } finally {
    context.close();
  }
});

test('a continuous stale collection fence retries once then waits', async () => {
  const context = setup();
  try {
    context.packages.set('claude', installed('claude', '1.0.0'));
    context.publish(3, [entry('claude', '1.1.0')]);
    context.bumpRevisionOnPublish(true);
    await context.service.list();
    await context.service.settleInboxObservation();
    assert.equal(context.installedReads(), 4);
    assert.equal(rows(context.db).length, 0);
    assert.equal(context.hasDelayedRecovery(), true);

    const before = context.installedReads();
    await context.invokeDelayedRecovery();
    assert.equal(context.installedReads(), before + 2);
    assert.equal(rows(context.db).length, 0);
    assert.equal(context.hasDelayedRecovery(), true);
    assert.equal(context.installedReads(), before + 2);
  } finally {
    context.close();
  }
});

test('shutdown cancels a delayed catalog inbox retry', async () => {
  const context = setup();
  try {
    context.packages.set('claude', installed('claude', '1.0.0'));
    context.publish(3, [entry('claude', '1.1.0')]);
    context.bumpRevisionOnPublish(true);
    await context.service.list();
    await context.service.settleInboxObservation();
    const scheduled = context.delayedRecovery();
    assert.equal(typeof scheduled, 'function');
    const readsBefore = context.installedReads();
    await context.service.closeInboxObservation();
    await scheduled?.();
    assert.equal(context.installedReads(), readsBefore);
    assert.equal(rows(context.db).length, 0);
    assert.equal(context.hasDelayedRecovery(), false);

    const again = await context.service.list();
    assert.equal(again.items.some(item => item.pluginId === 'claude'), true);
    assert.equal(rows(context.db).length, 0);
    assert.equal(context.hasDelayedRecovery(), false);
  } finally {
    context.close();
  }
});
