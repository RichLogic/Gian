import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BrowserControlConflictError,
  BrowserDomain,
} from '../src/browser-domain.js';

function domain() {
  let sequence = 0;
  return new BrowserDomain({
    idFactory: () => `id-${++sequence}`,
    now: () => 1234,
  });
}

test('BrowserDomain owns stable Browser-global tab identity and source context', () => {
  const model = domain();
  const created = model.createTab({ sourceSessionId: 'session-a' });
  assert.equal(created.id, 'browser-id-1');
  assert.equal(created.profileId, 'default');
  assert.equal(created.sourceSessionId, 'session-a');
  assert.equal(created.lifecycle, 'empty');
  assert.deepEqual(model.listTabs(), [created]);

  model.ensureTab(created.id, 'session-b');
  assert.equal(model.getTab(created.id)?.sourceSessionId, 'session-a');
});

test('BrowserDomain separates requested visibility from native presentation', () => {
  const model = domain();
  const tab = model.createTab({ tabId: 'tab-a' });
  model.setVisibility(tab.id, true, false);
  assert.deepEqual(
    { requested: model.getTab(tab.id)?.requestedVisible, presented: model.getTab(tab.id)?.presented },
    { requested: true, presented: false },
  );
  model.setVisibility(tab.id, true, true);
  assert.equal(model.getTab(tab.id)?.presented, true);
  model.setVisibility(tab.id, false, true);
  assert.equal(model.getTab(tab.id)?.presented, false);
});

test('BrowserDomain invalidates exact page references on replacement and navigation', () => {
  const model = domain();
  const tab = model.createTab({ tabId: 'tab-a' });
  const empty = model.currentPage(tab.id);
  const page = model.replacePage(tab.id);
  assert.equal(model.isCurrentPage(empty), false);
  assert.equal(model.isCurrentPage(page), true);

  const loading = model.beginNavigation(tab.id);
  assert.equal(model.isCurrentPage(page), false);
  assert.equal(model.getTab(tab.id)?.lifecycle, 'loading');
  model.markReady(tab.id);
  assert.equal(model.getTab(tab.id)?.lifecycle, 'ready');
  assert.equal(model.isCurrentPage(loading), true);

  model.markError(tab.id);
  assert.equal(model.getTab(tab.id)?.lifecycle, 'error');
  model.finishLoading(tab.id, true);
  assert.equal(model.getTab(tab.id)?.lifecycle, 'error');
  model.markCrashed(tab.id);
  assert.equal(model.getTab(tab.id)?.lifecycle, 'crashed');
});

test('BrowserDomain grants one idempotent control lease and closes it with the tab', () => {
  const model = domain();
  model.createTab({ tabId: 'tab-a' });
  const first = model.acquireControl('tab-a', 'future-adapter-a');
  assert.deepEqual(first, {
    id: 'browser-control-id-1',
    tabId: 'tab-a',
    ownerId: 'future-adapter-a',
    acquiredAt: 1234,
  });
  assert.deepEqual(model.acquireControl('tab-a', 'future-adapter-a'), first);
  assert.equal(model.getTab('tab-a')?.control, 'controlled');
  assert.throws(
    () => model.acquireControl('tab-a', 'future-adapter-b'),
    BrowserControlConflictError,
  );
  assert.equal(model.releaseControl({ id: 'wrong', tabId: 'tab-a' }), false);
  assert.equal(model.releaseControl(first), true);
  assert.equal(model.getTab('tab-a')?.control, 'idle');

  const second = model.acquireControl('tab-a', 'future-adapter-b');
  assert.equal(model.closeTab('tab-a')?.control, 'controlled');
  assert.equal(model.releaseControl(second), false);
  assert.equal(model.isCurrentPage({ tabId: 'tab-a', pageGeneration: 0 }), false);
});
