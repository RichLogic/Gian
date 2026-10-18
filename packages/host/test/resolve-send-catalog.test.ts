import assert from 'node:assert/strict';
import test from 'node:test';
import { ProxyProtocolError } from '@gian/proxy-protocol';
import type { ProxyCatalog, ResolvedProxyCatalog } from '@gian/shared';
import { resolveSendCatalog, type SendCatalogClient } from '../src/session/resolve-send-catalog.js';

const draft = { sessionConfig: {}, turnConfig: { model: 'gemini-session-a' } };

function resolved(revision: string): ResolvedProxyCatalog {
  return {
    catalogRevision: revision,
    input: [{ type: 'text' }],
    configOptions: [],
    slashCommands: [],
    resolvedDefaults: { sessionConfig: {}, turnConfig: {} },
  };
}

function catalog(revision: string): ProxyCatalog {
  return {
    catalogRevision: revision,
    input: [{ type: 'text' }],
    configOptions: [],
    slashCommands: [],
  };
}

function catalogChanged(): ProxyProtocolError {
  return new ProxyProtocolError(
    'CONFLICT',
    '[CONFLICT] Catalog changed; refresh its options before resolving.',
    false,
  );
}

function harness(options: {
  sessionRevision?: () => string | undefined;
  accept?: (revision: string) => boolean;
  fail?: (revision: string) => Error;
  reload?: () => Promise<ProxyCatalog>;
}) {
  const revisions: string[] = [];
  let reloads = 0;
  const client: SendCatalogClient = {
    ...(options.sessionRevision ? { sessionCatalogRevision: options.sessionRevision } : {}),
    resolveCatalog: async (params) => {
      revisions.push(params.catalogRevision);
      assert.deepEqual(params.turnConfig, draft.turnConfig);
      if (options.fail) throw options.fail(params.catalogRevision);
      if (options.accept && !options.accept(params.catalogRevision)) throw catalogChanged();
      return resolved(params.catalogRevision);
    },
    ...(options.reload ? {
      reloadCatalog: () => {
        reloads += 1;
        return options.reload!();
      },
    } : {}),
  };
  return {
    client,
    revisions,
    reloads: () => reloads,
  };
}

test('an attached session fence is resolved before the frozen process catalog', async () => {
  const h = harness({
    sessionRevision: () => 'session-a',
    accept: (revision) => revision === 'session-a',
    reload: async () => catalog('should-not-reload'),
  });
  const result = await resolveSendCatalog(h.client, draft, 'cold-stale');
  assert.equal(result.catalogRevision, 'session-a');
  assert.deepEqual(h.revisions, ['session-a']);
  assert.equal(h.reloads(), 0);
});

test('a missing session fence resolves the cached process revision once', async () => {
  const h = harness({
    accept: (revision) => revision === 'cold-live',
    reload: async () => catalog('should-not-reload'),
  });
  const result = await resolveSendCatalog(h.client, draft, 'cold-live');
  assert.equal(result.catalogRevision, 'cold-live');
  assert.deepEqual(h.revisions, ['cold-live']);
  assert.equal(h.reloads(), 0);
});

test('equal session and process fences resolve once', async () => {
  const h = harness({
    sessionRevision: () => 'cold-same',
    accept: (revision) => revision === 'cold-same',
    reload: async () => catalog('should-not-reload'),
  });
  const result = await resolveSendCatalog(h.client, draft, 'cold-same');
  assert.equal(result.catalogRevision, 'cold-same');
  assert.deepEqual(h.revisions, ['cold-same']);
  assert.equal(h.reloads(), 0);
});

test('one Catalog-changed conflict reloads the canonical catalog and resolves the new fence', async () => {
  const h = harness({
    sessionRevision: () => 'cold-stale',
    accept: (revision) => revision === 'cold-fresh',
    reload: async () => catalog('cold-fresh'),
  });
  const result = await resolveSendCatalog(h.client, draft, 'ignored');
  assert.equal(result.catalogRevision, 'cold-fresh');
  assert.deepEqual(h.revisions, ['cold-stale', 'cold-fresh']);
  assert.equal(h.reloads(), 1);
});

