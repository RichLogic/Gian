import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildEditorArgs, defaultOpenerArgs } from '../src/web/open-with.js';
import type { ExternalEditor } from '@gian/shared';

const ed = (args: string[]): ExternalEditor => ({
  id: 'x', name: 'X', command: 'code', args,
});

test('buildEditorArgs: substitutes {path} token at whole-token level', () => {
  const out = buildEditorArgs(ed(['--new-window', '{path}']), '/abs/foo.md');
  assert.equal(out.command, 'code');
  assert.deepEqual(out.argv, ['--new-window', '/abs/foo.md']);
});

test('buildEditorArgs: substitutes {path} as a substring inside a token', () => {
  const out = buildEditorArgs(ed(['--file={path}']), '/abs/foo.md');
  assert.deepEqual(out.argv, ['--file=/abs/foo.md']);
});

test('buildEditorArgs: replaces every {path} occurrence', () => {
  const out = buildEditorArgs(ed(['{path}', '--diff', '{path}']), '/abs/foo');
  assert.deepEqual(out.argv, ['/abs/foo', '--diff', '/abs/foo']);
});

test('buildEditorArgs: appends path when no {path} token present', () => {
  const out = buildEditorArgs(ed(['--wait']), '/abs/foo.md');
  assert.deepEqual(out.argv, ['--wait', '/abs/foo.md']);
});

test('buildEditorArgs: appends path when args is empty', () => {
  const out = buildEditorArgs(ed([]), '/abs/foo.md');
  assert.deepEqual(out.argv, ['/abs/foo.md']);
});

test('defaultOpenerArgs: darwin uses open', () => {
  const out = defaultOpenerArgs('darwin', '/abs/foo.md');
  assert.equal(out.command, 'open');
  assert.deepEqual(out.argv, ['/abs/foo.md']);
});

test('defaultOpenerArgs: linux uses xdg-open', () => {
  const out = defaultOpenerArgs('linux', '/abs/foo.md');
  assert.equal(out.command, 'xdg-open');
  assert.deepEqual(out.argv, ['/abs/foo.md']);
});

test('defaultOpenerArgs: win32 uses cmd /c start', () => {
  const out = defaultOpenerArgs('win32', 'C:\\abs\\foo.md');
  assert.equal(out.command, 'cmd');
  // The empty "" title is critical: `start "C:\path"` would interpret
  // the path as the window title and silently do nothing.
  assert.deepEqual(out.argv, ['/c', 'start', '', 'C:\\abs\\foo.md']);
});

test('defaultOpenerArgs: unknown platform throws', () => {
  assert.throws(
    () => defaultOpenerArgs('sunos' as NodeJS.Platform, '/x'),
    /unsupported platform/,
  );
});
