import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// ADR-0054 (Customization Inventory, gian.proxy/2.3) — Review Round 1/5
// regressions: the ADR must stay proposed with no deciders until Owner/
// Reviewer accepts it and it must remain distinct from the landed Schedule
// and Proxy Catalog ADR numbers.

const __dirname = dirname(fileURLToPath(import.meta.url));
const INTERNAL_DOCS = join(__dirname, '..', 'docs');
const ADR = join(__dirname, '..', 'docs', 'adr', '0054-customization-inventory-protocol-v23.md');
const PROTOCOL_DOC = join(__dirname, '..', 'docs', 'protocol-customization-inventory.md');
const internalDocsTestOptions = {
  skip: existsSync(INTERNAL_DOCS) ? false : 'curated public source omits internal docs',
};

test('ADR-0054 is proposed, has no deciders, and keeps the next free number', internalDocsTestOptions, () => {
  assert.equal(existsSync(ADR), true, 'ADR-0054 must exist');
  const text = readFileSync(ADR, 'utf8');
  assert.match(text, /^id: ADR-0054$/m, 'id must be ADR-0054');
  assert.match(text, /^status: proposed$/m, 'status must be proposed until Owner/Reviewer accepts');
  assert.doesNotMatch(text, /^deciders:/m, 'no deciders may be recorded before acceptance');
  assert.doesNotMatch(text, /^status: accepted$/m);
  // Conversation-bound Schedules own ADR-0053; this decision stays 0054.
  const adr0053 = join(__dirname, '..', 'docs', 'adr', '0053-customization-inventory-protocol-v23.md');
  assert.equal(existsSync(adr0053), false, 'no 0053 collision with Issue #140');
});

test('ADR-0054 and the protocol doc record the integrated 2.3-over-2.2 contract', internalDocsTestOptions, () => {
  const adr = readFileSync(ADR, 'utf8');
  const doc = readFileSync(PROTOCOL_DOC, 'utf8');
  // The old "coexists in parallel" claims are gone.
  assert.doesNotMatch(adr, /2\.2 与我们的 2\.3 可并行/);
  assert.doesNotMatch(adr, /互不阻塞/);
  assert.doesNotMatch(adr, /可并行（Proxy 协商单个版本，Host 按 capability\s*门控可选方法）/);
  assert.match(adr, /2\.3[^\n]*2\.2[^\n]*2\.1[^\n]*2\.0/);
  assert.match(doc, /2\.3[^\n]*2\.2[^\n]*2\.1[^\n]*2\.0/);
  assert.match(doc, /当前为\s*`?\["2\.3","2\.2","2\.1","2\.0"\]/);
});

test('the protocol doc references ADR-0054 (never the superseded 0053 numbering)', internalDocsTestOptions, () => {
  const doc = readFileSync(PROTOCOL_DOC, 'utf8');
  assert.match(doc, /ADR-0054/);
  assert.doesNotMatch(doc, /0053-customization-inventory-protocol-v23/);
});
