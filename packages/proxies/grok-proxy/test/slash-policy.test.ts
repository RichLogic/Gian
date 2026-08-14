import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  filterAdvertisedCommands,
  firstSlashToken,
  isBlockedSlashCommand,
} from '../src/core/slash-policy.js';

test('blocks excluded slash commands and plugin marketplace roots', () => {
  assert.equal(isBlockedSlashCommand('/fork'), true);
  assert.equal(isBlockedSlashCommand('/plugins'), true);
  assert.equal(isBlockedSlashCommand('/plugins install foo'), true);
  assert.equal(isBlockedSlashCommand('/plugins list'), false);
  assert.equal(isBlockedSlashCommand('/compact'), false);
});

test('does not treat mention of a blocked command in prose as a slash invocation', () => {
  assert.equal(firstSlashToken('please avoid /fork in this repo'), null);
  assert.equal(firstSlashToken('  /compact keep the last file'), '/compact');
  assert.equal(firstSlashToken('/plugins list'), '/plugins list');
});

test('filters advertised command lists', () => {
  assert.deepEqual(
    filterAdvertisedCommands([
      { name: 'compact' },
      { name: '/fork' },
      { name: '/plugins list' },
      { name: '/plugins' },
    ]).map(command => command.name),
    ['compact', '/plugins list'],
  );
});
