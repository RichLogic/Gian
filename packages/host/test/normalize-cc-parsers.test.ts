import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  ccApprovalDescription,
  ccApprovalSubject,
  parseAskUserQuestionInput,
  parseCcApprovalInput,
} from '../src/event/normalize-cc.js';

test('parseAskUserQuestionInput is lossy on bad input', () => {
  assert.deepEqual(parseAskUserQuestionInput(''), []);
  assert.deepEqual(parseAskUserQuestionInput('{'), []);
  assert.deepEqual(parseAskUserQuestionInput('{"header":"x"}'), []);
  assert.deepEqual(parseAskUserQuestionInput(JSON.stringify({
    questions: [{
      question: 'Which one?',
      header: 'Pick',
      multiSelect: true,
      options: [{ label: 'A', description: 'first' }, null],
    }],
  })), [{
    question: 'Which one?',
    header: 'Pick',
    multiSelect: true,
    options: [{ label: 'A', description: 'first' }],
  }]);
});

test('parseCcApprovalInput returns objects only', () => {
  assert.equal(parseCcApprovalInput(''), null);
  assert.equal(parseCcApprovalInput('[]'), null);
  assert.equal(parseCcApprovalInput('{'), null);
  assert.deepEqual(parseCcApprovalInput('{"command":"ls"}'), { command: 'ls' });
});

test('ccApprovalSubject extracts the tool-specific line', () => {
  assert.equal(ccApprovalSubject('Bash', null), undefined);
  assert.equal(ccApprovalSubject('Bash', { command: ' npm test ' }), 'npm test');
  assert.equal(
    ccApprovalSubject('ExitPlanMode', { plan: '# Ship\n\nDo the thing.' }),
    '# Ship\n\nDo the thing.',
  );
  assert.equal(ccApprovalSubject('Edit', { file_path: 'src/a.ts' }), 'src/a.ts');
  assert.equal(ccApprovalSubject('Grep', { pattern: 'TODO', path: 'src' }), 'TODO  in  src');
  assert.equal(ccApprovalSubject('WebSearch', { query: 'zod' }), 'zod');
  assert.equal(ccApprovalSubject('UnknownTool', { command: 'ls' }), undefined);
});

test('ccApprovalDescription only overrides Bash', () => {
  assert.equal(ccApprovalDescription('Bash', { description: ' run tests ' }), 'run tests');
  assert.equal(ccApprovalDescription('Bash', { description: '' }), undefined);
  assert.equal(ccApprovalDescription('Edit', { description: 'edit file' }), undefined);
});
