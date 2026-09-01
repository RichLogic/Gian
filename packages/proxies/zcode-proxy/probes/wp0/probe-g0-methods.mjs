// G0: Is there a side-effect-free settings/catalog path? Enumerate the real
// method surface (bundle-extracted names) against a live app-server WITHOUT
// calling session/create, and probe workspace/readState + session/list shapes.
// Success criteria for the gate: every catalog-capable path either does not
// exist or demonstrably creates zero native sessions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProbeSession, note } from './lib.mjs';

const CANDIDATES = [
  // bundle-extracted session surface
  'session/list',
  // workspace-level candidates (potential side-effect-free settings)
  'workspace/readState',
  'workspace/upsertModelProvider',
  'workspace/removeModelProvider',
  'workspace/setDefaultModel',
  'workspace/setDefaultMode',
  'workspace/setDefaultThoughtLevel',
  'workspace/updateModelIoPreferences',
  'workspace/updateProviderRegistry',
  'workspace/updateInteractionPreferences',
  'workspace/generateText',
  'workspace/hooks/trustGrant',
  // usage / automation / v4 / misc
  'usage/stats',
  'session/usage',
  'automation/list',
  'automation/checkTaskBinding',
  'v4/usage/stats',
  'v4/connection/flow',
  'v4/commands/query',
  'server/discover',
  'subscriptions/listen',
  // invented names that must NOT exist (negative controls)
  'catalog/list',
  'settings/read',
  'model/list',
  'provider/list',
];

const home = fs.mkdtempSync('/tmp/zcode-wp0-g0-home-');
const cwd = fs.mkdtempSync('/tmp/zcode-wp0-g0-ws-');
const probe = new ProbeSession({
  label: 'g0',
  home,
  cwd,
  logPath: new URL('../../evidence/wp0/raw/g0-methods.ndjson', import.meta.url).pathname,
});

const findings = [];
for (const method of CANDIDATES) {
  try {
    const result = await probe.request(method, {}, 15_000);
    findings.push({ method, exists: true, shape: summarize(result) });
    note(`${method}: EXISTS ${JSON.stringify(summarize(result)).slice(0, 300)}`);
  } catch (e) {
    const code = e.innerError?.code;
    const message = e.innerError?.message ?? e.message;
    findings.push({ method, exists: false, code, message: String(message).slice(0, 200) });
    note(`${method}: ${code ?? 'ERR'} ${String(message).slice(0, 120)}`);
  }
}

function summarize(value, depth = 0) {
  if (depth > 4) return '…';
  if (Array.isArray(value)) return { array: value.length, sample: value[0] ? summarize(value[0], depth + 1) : undefined };
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = summarize(v, depth + 1);
    return out;
  }
  return typeof value === 'string' ? value.slice(0, 80) : value;
}

// session/list must work and show zero sessions in the isolated HOME.
let listCount = null;
try {
  const list = await probe.request('session/list', {});
  listCount = Array.isArray(list) ? list.length : (list?.sessions?.length ?? JSON.stringify(list).length);
} catch { /* recorded above */ }

await probe.close();
fs.writeFileSync(
  new URL('../../evidence/wp0/g0-method-probe.json', import.meta.url).pathname,
  JSON.stringify({ gate: 'G0', isolatedHomeSessions: listCount, findings }, null, 2),
);
note(`G0 done; isolated home session/list count=${listCount}`);
