import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { GIAN_TASK_SKILL_FILES } from '../src/task/skill-templates.js';

const SECRET_RE = /sk-[A-Za-z0-9]{8,}|api[_-]?key|access_token|client_secret|BEGIN (RSA |OPENSSH )?PRIVATE KEY|password\s*[:=]/i;

test('GIAN_TASK_SKILL_FILES is non-empty with unique names', () => {
  assert.ok(GIAN_TASK_SKILL_FILES.length > 0);
  const names = GIAN_TASK_SKILL_FILES.map(file => file.name);
  assert.equal(new Set(names).size, names.length);
});

test('each skill file has a filename and body', () => {
  for (const file of GIAN_TASK_SKILL_FILES) {
    assert.equal(typeof file.name, 'string');
    assert.ok(file.name.length > 0, 'missing filename');
    assert.equal(typeof file.content, 'string');
    assert.ok(file.content.length > 0, `${file.name} missing body`);
  }
});

test('skill templates do not embed secrets', () => {
  for (const file of GIAN_TASK_SKILL_FILES) {
    assert.doesNotMatch(file.name, SECRET_RE);
    assert.doesNotMatch(file.content, SECRET_RE, file.name);
  }
});
