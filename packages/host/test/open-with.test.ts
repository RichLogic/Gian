import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { appOpenerArgs, buildEditorArgs, defaultOpenerArgs, revealArgs, terminalArgs } from '../src/web/open-with.js';
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

test('appOpenerArgs: builds `open -a "<App>" <path>` with the app name kept as one argv token', () => {
  const out = appOpenerArgs('Visual Studio Code', '/abs/foo.md');
  assert.equal(out.command, 'open');
  // The app name stays a single argv element (no shell), so spaces are safe.
  assert.deepEqual(out.argv, ['-a', 'Visual Studio Code', '/abs/foo.md']);
});

test('revealArgs: `open -R <path>` reveals the file in Finder', () => {
  assert.deepEqual(revealArgs('/abs/foo.md'), { command: 'open', argv: ['-R', '/abs/foo.md'] });
});

test('terminalArgs: `open -a Terminal <dir>` opens Terminal at the folder', () => {
  assert.deepEqual(terminalArgs('/abs/dir'), { command: 'open', argv: ['-a', 'Terminal', '/abs/dir'] });
});
