import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatPrepackageSummary,
  prepackageSkipReason,
  PREPACKAGE_STEPS,
} from './run-quality-prepackage.mjs';

test('prepackage gate runs the deterministic checks in dependency order', () => {
  assert.deepEqual(PREPACKAGE_STEPS.map(step => step.id), [
    'versions',
    'typecheck',
    'tests',
    'build',
    'traceability',
    'functional-evidence',
    'docs',
    'e2e',
    'desktop',
  ]);
  assert.deepEqual(PREPACKAGE_STEPS.find(step => step.id === 'tests')?.args, ['test:all']);
});

test('prepackage summary distinguishes pass and blocked packaging', () => {
  const passing = formatPrepackageSummary([
    { label: 'Type check', status: 'PASS', duration: '1.0s' },
  ]);
  const failing = formatPrepackageSummary([
    { label: 'Type check', status: 'FAIL', duration: '1.0s' },
    { label: 'Tests', status: 'SKIP' },
  ]);

  assert.match(passing, /RESULT: PASS/);
  assert.match(failing, /RESULT: FAIL/);
  assert.match(failing, /\[SKIP\] Tests/);
});

test('prepackage summary links the detailed log when one is available', () => {
  const summary = formatPrepackageSummary(
    [{ label: 'Type check', status: 'PASS', duration: '1.0s' }],
    '/tmp/prepackage.log',
  );
  assert.match(summary, /Detailed log: \/tmp\/prepackage\.log/);
});

test('curated source skips only absent internal E2E and remains package-ready', () => {
  assert.equal(prepackageSkipReason('e2e', {
    curatedSource: true,
    e2eAvailable: false,
  }), 'curated public source omits internal e2e specs');
  assert.equal(prepackageSkipReason('e2e', {
    curatedSource: false,
    e2eAvailable: false,
  }), null, 'private source must run and fail if its E2E specs disappear');
  assert.equal(prepackageSkipReason('desktop', {
    curatedSource: true,
    e2eAvailable: false,
  }), null, 'Electron smoke remains mandatory in curated source');

  const summary = formatPrepackageSummary([
    { label: 'Tests', status: 'PASS' },
    { label: 'Browser journeys', status: 'SKIP', reason: 'curated public source omits internal e2e specs' },
    { label: 'Electron smoke', status: 'PASS' },
  ]);
  assert.match(summary, /\[SKIP\] Browser journeys: curated public source/);
  assert.match(summary, /RESULT: PASS/);
});
