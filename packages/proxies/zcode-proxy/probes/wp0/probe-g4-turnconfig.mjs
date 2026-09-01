// G4: idle turn-config semantics — setModel / setThoughtLevel / setMode while
// the session is idle, with read-back after each step, plus failure shapes for
// invalid values. No prompt is ever sent (no Provider quota).
import fs from 'node:fs';
import { ProbeSession, note, makeIsolatedHome } from './lib.mjs';

const { home, cwd } = makeIsolatedHome({ withConfig: true });
const logPath = new URL('../../evidence/wp0/raw/g4-turnconfig.ndjson', import.meta.url).pathname;

const probe = new ProbeSession({ label: 'g4', home, cwd, logPath });
const results = { steps: [] };

function step(name, fn) {
  return fn
    .then((result) => {
      results.steps.push({ name, ok: true, result: slim(result) });
      note(`${name}: ok ${JSON.stringify(slim(result)).slice(0, 240)}`);
      return result;
    })
    .catch((e) => {
      results.steps.push({ name, ok: false, code: e.innerError?.code, message: String(e.innerError?.message ?? e.message).slice(0, 240) });
      note(`${name}: ERR ${e.innerError?.code} ${String(e.innerError?.message ?? e.message).slice(0, 160)}`);
      return undefined;
    });
}

function slim(value, depth = 0) {
  if (depth > 3) return '…';
  if (Array.isArray(value)) return value.map((v) => slim(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = slim(v, depth + 1);
    return out;
  }
  return typeof value === 'string' ? value.slice(0, 100) : value;
}

// Create session (registers materialization reverse requests automatically).
const created = await step('session/create', probe.request('session/create', {
  workspace: { workspacePath: cwd, workspaceKey: cwd },
}, 45_000));
const sessionId = created?.session?.sessionId;
if (!sessionId) throw new Error('create failed; cannot continue G4');

await step('subscribe', probe.request('session/subscribe', {
  sessionId, deliveryKind: 'desktop-continuous', includeSnapshot: true,
}, 20_000));

const readCurrent = async (label) => {
  const r = await probe.request('session/read', { sessionId }, 20_000);
  results.steps.push({
    name: label,
    ok: true,
    model: r?.session?.model,
    mode: r?.session?.mode,
    thoughtLevel: r?.settings?.thoughtLevel?.current,
    permissionMode: r?.settings?.permission?.mode,
  });
  note(`${label}: model=${JSON.stringify(r?.session?.model)} mode=${r?.session?.mode} thought=${r?.settings?.thoughtLevel?.current}`);
  return r;
};

await readCurrent('baseline-read');

// Order under test (Revision 2 §7.4 freezes model -> thinking -> approval mode).
await step('setModel(GLM-5.3)', probe.request('session/setModel', {
  sessionId, model: { providerId: 'bigmodel', modelId: 'GLM-5.3' },
}, 20_000));
await readCurrent('after-setModel');

await step('setThoughtLevel(low)', probe.request('session/setThoughtLevel', {
  sessionId, level: 'low',
}, 20_000));
await readCurrent('after-setThoughtLevel');

await step('setMode(plan)', probe.request('session/setMode', { sessionId, mode: 'plan' }, 20_000));
await readCurrent('after-setMode');

await step('setMode(build)', probe.request('session/setMode', { sessionId, mode: 'build' }, 20_000));

// Failure shapes (invalid values must be deterministically rejected).
await step('setModel(unknown)', probe.request('session/setModel', {
  sessionId, model: { providerId: 'bigmodel', modelId: 'NOT-A-MODEL' },
}, 20_000));
await step('setMode(unknown)', probe.request('session/setMode', { sessionId, mode: 'NOT-A-MODE' }, 20_000));
await step('setThoughtLevel(unknown)', probe.request('session/setThoughtLevel', { sessionId, level: 'NOT-A-LEVEL' }, 20_000));
await readCurrent('after-failures');

// new-session default check: does a fresh session inherit the previous
// session's model (workspace default) or reset to config default?
const created2 = await step('session/create-2', probe.request('session/create', {
  workspace: { workspacePath: cwd, workspaceKey: cwd },
}, 45_000));
if (created2?.session?.sessionId) {
  const r = await probe.request('session/read', { sessionId: created2.session.sessionId }, 20_000);
  results.steps.push({
    name: 'second-session-defaults',
    ok: true,
    model: r?.session?.model,
    mode: r?.session?.mode,
    thoughtLevel: r?.settings?.thoughtLevel?.current,
  });
  note(`second-session defaults: model=${JSON.stringify(r?.session?.model)} thought=${r?.settings?.thoughtLevel?.current}`);
}

await probe.close();
fs.writeFileSync(
  new URL('../../evidence/wp0/g4-turnconfig.json', import.meta.url).pathname,
  JSON.stringify({ gate: 'G4', results }, null, 2),
);
note('G4 done');
