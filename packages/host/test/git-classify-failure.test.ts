import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { classifyGitFailure } from '../src/workspace/git-runner.js';

test('classifyGitFailure maps credential prompt and askpass text to authentication', () => {
  assert.equal(classifyGitFailure('fatal: could not read Username for https://example.test'), 'authentication');
  assert.equal(classifyGitFailure('unable to read askpass response'), 'authentication');
  assert.equal(classifyGitFailure('terminal prompts disabled'), 'authentication');
});

test('classifyGitFailure maps repository and revision errors', () => {
  assert.equal(classifyGitFailure('fatal: not a git repository (or any of the parent directories)'), 'not-repository');
  assert.equal(classifyGitFailure('fatal: Needed a single revision'), 'not-found');
  assert.equal(classifyGitFailure('fatal: ambiguous argument HEAD~99'), 'not-found');
  assert.equal(classifyGitFailure('fatal: unknown revision or path not in the working tree'), 'not-found');
});

test('classifyGitFailure falls back to command for empty and unrelated stderr', () => {
  assert.equal(classifyGitFailure(''), 'command');
  assert.equal(classifyGitFailure('error: failed to push some refs'), 'command');
});