test('a session fence that moves during reload is the second resolve', async () => {
  let revision = 'cold-stale';
  const h = harness({
    sessionRevision: () => revision,
    accept: (value) => value === 'session-new',
    reload: async () => {
      revision = 'session-new';
      return catalog('cold-fresh');
    },
  });
  const result = await resolveSendCatalog(h.client, draft, 'ignored');
  assert.equal(result.catalogRevision, 'session-new');
  assert.deepEqual(h.revisions, ['cold-stale', 'session-new']);
  assert.equal(h.reloads(), 1);
});

test('a persistent Catalog-changed conflict stops after one reload', async () => {
  const h = harness({
    sessionRevision: () => 'cold-stale',
    accept: () => false,
    reload: async () => catalog('cold-fresh'),
  });
  await assert.rejects(resolveSendCatalog(h.client, draft, 'cold-stale'), /Catalog changed/);
  assert.deepEqual(h.revisions, ['cold-stale', 'cold-fresh']);
  assert.equal(h.reloads(), 1);
});

test('the helper calls reload once per conflict and uses a shared reload promise', async () => {
  // The inflight promise below belongs to this double. Production cache
  // ownership is covered by the ProtocolV2Host stub, not by this helper.
  let inflight: Promise<ProxyCatalog> | null = null;
  let reloadStarts = 0;
  const h = harness({
    sessionRevision: () => 'cold-stale',
    accept: (revision) => revision === 'cold-fresh',
    reload: () => {
      if (inflight) return inflight;
      reloadStarts += 1;
      inflight = Promise.resolve().then(() => catalog('cold-fresh')).finally(() => {
        inflight = null;
      });
      return inflight;
    },
  });
  const [first, second] = await Promise.all([
    resolveSendCatalog(h.client, draft, 'cold-stale'),
    resolveSendCatalog(h.client, draft, 'cold-stale'),
  ]);
  assert.equal(first.catalogRevision, 'cold-fresh');
  assert.equal(second.catalogRevision, 'cold-fresh');
  assert.equal(reloadStarts, 1);
  assert.equal(h.reloads(), 2);
  assert.deepEqual(h.revisions, ['cold-stale', 'cold-stale', 'cold-fresh', 'cold-fresh']);
});

test('an invalid catalog value is not refreshed or resolved again', async () => {
  const h = harness({
    sessionRevision: () => 'session-a',
    fail: () => new ProxyProtocolError('CONFIG_VALUE_INVALID', '[CONFIG_VALUE_INVALID] Model is not available.', false),
    reload: async () => catalog('should-not-reload'),
  });
  await assert.rejects(
    resolveSendCatalog(h.client, draft, 'cold-stale'),
    (error: unknown) => error instanceof ProxyProtocolError && error.code === 'CONFIG_VALUE_INVALID',
  );
  assert.deepEqual(h.revisions, ['session-a']);
  assert.equal(h.reloads(), 0);
});

test('other conflicts and clients without reload do not refresh', async () => {
  const reused = harness({
    sessionRevision: () => 'session-a',
    fail: () => new ProxyProtocolError('CONFLICT', '[CONFLICT] Turn id was reused with different input.', false),
    reload: async () => catalog('should-not-reload'),
  });
  await assert.rejects(resolveSendCatalog(reused.client, draft, 'cold-stale'), /Turn id was reused/);
  assert.equal(reused.reloads(), 0);
  assert.deepEqual(reused.revisions, ['session-a']);

  const plain = harness({
    sessionRevision: () => 'session-a',
    fail: () => new Error('Catalog changed; refresh its options before resolving.'),
    reload: async () => catalog('should-not-reload'),
  });
  await assert.rejects(resolveSendCatalog(plain.client, draft, 'cold-stale'), /Catalog changed/);
  assert.equal(plain.reloads(), 0);

  const withoutReload = harness({
    accept: () => false,
  });
  await assert.rejects(resolveSendCatalog(withoutReload.client, draft, 'cold-stale'), /Catalog changed/);
  assert.deepEqual(withoutReload.revisions, ['cold-stale']);
  assert.equal(withoutReload.reloads(), 0);
});
