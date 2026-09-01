// G7 (partial, offline): ownership mechanics in an isolated HOME —
// session/list, close-then-resume (history must survive close), re-create with
// a stale/unknown native id, and a second app-server process attaching the
// same native session (parallel ownership observation).
import fs from 'node:fs';
import { ProbeSession, note, makeIsolatedHome } from './lib.mjs';

const { home, cwd } = makeIsolatedHome({ withConfig: true });
const logPath = new URL('../../evidence/wp0/raw/g7-ownership.ndjson', import.meta.url).pathname;

const results = {};
const probe = new ProbeSession({ label: 'g7', home, cwd, logPath });
const createParams = { workspace: { workspacePath: cwd, workspaceKey: cwd } };

async function tryStep(name, fn) {
  try {
    const r = await fn();
    results[name] = { ok: true, value: r };
    note(`${name}: ok ${JSON.stringify(r)?.slice(0, 240)}`);
    return r;
  } catch (e) {
    results[name] = { ok: false, code: e.innerError?.code, message: String(e.innerError?.message ?? e.message).slice(0, 240) };
    note(`${name}: ERR ${e.innerError?.code} ${String(e.innerError?.message ?? e.message).slice(0, 160)}`);
    return undefined;
  }
}

const list0 = await tryStep('list-initial', () => probe.request('session/list', {}, 20_000));
results.initialListShape = Array.isArray(list0)
  ? { kind: 'array', count: list0.length, sampleKeys: list0[0] ? Object.keys(list0[0]) : [] }
  : { kind: typeof list0, keys: list0 ? Object.keys(list0) : [] };

const created = await tryStep('create', () => probe.request('session/create', createParams, 45_000));
const sessionId = created?.session?.sessionId;

if (sessionId) {
  await tryStep('subscribe', () => probe.request('session/subscribe', {
    sessionId, deliveryKind: 'desktop-continuous',
  }, 20_000));
  await tryStep('close', () => probe.request('session/close', { sessionId }, 20_000));
  await tryStep('read-after-close', () => probe.request('session/read', { sessionId }, 20_000));
  const resumed = await tryStep('resume-after-close', () => probe.request('session/resume', { sessionId }, 30_000));
  if (resumed) {
    await tryStep('read-after-resume', () => probe.request('session/read', { sessionId }, 20_000));
  }
  await tryStep('list-after-close', () => probe.request('session/list', {}, 20_000));
  await tryStep('create-with-same-id', () => probe.request('session/create', {
    ...createParams, sessionId: 'nonsense-native-id',
  }, 30_000));
  await tryStep('resume-unknown', () => probe.request('session/resume', { sessionId: 'nonsense-native-id' }, 20_000));
}

await probe.close();

// Second app-server over the same HOME db: does it see the closed session and
// can it resume it? (Parallel-ownership evidence; both processes never send.)
const probe2 = new ProbeSession({ label: 'g7-second-process', home, cwd, logPath });
await tryStep('second-list', () => probe2.request('session/list', {}, 20_000));
if (sessionId) {
  await tryStep('second-read', () => probe2.request('session/read', { sessionId }, 20_000));
  await tryStep('second-resume', () => probe2.request('session/resume', { sessionId }, 30_000));
}
await probe2.close();

fs.writeFileSync(
  new URL('../../evidence/wp0/g7-ownership.json', import.meta.url).pathname,
  JSON.stringify({ gate: 'G7', scope: 'offline-isolated-home', results }, null, 2),
);
note('G7 done');
