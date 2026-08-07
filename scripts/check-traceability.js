#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');

const repoRoot = process.cwd();
const matrixPath = 'docs/quality/traceability.md';
const allowedRisks = new Set(['低', '中', '高', '极高']);
const allowedMethods = new Set(['unit', 'property', 'integration', 'contract', 'e2e', 'manual']);
const allowedStatuses = new Set(['COVERED', 'GAP']);
const requirementIdPattern = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+$/;
const evidencePathPattern = /`([^`]+\.(?:ts|tsx|js|mjs|cjs|md|sql|sh|yml|yaml))`/g;

function fail(message) {
  console.error(`[traceability] ${message}`);
  process.exitCode = 1;
}

function stripTicks(value) {
  return value.trim().replace(/^`|`$/g, '').trim();
}

function parseTableLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  if (/^\|\s*-+\s*\|/.test(trimmed)) return null;
  const cells = trimmed.slice(1, -1).split('|').map(cell => cell.trim());
  if (cells.length !== 8) return null;
  if (cells[0] === 'ID') return null;
  if (!requirementIdPattern.test(cells[0])) return null;
  return cells;
}

function checkMatrix() {
  if (!existsSync(matrixPath)) {
    fail(`${matrixPath} is missing.`);
    return;
  }

  const text = readFileSync(matrixPath, 'utf8');
  const forbidden = [
    { pattern: /\bTESTED\b/, label: 'TESTED' },
    { pattern: /\bPARTIAL\b/, label: 'PARTIAL' },
    { pattern: /已覆盖/, label: '已覆盖' },
  ];
  for (const { pattern, label } of forbidden) {
    if (pattern.test(text)) fail(`forbidden coverage wording found: ${label}`);
  }

  let rows = 0;
  let topRiskRows = 0;
  let inTopRiskSection = false;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim() === '## Top 10 未覆盖风险') {
      inTopRiskSection = true;
      continue;
    }
    if (inTopRiskSection && line.startsWith('## ') && line.trim() !== '## Top 10 未覆盖风险') {
      inTopRiskSection = false;
    }
    if (inTopRiskSection && /^\|\s*\d+\s*\|/.test(line.trim())) {
      topRiskRows += 1;
    }

    const cells = parseTableLine(line);
    if (!cells) continue;
    rows += 1;

    const [id, _requirement, risk, methodsCell, _code, evidence, status, gap] = cells;
    const lineNo = index + 1;

    if (!allowedRisks.has(risk)) {
      fail(`${id} line ${lineNo}: risk must be one of ${Array.from(allowedRisks).join(', ')}.`);
    }

    const methods = methodsCell.split(',').map(stripTicks).filter(Boolean);
    if (methods.length === 0) {
      fail(`${id} line ${lineNo}: verification method is required.`);
    }
    for (const method of methods) {
      if (!allowedMethods.has(method)) {
        fail(`${id} line ${lineNo}: unknown verification method "${method}".`);
      }
    }

    if (!allowedStatuses.has(status)) {
      fail(`${id} line ${lineNo}: status must be COVERED or GAP.`);
    }

    const hasEvidence = evidence.trim() !== '-' && evidence.trim().length > 0;
    if (status === 'COVERED') {
      if (!hasEvidence) {
        fail(`${id} line ${lineNo}: COVERED requires automated evidence.`);
      }
      const evidencePaths = Array.from(evidence.matchAll(evidencePathPattern), match => match[1]);
      if (evidencePaths.length === 0) {
        fail(`${id} line ${lineNo}: COVERED evidence must include at least one backticked file path.`);
      }
      for (const evidencePath of evidencePaths) {
        if (!existsSync(evidencePath)) {
          fail(`${id} line ${lineNo}: evidence path does not exist: ${evidencePath}`);
        }
      }
      if (methods.every(method => method === 'manual')) {
        fail(`${id} line ${lineNo}: manual-only verification cannot be COVERED.`);
      }
      if (gap.trim() !== '-') {
        fail(`${id} line ${lineNo}: COVERED rows must use "-" in GAP说明.`);
      }
    }

    if (status === 'GAP' && gap.trim() === '-') {
      fail(`${id} line ${lineNo}: GAP rows require a concrete gap explanation.`);
    }
  }

  if (rows === 0) {
    fail('no requirement rows found.');
  } else {
    console.log(`[traceability] checked ${rows} requirement row(s).`);
  }

  if (topRiskRows !== 10) {
    fail(`Top 10 未覆盖风险 section must contain exactly 10 ranked rows; found ${topRiskRows}.`);
  }
}

function git(args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function changedFilesAgainstBase() {
  const explicitBase = process.env.TRACEABILITY_BASE_REF || process.env.TRACEABILITY_BASE;
  const githubEventBase = githubEventBaseRef();
  const githubBase = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : '';
  const base = explicitBase || githubEventBase || githubBase;
  if (!base) return [];

  try {
    git(['rev-parse', '--verify', base]);
  } catch {
    console.log(`[traceability] base ref ${base} not available; skipping changed-file gate.`);
    return [];
  }

  try {
    return git(['diff', '--name-only', `${base}...HEAD`])
      .split(/\r?\n/)
      .map(file => file.trim())
      .filter(Boolean);
  } catch {
    console.log(`[traceability] unable to diff against ${base}; skipping changed-file gate.`);
    return [];
  }
}

function githubEventBaseRef() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !existsSync(eventPath)) return '';

  try {
    const event = JSON.parse(readFileSync(eventPath, 'utf8'));
    const pullRequestBaseSha = event?.pull_request?.base?.sha;
    if (typeof pullRequestBaseSha === 'string' && pullRequestBaseSha) {
      return pullRequestBaseSha;
    }

    const beforeSha = event?.before;
    if (typeof beforeSha === 'string' && beforeSha && !/^0+$/.test(beforeSha)) {
      return beforeSha;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log(`[traceability] unable to read GitHub event payload: ${msg}`);
  }

  return '';
}

function isRelevantChange(file) {
  if (file.includes('/dist/') || file.includes('/node_modules/')) return false;
  return (
    /^packages\/[^/]+\/src\//.test(file) ||
    /^packages\/[^/]+\/test\//.test(file) ||
    /^packages\/[^/]+\/migrations\//.test(file) ||
    /^packages\/proxies\/[^/]+\/src\//.test(file) ||
    /^packages\/proxies\/[^/]+\/test\//.test(file) ||
    /^e2e\//.test(file) ||
    /^scripts\//.test(file)
  );
}

function checkChangedFiles() {
  if (process.env.TRACEABILITY_NOT_REQUIRED === '1') {
    console.log('[traceability] changed-file gate bypassed by TRACEABILITY_NOT_REQUIRED=1.');
    return;
  }

  const files = changedFilesAgainstBase();
  if (files.length === 0) {
    console.log('[traceability] no base diff available; changed-file gate skipped.');
    return;
  }

  const touchedMatrix = files.includes(matrixPath);
  const relevant = files.filter(isRelevantChange);
  if (relevant.length > 0 && !touchedMatrix) {
    fail(
      [
        'product/test/script changes require docs/quality/traceability.md to be updated.',
        `Changed files: ${relevant.slice(0, 20).join(', ')}${relevant.length > 20 ? ', ...' : ''}`,
        'Set TRACEABILITY_NOT_REQUIRED=1 only for explicit maintenance-only CI runs.',
      ].join('\n[traceability] '),
    );
  } else if (relevant.length > 0) {
    console.log(`[traceability] relevant changes detected and ${matrixPath} was updated.`);
  } else {
    console.log('[traceability] no tracked product/test/script changes in diff.');
  }
}

try {
  checkMatrix();
  checkChangedFiles();
} catch (error) {
  const msg = error instanceof Error ? error.message : String(error);
  fail(msg);
}

if (process.exitCode) {
  process.exit(process.exitCode);
}
