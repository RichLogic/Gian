import assert from 'node:assert/strict';
import test from 'node:test';

import { stableCustomizationId } from '@gian/proxy-protocol';

import { CODEX_NATIVE_COMMANDS, listCodexSlashCommands, mapSkillsResponse } from '../src/core/slash.js';
import { CodexCustomizationScanner } from '../src/core/customization.js';
import type { SkillMetadata, SkillsListResponse } from '../src/runtime/types.js';

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

test('mapSkillsResponse keeps disabled skills and flags them', () => {
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
  const commands = mapSkillsResponse(response);
  assert.deepEqual(commands.map((c) => c.name), ['/enabled', '/disabled']);
  const byName = Object.fromEntries(commands.map((c) => [c.name, c]));
  assert.equal(byName['/enabled']?.disabled, undefined);
  assert.equal(byName['/disabled']?.disabled, true);
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

test('listCodexSlashCommands exposes only built-ins executable through app-server', () => {
  const commands = listCodexSlashCommands({ data: [] });
  const byName = Object.fromEntries(commands.map((c) => [c.name, c]));

  assert.deepEqual(commands.map(command => command.name), ['/clear', '/compact', '/new']);
  assert.ok(byName['/compact'], 'expected /compact native command');
  assert.ok(byName['/clear'], 'expected /clear native command');
  assert.ok(byName['/new'], 'expected /new native command');
  assert.equal(byName['/model'], undefined);
  assert.equal(byName['/compact']?.source, 'builtin');
  assert.equal(byName['/compact']?.filePath, undefined);
  assert.equal(commands.length, CODEX_NATIVE_COMMANDS.length);
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

test('mapSkillsResponse customizationId is stable and matches the inventory item id', async () => {
  const skill: SkillMetadata = {
    name: 'review-pr',
    description: 'Review the PR',
    enabled: true,
    path: '/repo/.codex/skills/review-pr',
    scope: 'repo',
  };
  const response: SkillsListResponse = {
    data: [{ cwd: '/repo', errors: [], skills: [skill] }],
  };

  const first = mapSkillsResponse(response, '/repo')[0]?.customizationId;
  const second = mapSkillsResponse(response, '/repo')[0]?.customizationId;
  assert.ok(first);
  assert.equal(first, second, 'same input must produce the same id');
  assert.match(first!, /^ci1_[a-f0-9]{32}$/);

  // The id must equal the Customization inventory item id for the same
  // skill — this is the join the web deep-link relies on.
  class FakeRuntime {
    async listSkills(): Promise<SkillsListResponse> {
      return response;
    }
  }
  const scanner = new CodexCustomizationScanner(new FakeRuntime() as never);
  const inventory = await scanner.list('skill', '/repo');
  const item = inventory.items.find((candidate) => candidate.name === 'review-pr');
  assert.ok(item);
  assert.equal(first, item.id);
});

test('mapSkillsResponse scopes ids like the inventory: user vs system vs workspace cwd', () => {
  const response: SkillsListResponse = {
    data: [
      {
        cwd: '/repo',
        errors: [],
        skills: [
          { name: 'a', description: '', enabled: true, path: '/u/a', scope: 'user' },
          { name: 'b', description: '', enabled: true, path: '/r/b', scope: 'repo' },
          { name: 'c', description: '', enabled: true, path: '/s/c', scope: 'system' },
        ],
      },
    ],
  };
  const byName = Object.fromEntries(mapSkillsResponse(response, '/repo').map((c) => [c.name, c]));
  const expected = (scopeKey: string, path: string, name: string) => stableCustomizationId({
    provider: 'codex',
    kind: 'skill',
    scopeKey,
    canonicalSourceLocator: path,
    nativeIdentity: name,
  });
  assert.equal(byName['/a']?.customizationId, expected('user', '/u/a', 'a'));
  assert.equal(byName['/b']?.customizationId, expected('workspace:/repo', '/r/b', 'b'));
  assert.equal(byName['/c']?.customizationId, expected('system', '/s/c', 'c'));
});
