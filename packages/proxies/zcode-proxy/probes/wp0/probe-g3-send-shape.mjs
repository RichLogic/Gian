// G3 (schema side, zero quota): discover the session/send params shape —
// text + attachments — by probing zod validation with a NONEXISTENT session
// id. Schema-valid combos fail later with "Session not found" (-32004) BEFORE
// any model call; schema-invalid combos return -32602 with issue paths.
// A real image/file send remains a canary authorization point.
import fs from 'node:fs';
import { ProbeSession, note, makeIsolatedHome } from './lib.mjs';

const { home, cwd } = makeIsolatedHome({ withConfig: true });
const logPath = new URL('../../evidence/wp0/raw/g3-send-shape.ndjson', import.meta.url).pathname;
const probe = new ProbeSession({ label: 'g3', home, cwd, logPath });

const created = await probe.request('session/create', {
  workspace: { workspacePath: cwd, workspaceKey: cwd },
}, 45_000);
const realSession = created?.session?.sessionId;
const GHOST = 'sess_00000000-0000-4000-8000-000000000000'; // never exists
const results = {};

async function trySend(label, params) {
  try {
    const r = await probe.request('session/send', params, 20_000);
    results[label] = { outcome: 'accepted', value: r };
    note(`${label}: ACCEPTED (unexpected)`);
  } catch (e) {
    results[label] = {
      outcome: 'rejected',
      code: e.innerError?.code,
      message: String(e.innerError?.message ?? e.message).slice(0, 400),
    };
    note(`${label}: ${e.innerError?.code} ${String(e.innerError?.message ?? e.message).slice(0, 180)}`);
  }
}

// (1) empty params -> required keys
await trySend('empty', {});
// (2) ghost session + content variants: -32004 means schema-accepted
await trySend('ghost-content-string', { sessionId: GHOST, content: 'x' });
await trySend('ghost-content-parts', { sessionId: GHOST, content: [{ type: 'text', text: 'x' }] });
await trySend('ghost-content-object', { sessionId: GHOST, content: { text: 'x' } });
// (3) attachment key candidates with ghost session
await trySend('ghost-attachments-array', {
  sessionId: GHOST,
  content: 'x',
  attachments: [{ type: 'image', dataBase64: 'aGk=', mime: 'image/png' }],
});
await trySend('ghost-attachments-alt', {
  sessionId: GHOST,
  content: 'x',
  attachments: [{ kind: 'image', localPath: '/tmp/nope.png' }],
});
await trySend('ghost-input-array', {
  sessionId: GHOST,
  content: 'x',
  input: [{ type: 'localImage', path: '/tmp/nope.png' }],
});
// (4) never send against the real session — record that we deliberately did not.
results.realSessionNotSent = realSession ? true : false;

await probe.close();
fs.writeFileSync(
  new URL('../../evidence/wp0/g3-send-shape.json', import.meta.url).pathname,
  JSON.stringify({ gate: 'G3', scope: 'zod shape only, zero quota', results }, null, 2),
);
note('G3 shape probe done');
