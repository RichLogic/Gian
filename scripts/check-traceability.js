#!/usr/bin/env node
// Compatibility notice for old callers; this is not a passing quality gate.
console.error('[traceability] RETIRED: the manual matrix is archived. Use task acceptance criteria and current code/tests. Remove quality:traceability from old automation; no coverage was verified.');
process.exitCode = 2;
