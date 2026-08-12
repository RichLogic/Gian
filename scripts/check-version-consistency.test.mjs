import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APP_MANIFESTS,
  INDEPENDENT_MANIFESTS,
  validateVersionConsistency,
} from './check-version-consistency.mjs';

function manifests(appVersion = '1.2.3') {
  return Object.fromEntries([
    ...APP_MANIFESTS.map(path => [path, appVersion]),
    ...INDEPENDENT_MANIFESTS.map((path, index) => [path, `2.0.${index}`]),
  ]);
}

test('version gate keeps app manifests aligned while allowing independent Proxy versions', () => {
  assert.deepEqual(validateVersionConsistency({
    manifests: manifests(),
    changelog: '# Changelog\n\n## [1.2.3] - 2026-08-11\n',
    releaseRef: 'v1.2.3',
  }), []);
});

test('version gate rejects manifest, changelog, and release-ref drift', () => {
  const values = manifests();
  values['packages/web/package.json'] = '1.2.2';
  const errors = validateVersionConsistency({
    manifests: values,
    changelog: '## [1.2.2] - 2026-08-10\n',
    releaseRef: 'v1.2.1',
  });
  assert.equal(errors.length, 3);
  assert.match(errors.join('\n'), /packages\/web\/package\.json/);
  assert.match(errors.join('\n'), /CHANGELOG/);
  assert.match(errors.join('\n'), /release ref/);
});

test('hotfix gate rejects unavailable baselines and Proxy or protocol changes', () => {
  const errors = validateVersionConsistency({
    manifests: manifests('1.2.3-hotfix'),
    changelog: '## [1.2.3-hotfix] - 2026-08-11\n',
    hotfixBaseAvailable: false,
    hotfixChangedFiles: [
      'packages/host/src/index.ts',
      'packages/proxies/codex-proxy/src/core/service.ts',
      'packages/proxy-protocol/src/schema.ts',
      'packages/shared/src/proxy.ts',
    ],
  });
  assert.equal(errors.length, 2);
  assert.match(errors[0], /base tag v1\.2\.3/);
  assert.match(errors[1], /codex-proxy.*proxy-protocol.*shared/);
});

test('hotfix gate allows app-only changes against the exact base tag', () => {
  assert.deepEqual(validateVersionConsistency({
    manifests: manifests('1.2.3-hotfix'),
    changelog: '## [1.2.3-hotfix] - 2026-08-11\n',
    hotfixBaseAvailable: true,
    hotfixChangedFiles: ['packages/host/src/index.ts', 'packages/web/src/App.tsx'],
  }), []);
});
