import assert from 'node:assert/strict';
import test from 'node:test';

import { CODEX_NATIVE_COMMANDS, listCodexSlashCommands, mapSkillsResponse } from '../src/core/slash.js';
import type { SkillsListResponse } from '../src/runtime/types.js';

test('mapSkillsResponse maps user/repo/system/admin scopes to wire sources', () => {
  const response: SkillsListResponse = {
    data: [
      {
        cwd: '/repo',
        errors: [],
        skills: [
          { name: 'review-pr', description: 'Review the PR', enabled: true, path: '/repo/.codex/skills/review-pr', scope: 'repo' },
          { name: 'journal', description: 'Daily journal', enabled: true, path: '/home/me/.codex/skills/journal', scope: 'user' },
          { name: 'company-style', description: 'Style guide', enabled: true, path: '/etc/codex/skills/company-style', scope: 'system' },
          { name: 'org-policy', description: 'Org policy', enabled: true, path: '/etc/codex/skills/org-policy', scope: 'admin' },
        ],
      },
    ],
  };

  const commands = mapSkillsResponse(response);
  const byName = Object.fromEntries(commands.map((c) => [c.name, c]));

  assert.equal(byName['/review-pr']?.source, 'project');
  assert.equal(byName['/journal']?.source, 'user');
  assert.equal(byName['/company-style']?.source, 'builtin');
  assert.equal(byName['/org-policy']?.source, 'builtin');
  for (const cmd of commands) {
    assert.ok(cmd.name.startsWith('/'));
    assert.ok(cmd.description.length > 0);
    assert.ok(cmd.filePath);
  }
});

test('mapSkillsResponse skips disabled skills', () => {
  const response: SkillsListResponse = {
    data: [
      {
        cwd: '/repo',
        errors: [],
        skills: [
          { name: 'enabled', description: 'on', enabled: true, path: '/p/enabled', scope: 'user' },
          { name: 'disabled', description: 'off', enabled: false, path: '/p/disabled', scope: 'user' },
        ],
      },
    ],
  };
  const names = mapSkillsResponse(response).map((c) => c.name);
  assert.deepEqual(names, ['/enabled']);
});

test('mapSkillsResponse prefers interface.shortDescription over description', () => {
  const response: SkillsListResponse = {
    data: [
      {
        cwd: '/repo',
        errors: [],
        skills: [
          {
            name: 'with-iface',
            description: 'long description',
            enabled: true,
            path: '/p/with-iface',
            scope: 'user',
            interface: { shortDescription: 'short!' },
          },
        ],
      },
    ],
  };
  assert.equal(mapSkillsResponse(response)[0]?.description, 'short!');
});

test('mapSkillsResponse dedupes by name across multiple cwd entries', () => {
  const response: SkillsListResponse = {
    data: [
      {
        cwd: '/repo-a',
        errors: [],
        skills: [{ name: 'shared', description: 'first', enabled: true, path: '/a/shared', scope: 'user' }],
      },
      {
        cwd: '/repo-b',
        errors: [],
        skills: [{ name: 'shared', description: 'second', enabled: true, path: '/b/shared', scope: 'repo' }],
      },
    ],
  };
  const result = mapSkillsResponse(response);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.source, 'project');
  assert.equal(result[0]?.description, 'second');
});

test('mapSkillsResponse handles empty / missing data gracefully', () => {
  assert.deepEqual(mapSkillsResponse({ data: [] }), []);
  assert.deepEqual(mapSkillsResponse({ data: [{ cwd: '/x', errors: [], skills: [] }] }), []);
});

test('listCodexSlashCommands includes documented Codex built-ins', () => {
  const commands = listCodexSlashCommands({ data: [] });
  const byName = Object.fromEntries(commands.map((c) => [c.name, c]));

  assert.ok(byName['/compact'], 'expected /compact native command');
  assert.ok(byName['/clear'], 'expected /clear native command');
  assert.ok(byName['/model'], 'expected /model native command');
  assert.equal(byName['/compact']?.source, 'builtin');
  assert.equal(byName['/compact']?.filePath, undefined);
  assert.ok(
    commands.length >= CODEX_NATIVE_COMMANDS.length,
    'native command list should be present even when skills/list is empty',
  );
});

test('listCodexSlashCommands lets repo/user skills override native names', () => {
  const commands = listCodexSlashCommands({
    data: [
      {
        cwd: '/repo',
        errors: [],
        skills: [
          {
            name: 'compact',
            description: 'project compact skill',
            enabled: true,
            path: '/repo/.codex/skills/compact',
            scope: 'repo',
          },
        ],
      },
    ],
  });
  const compact = commands.find((c) => c.name === '/compact');

  assert.equal(compact?.source, 'project');
  assert.equal(compact?.description, 'project compact skill');
  assert.equal(compact?.filePath, '/repo/.codex/skills/compact');
});
