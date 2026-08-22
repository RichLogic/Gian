import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadValidatedCatalog, matchesPattern } from './test-catalog.mjs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

export function parseFunctionalInventory(markdown) {
  return markdown.split('\n').flatMap(line => {
    const match = line.match(/^\| (FT-[A-Z]+-\d+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/);
    if (!match) return [];
    return [{
      id: match[1].trim(),
      title: match[2].trim(),
      expected: match[3].trim(),
      layers: match[4].trim().split('/'),
      evidenceStatus: match[5].trim(),
    }];
  });
}

export function buildFunctionalEvidenceReport(config, inventory, availableEvidence) {
  if (config.version !== 1) throw new Error(`unsupported functional evidence version: ${config.version}`);
  const domainIds = new Set();
  const prefixes = new Set();
  const domains = config.domains.map(domain => {
    if (!domain.id || domainIds.has(domain.id)) throw new Error(`duplicate or missing evidence domain: ${domain.id}`);
    domainIds.add(domain.id);
    for (const prefix of domain.prefixes ?? []) {
      if (prefixes.has(prefix)) throw new Error(`duplicate functional prefix: ${prefix}`);
      prefixes.add(prefix);
    }
    const evidence = [...new Set((domain.evidence ?? []).flatMap(pattern => {
      const matches = availableEvidence.filter(path => matchesPattern(path, pattern));
      if (matches.length === 0) throw new Error(`evidence pattern matches nothing: ${domain.id}: ${pattern}`);
      return matches;
    }))].sort();
    return { ...domain, evidence };
  });

  const ids = new Set();
  const cases = inventory.map(entry => {
    if (ids.has(entry.id)) throw new Error(`duplicate functional inventory id: ${entry.id}`);
    ids.add(entry.id);
    const domain = domains.find(candidate => candidate.prefixes.some(prefix => entry.id.startsWith(`${prefix}-`)));
    if (!domain) throw new Error(`functional inventory id has no evidence domain: ${entry.id}`);
    return { ...entry, domain: domain.id, evidence: domain.evidence };
  });
  if (cases.length !== 277) throw new Error(`expected 277 functional cases, found ${cases.length}`);
  return { version: 1, total: cases.length, cases };
}

export function main(argv = process.argv.slice(2)) {
  const config = JSON.parse(readFileSync(join(rootDir, 'test', 'functional-evidence.json'), 'utf8'));
  const markdown = readFileSync(join(rootDir, config.inventory), 'utf8');
  const inventory = parseFunctionalInventory(markdown);
  const { catalog, entries } = loadValidatedCatalog();
  const availableEvidence = [
    ...entries.map(entry => entry.path),
    ...(catalog.specialEntrypoints ?? []).map(entry => entry.path.split('#', 1)[0]),
  ];
  const report = buildFunctionalEvidenceReport(config, inventory, availableEvidence);
  const outputIndex = argv.indexOf('--write-report');
  if (outputIndex >= 0) {
    const outputPath = resolve(rootDir, argv[outputIndex + 1] ?? 'output/quality/functional-evidence.json');
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`functional-evidence: report ${outputPath}`);
  }
  const counts = Object.groupBy(report.cases, entry => entry.evidenceStatus);
  console.log(`functional-evidence: ${report.total} functional IDs mapped to catalog evidence`);
  console.log(Object.entries(counts).map(([status, cases]) => `${status}=${cases.length}`).join(' '));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
