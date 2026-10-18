// Search module mounted by createApp.
// NOT_RUN. Loading this file imports the host app, which reads the shared
// search contract from @gian/shared dist. This slice does not rebuild that dist.

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { SEARCH_ROUTES } from '../../shared/src/search.js';
import { makeTestApp } from './fixtures/test-app.js';

test('createApp serves search status and disposes the module during shutdown', async () => {
  const ctx = await makeTestApp();
  let disposed = false;
  try {
    const status = await ctx.fetch(SEARCH_ROUTES.status);
    assert.equal(status.status, 200);
    const body = await status.json() as {
      schema_version: number;
      index_revision: string;
      fts: string;
      backfill_complete: boolean;
      coverage: unknown;
    };
    assert.equal(typeof body.schema_version, 'number');
    assert.equal(typeof body.index_revision, 'string');
    assert.equal(typeof body.backfill_complete, 'boolean');
    assert.ok(body.fts === 'trigram' || body.fts === 'unavailable');
    assert.equal(typeof body.coverage, 'object');
    assert.ok(body.coverage);
    const original = ctx.app.search.dispose.bind(ctx.app.search);
    ctx.app.search.dispose = async () => {
      disposed = true;
      await original();
    };
  } finally {
    await ctx.cleanup();
  }
  assert.equal(disposed, true);
});
