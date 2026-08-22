import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatPreviewSummary,
  parsePreviewOptions,
  previewSteps,
} from './run-preview-verification.mjs';

test('preview requires a base and keeps full/package/provider gates separate', () => {
  assert.throws(() => parsePreviewOptions([]), /requires --base/);
  assert.deepEqual(parsePreviewOptions(['--', '--base', 'main']), { base: 'main' });
  assert.deepEqual(previewSteps('main').map(step => step.id), [
    'affected',
    'build',
    'web-smoke',
    'desktop-smoke',
  ]);
  assert.ok(previewSteps('main').every(step => !step.args.some(arg => arg.includes('canary'))));
});

test('preview summary exposes duration and resource evidence', () => {
  const summary = formatPreviewSummary([{
    label: 'Build',
    status: 'PASS',
    duration: '2.0s',
    resources: {
      peakOpenFiles: 8,
      peakProcesses: 2,
      peakRssKiB: 2048,
      remainingPids: [],
    },
  }], '/tmp/preview.log');
  assert.match(summary, /RESULT: PASS/);
  assert.match(summary, /peak RSS 2\.0 MiB/);
  assert.match(summary, /Detailed log: \/tmp\/preview\.log/);
});
