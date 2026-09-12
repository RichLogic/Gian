import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { compareSemver, sortSemverDescending } from '../src/plugin-store/semver.js';

test('SemVer comparison orders prerelease below the matching release', () => {
  assert.ok(compareSemver('1.0.0-rc.1', '1.0.0') < 0);
  assert.ok(compareSemver('1.0.0', '1.0.0-rc.1') > 0);
  assert.ok(compareSemver('1.0.0-alpha.1', '1.0.0-rc.1') < 0);
  assert.equal(compareSemver('1.0.0+build.1', '1.0.0+build.2'), 0);
  assert.deepEqual(
    sortSemverDescending(['1.0.0-rc.1', '1.0.0', '1.0.0-alpha.1', '0.9.0']),
    ['1.0.0', '1.0.0-rc.1', '1.0.0-alpha.1', '0.9.0'],
  );
});
