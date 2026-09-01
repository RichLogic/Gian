import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildFunctionalEvidenceReport,
  parseFunctionalInventory,
  resolveFunctionalInventoryPath,
} from './check-functional-evidence.mjs';
import { collectDocumentationFiles } from './check-doc-links.mjs';

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

test('curated public source may omit the internal inventory, private source may not', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-functional-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inventory = 'docs/quality/functional-test-inventory-2026-08-10.md';

  assert.equal(resolveFunctionalInventoryPath(root, inventory), null);

  await writeFile(join(root, 'AGENTS.md'), '# private tree\n');
  assert.throws(
    () => resolveFunctionalInventoryPath(root, inventory),
    /inventory is missing/,
  );

  await mkdir(join(root, 'docs/quality'), { recursive: true });
  await writeFile(join(root, inventory), '# inventory\n');
  assert.equal(resolveFunctionalInventoryPath(root, inventory), join(root, inventory));
});

test('curated docs check keeps public roots optional but private roots required', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-doc-roots-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'README.md'), '# README\n');
  await writeFile(join(root, 'CONTRIBUTING.md'), '# Contributing\n');

  assert.deepEqual(
    (await collectDocumentationFiles(root)).sort(),
    ['CONTRIBUTING.md', 'README.md'],
  );

  await writeFile(join(root, 'AGENTS.md'), '# private tree\n');
  await assert.rejects(collectDocumentationFiles(root), /required documentation root is missing/);

  await writeFile(join(root, 'ONBOARDING.md'), '# Onboarding\n');
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, 'design'), { recursive: true });
  assert.deepEqual(
    (await collectDocumentationFiles(root)).sort(),
    ['CONTRIBUTING.md', 'ONBOARDING.md', 'README.md'],
  );
});
