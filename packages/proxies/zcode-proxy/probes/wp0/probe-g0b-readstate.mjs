// G0b: does workspace/readState return catalog-grade settings with ZERO
// session side effects? This is the candidate side-effect-free Catalog source
// that would replace the bootstrap Catalog fallback (Revision 2 §7.1).
// Verifies: session/list count unchanged across the call + returned shape.
import fs from 'node:fs';
import { ProbeSession, note } from './lib.mjs';

const home = fs.mkdtempSync('/tmp/zcode-wp0-g0b-home-');
const cwd = fs.mkdtempSync('/tmp/zcode-wp0-g0b-ws-');
const logPath = new URL('../../evidence/wp0/raw/g0b-readstate.ndjson', import.meta.url).pathname;

const probe = new ProbeSession({ label: 'g0b', home, cwd, logPath });
const results = {};

const before = await probe.request('session/list', {}, 20_000);
results.sessionCountBefore = before?.sessions?.length ?? 0;

try {
  const state = await probe.request('workspace/readState', {
    workspace: { workspacePath: cwd, workspaceKey: cwd },
  }, 30_000);
  results.readState = 'ok';
  results.shape = summarize(state);
  results.topKeys = state && typeof state === 'object' ? Object.keys(state) : [];
} catch (e) {
  results.readState = 'error';
  results.code = e.innerError?.code;
  results.message = String(e.innerError?.message ?? e.message).slice(0, 400);
  // Try the alternate workspace param shape (plain string key).
  try {
    const state2 = await probe.request('workspace/readState', { workspace: cwd }, 20_000);
    results.readStateAltShape = 'ok';
    results.altTopKeys = Object.keys(state2 ?? {});
  } catch (e2) {
    results.altMessage = String(e2.innerError?.message ?? e2.message).slice(0, 300);
  }
}

const after = await probe.request('session/list', {}, 20_000);
results.sessionCountAfter = after?.sessions?.length ?? 0;
results.sideEffectFree = results.sessionCountBefore === results.sessionCountAfter;

function summarize(value, depth = 0) {
  if (depth > 5) return '…';
  if (Array.isArray(value)) return { array: value.length, sample: value[0] ? summarize(value[0], depth + 1) : undefined };
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = summarize(v, depth + 1);
    return out;
  }
  return typeof value === 'string' ? value.slice(0, 120) : value;
}

await probe.close();
fs.writeFileSync(
  new URL('../../evidence/wp0/g0b-readstate.json', import.meta.url).pathname,
  JSON.stringify({ gate: 'G0', sub: 'workspace/readState', results }, null, 2),
);
note(`G0b done; sideEffectFree=${results.sideEffectFree}`);
