import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BROWSER_PROJECT_CSP,
  browserProjectUrl,
  createBrowserProjectSite,
  resolveBrowserProjectPath,
} from '../src/browser-project.js';

describe('Browser project origin', () => {
  it('roots a site at the selected HTML file directory', () => {
    assert.deepEqual(createBrowserProjectSite('ws:1', 'dist/site/index.html'), {
      workingTreeId: 'ws:1',
      root: 'dist/site',
      entry: 'index.html',
    });
    assert.equal(resolveBrowserProjectPath('dist/site', '/assets/app.js'), 'dist/site/assets/app.js');
    assert.equal(resolveBrowserProjectPath('dist/site', '/docs/'), 'dist/site/docs/index.html');
  });

  it('rejects traversal, encoded traversal, backslashes, and invalid entry paths', () => {
    assert.equal(createBrowserProjectSite('ws:1', '../outside.html'), null);
    assert.equal(createBrowserProjectSite('ws:1', '/absolute.html'), null);
    assert.equal(resolveBrowserProjectPath('dist/site', '/../secret.txt'), null);
    assert.equal(resolveBrowserProjectPath('dist/site', '/%2e%2e/secret.txt'), null);
    assert.equal(resolveBrowserProjectPath('dist/site', '/..%2fsecret.txt'), null);
    assert.equal(resolveBrowserProjectPath('dist/site', '/assets\\secret.txt'), null);
  });

  it('assigns independent host-scoped URLs to independently opened sites', () => {
    assert.equal(browserProjectUrl('sitea', 'index.html'), 'gian-browser://sitea/index.html');
    assert.notEqual(new URL(browserProjectUrl('sitea', 'index.html')).hostname,
      new URL(browserProjectUrl('siteb', 'index.html')).hostname);
  });

  it('allows authored static resources without granting file access', () => {
    assert.match(BROWSER_PROJECT_CSP, /script-src 'self'/);
    assert.match(BROWSER_PROJECT_CSP, /https:/);
    assert.match(BROWSER_PROJECT_CSP, /http:\/\/localhost:\*/);
    assert.doesNotMatch(BROWSER_PROJECT_CSP, /file:/);
    assert.match(BROWSER_PROJECT_CSP, /object-src 'none'/);
  });
});
