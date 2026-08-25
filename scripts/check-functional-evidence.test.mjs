import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFunctionalEvidenceReport,
  parseFunctionalInventory,
} from './check-functional-evidence.mjs';

test('functional evidence parser keeps IDs, layers, and evidence status', () => {
  const rows = Array.from({ length: 285 }, (_, index) => (
    `| FT-X-${String(index + 1).padStart(3, '0')} | Case ${index} | Boundary | U/I | 强 |`
  )).join('\n');
  const inventory = parseFunctionalInventory(rows);
  const report = buildFunctionalEvidenceReport({
    version: 1,
    domains: [{ id: 'x', prefixes: ['FT-X'], evidence: ['tests/*.test.ts'] }],
  }, inventory, ['tests/x.test.ts']);
  assert.equal(report.total, 285);
  assert.deepEqual(report.cases[0].layers, ['U', 'I']);
  assert.deepEqual(report.cases[0].evidence, ['tests/x.test.ts']);
});

test('functional evidence fails closed for missing domains and stale evidence patterns', () => {
  const inventory = Array.from({ length: 285 }, (_, index) => ({
    id: `FT-X-${String(index + 1).padStart(3, '0')}`,
    evidenceStatus: '中',
    expected: 'Boundary',
    layers: ['I'],
    title: 'Case',
  }));
  assert.throws(() => buildFunctionalEvidenceReport({
    version: 1,
    domains: [{ id: 'x', prefixes: ['FT-X'], evidence: ['missing/*'] }],
  }, inventory, ['tests/x.test.ts']), /matches nothing/);
  assert.throws(() => buildFunctionalEvidenceReport({
    version: 1,
    domains: [{ id: 'y', prefixes: ['FT-Y'], evidence: ['tests/*'] }],
  }, inventory, ['tests/x.test.ts']), /no evidence domain/);
});
