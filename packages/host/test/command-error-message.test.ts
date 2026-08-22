import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { CommandExecutionError, commandErrorMessage } from '../src/workspace/async-command.js';

function commandError(overrides: Partial<ConstructorParameters<typeof CommandExecutionError>[0]> = {}) {
  return new CommandExecutionError({
    message: 'git failed',
    command: 'git',
    args: ['status'],
    stdout: '',
    stderr: 'fatal: not a git repository',
    exitCode: 128,
    signal: null,
    ...overrides,
  });
}

test('commandErrorMessage prefers trimmed CommandExecutionError stderr', () => {
  assert.equal(
    commandErrorMessage(commandError({ stderr: '  boom  \n' }), 'fallback'),
    'boom',
  );
});

test('commandErrorMessage uses the Error message when stderr is empty', () => {
  assert.equal(
    commandErrorMessage(commandError({ stderr: '   ', message: 'timed out' }), 'fallback'),
    'timed out',
  );
});

test('commandErrorMessage uses fallback for empty CommandExecutionError text', () => {
  assert.equal(
    commandErrorMessage(commandError({ stderr: '', message: '' }), 'git missing'),
    'git missing',
  );
});

test('commandErrorMessage uses a regular Error message', () => {
  assert.equal(commandErrorMessage(new Error('ENOENT'), 'fallback'), 'ENOENT');
});

test('commandErrorMessage uses fallback for empty Error message and non-Errors', () => {
  assert.equal(commandErrorMessage(new Error(''), 'fallback'), 'fallback');
  assert.equal(commandErrorMessage('string-error', 'fallback'), 'fallback');
  assert.equal(commandErrorMessage(null, 'fallback'), 'fallback');
  assert.equal(commandErrorMessage(42, 'fallback'), 'fallback');
});
