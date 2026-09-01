// G4b: discover the exact setThoughtLevel param name (zod reveals required
// keys) and which field setMode actually mutates (session.mode vs
// settings.mode.current vs settings.permission.mode).
import fs from 'node:fs';
import { ProbeSession, note, makeIsolatedHome } from './lib.mjs';

const { home, cwd } = makeIsolatedHome({ withConfig: true });
const logPath = new URL('../../evidence/wp0/raw/g4b-turnconfig-detail.ndjson', import.meta.url).pathname;
const probe = new ProbeSession({ label: 'g4b', home, cwd, logPath });
const results = {};

const created = await probe.request('session/create', {
  workspace: { workspacePath: cwd, workspaceKey: cwd },
}, 45_000);
const sessionId = created?.session?.sessionId;

async function read(label) {
  const r = await probe.request('session/read', { sessionId }, 20_000);
  const snap = {
    label,
    sessionMode: r?.session?.mode,
    settingsMode: r?.settings?.mode,
    permission: r?.settings?.permission,
    thoughtLevel: r?.settings?.thoughtLevel,
    model: r?.session?.model,
  };
  results[label] = snap;
  note(`${label}: ${JSON.stringify(snap).slice(0, 320)}`);
  return r;
}

await read('baseline');

// (1) zod tells us the required/allowed keys when we send nothing.
try {
  await probe.request('session/setThoughtLevel', { sessionId }, 20_000);
} catch (e) {
  results.setThoughtLevelEmptyParams = e.innerError?.message?.slice(0, 300);
  note(`setThoughtLevel {} -> ${results.setThoughtLevelEmptyParams}`);
}
try {
  await probe.request('session/setMode', { sessionId }, 20_000);
} catch (e) {
  results.setModeEmptyParams = e.innerError?.message?.slice(0, 300);
  note(`setMode {} -> ${results.setModeEmptyParams}`);
}
try {
  await probe.request('session/setModel', { sessionId }, 20_000);
} catch (e) {
  results.setModelEmptyParams = e.innerError?.message?.slice(0, 300);
  note(`setModel {} -> ${results.setModelEmptyParams}`);
}

// (2) candidate shapes for setThoughtLevel
for (const candidate of [
  { thoughtLevel: 'low' },
  { value: 'low' },
  { thoughtLevel: { value: 'low' } },
]) {
  try {
    const r = await probe.request('session/setThoughtLevel', { sessionId, ...candidate }, 20_000);
    results[`setThoughtLevel ${JSON.stringify(candidate)}`] = { ok: true };
    note(`setThoughtLevel ${JSON.stringify(candidate)} -> ok`);
    await read(`after-setThoughtLevel ${JSON.stringify(candidate)}`);
    break;
  } catch (e) {
    results[`setThoughtLevel ${JSON.stringify(candidate)}`] = { err: String(e.innerError?.message ?? e.message).slice(0, 200) };
    note(`setThoughtLevel ${JSON.stringify(candidate)} -> ERR ${String(e.innerError?.message ?? e.message).slice(0, 140)}`);
  }
}

// (3) setMode(plan) — then read to see which field moves.
await probe.request('session/setMode', { sessionId, mode: 'plan' }, 20_000);
await read('after-setMode-plan');

await probe.close();
fs.writeFileSync(
  new URL('../../evidence/wp0/g4b-turnconfig-detail.json', import.meta.url).pathname,
  JSON.stringify({ gate: 'G4', sub: 'param names + mutation targets', results }, null, 2),
);
note('G4b done');
