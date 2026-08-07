import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatPrepackageSummary,
  PREPACKAGE_STEPS,
} from './run-quality-prepackage.mjs';

test('prepackage gate runs the deterministic checks in dependency order', () => {
  assert.deepEqual(PREPACKAGE_STEPS.map(step => step.id), [
    'typecheck',
    'tests',
    'build',
    'traceability',
    'e2e',
    'desktop',
  ]);
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
