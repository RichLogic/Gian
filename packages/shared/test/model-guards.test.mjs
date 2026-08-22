import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  DEFAULT_SHORTCUTS,
  isApprovalMode,
  isValidShortcutCombo,
  resolveShortcuts,
} from '../dist/index.js';

test('isApprovalMode accepts the known modes only', () => {
  for (const mode of ['plan', 'ask', 'auto', 'custom', 'full-access']) {
    assert.equal(isApprovalMode(mode), true);
  }
  assert.equal(isApprovalMode('default'), false);
  assert.equal(isApprovalMode(''), false);
  assert.equal(isApprovalMode(1), false);
});

test('isValidShortcutCombo requires distinct modifiers and a key', () => {
  assert.equal(isValidShortcutCombo('mod+shift+k'), true);
  assert.equal(isValidShortcutCombo('a'), true);
  assert.equal(isValidShortcutCombo('mod+shift'), false);
  assert.equal(isValidShortcutCombo('mod+mod+a'), false);
  assert.equal(isValidShortcutCombo('SHIFT+A'), false);
});

test('resolveShortcuts keeps defaults and applies valid overrides', () => {
  assert.deepEqual(resolveShortcuts(undefined), { ...DEFAULT_SHORTCUTS });
  const resolved = resolveShortcuts({ markUnread: 'mod+i', commandPalette: 'not-a-combo' });
  assert.equal(resolved.markUnread, 'mod+i');
  assert.equal(resolved.commandPalette, DEFAULT_SHORTCUTS.commandPalette);
});
