// G6 (STATEFUL resume/read over probe-owned history): fetch native events +
// messages for sessions that earlier WP0-style probes created under
// /tmp/zcode-probe-ws, to freeze the replay shapes (event payload union,
// messages part structure, seq / eventId stability) needed by the canonical
// Live/Replay projector.
//
// This probe is NOT read-only: it calls session/resume, which loads runtime
// state and can persist events (e.g. a session.resumed entry) into the shared
// native store. It therefore fails closed unless the operator opts in via
// WP0_ALLOW_STATEFUL_PROBES=1, and it only ever touches sessions whose read
// result proves a /tmp/ workspace (probe-owned; never user sessions).
//
// Safety rules enforced in code:
//  - opt-in guard (fail closed by default; do not re-run without explicit
//    authorization);
//  - stateful session/resume plus read/events/messages only; never
//    session/create, session/send, session/subscribe, or session/close;
//  - a session is only read after its read result proves
//    workspacePath starts with /tmp/ (probe-owned; never user sessions);
//  - user session metadata is never logged (list reduced to counts).
import fs from 'node:fs';
import { ProbeSession, note } from './lib.mjs';

const PROBE_SESSIONS = [
  'sess_d094c212-41d0-4fc7-9bb1-f71b0eca0e04',
  'sess_b3f730fe-d783-4c42-8d4d-f223c7aba77b',
  'sess_412b557c-593f-4d5f-9cb5-b4eeef7cbc1b',
  'sess_fdb23259-afcb-46c0-af9b-62e607787a63',
  'sess_e1d9de7b-d4b1-48c0-9045-7707ad5608c5',
  'sess_98b76373-13d6-4726-8dc2-4d53e7638e94',
];

// Fail closed: this probe is stateful (session/resume) and touches the real
// native store for probe-owned history only. Require an explicit opt-in.
if (process.env.WP0_ALLOW_STATEFUL_PROBES !== '1') {
  console.error(
    '[wp0] G6 refuses to run: session/resume is STATEFUL (it may persist events). '
    + 'Set WP0_ALLOW_STATEFUL_PROBES=1 only with explicit authorization.',
  );
  process.exit(2);
}
const home = process.env.HOME; // real native store, probe-owned sessions only
const cwd = fs.mkdtempSync('/tmp/zcode-wp0-g6-ws-');
const logPath = new URL('../../evidence/wp0/raw/g6-replay.ndjson', import.meta.url).pathname;

const probe = new ProbeSession({ label: 'g6', home, cwd, logPath });
const results = { sessions: {} };

for (const sessionId of PROBE_SESSIONS) {
  try {
    // Persisted sessions must be resumed before read; resume loads runtime
    // state and is non-destructive. IDs are the known probe-owned set.
    await probe.request('session/resume', { sessionId }, 30_000);
    const read = await probe.request('session/read', { sessionId }, 20_000);
    const ws = read?.session?.workspace?.workspacePath ?? '';
    if (!ws.startsWith('/tmp/')) {
      results.sessions[sessionId] = { skipped: 'workspace is not a probe workspace' };
      continue;
    }
    const events = await probe.request('session/events', { sessionId }, 30_000);
    const messages = await probe.request('session/messages', { sessionId }, 30_000);
    const kinds = {};
    for (const e of events?.events ?? []) {
      const k = e?.payload?.kind ?? '(no-kind)';
      kinds[k] = (kinds[k] ?? 0) + 1;
    }
    results.sessions[sessionId] = {
      eventCount: events?.events?.length ?? 0,
      eventSeq: events?.eventSeq,
      payloadKinds: kinds,
      messageCount: messages?.messages?.length ?? 0,
      fullRead: read,
      fullEvents: events,
      fullMessages: messages,
    };
    note(`${sessionId}: events=${results.sessions[sessionId].eventCount} messages=${results.sessions[sessionId].messageCount}`);
  } catch (e) {
    results.sessions[sessionId] = { error: String(e.innerError?.code ?? ''), message: String(e.innerError?.message ?? e.message).slice(0, 200) };
    note(`${sessionId}: ERR ${String(e.innerError?.message ?? e.message).slice(0, 120)}`);
  }
}

await probe.close();
fs.writeFileSync(
  new URL('../../evidence/wp0/g6-replay.json', import.meta.url).pathname,
  JSON.stringify({
    gate: 'G6',
    scope: 'STATEFUL resume/read over probe-owned history (session/resume may persist events; requires WP0_ALLOW_STATEFUL_PROBES=1)',
    results,
  }, null, 2),
);
note('G6 done');
