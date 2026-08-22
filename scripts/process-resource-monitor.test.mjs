import assert from 'node:assert/strict';
import test from 'node:test';
import {
  countOpenFiles,
  formatResourceMetrics,
  parseProcessTable,
  processTree,
} from './process-resource-monitor.mjs';

test('resource monitor parses a process tree and formats bounded release evidence', () => {
  const rows = parseProcessTable('10 1 100\n11 10 200\n12 11 300\n20 1 999\n');
  assert.deepEqual(processTree(rows, 10).map(row => row.pid), [10, 11, 12]);
  assert.equal(countOpenFiles('p10\nf1\nf2\np11\nf3\n'), 3);
  assert.equal(formatResourceMetrics({
    peakOpenFiles: 12,
    peakProcesses: 3,
    peakRssKiB: 1536,
    remainingPids: [],
  }), 'peak RSS 1.5 MiB, processes 3, open files 12, remaining 0');
});
