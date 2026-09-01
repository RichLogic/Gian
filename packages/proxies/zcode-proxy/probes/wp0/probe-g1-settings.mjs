// G1 verdict probe: managed `--settings` config injection on ZCode 0.16.5.
//
// Frozen findings this script reproduces:
//   a. isolated HOME without any CLI config -> session/create fails with the
//      documented "Model config is missing" error (readiness `invalid` proof);
//   b. `--settings <path>` is DOCUMENTED in `zcode --help` but the 0.16.5
//      argument parser rejects it in every form and placement
//      (`--settings x`, `--settings=x`, before/after the subcommand) —
//      D2 Plan A (managed settings copy) is NOT viable on 0.16.5;
//   c. therefore O2 applies: readiness returns generic repair guidance
//      (configure an explicit CLI model provider; the WP0 evidence does not
//      verify which login command regenerates the file); Gian never writes
//      ~/.zcode.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BIN, ProbeSession, note } from './lib.mjs';

const home = fs.mkdtempSync('/tmp/zcode-wp0-g1-home-');
const cwd = fs.mkdtempSync('/tmp/zcode-wp0-g1-ws-');
const logPath = new URL('../../evidence/wp0/raw/g1-settings.ndjson', import.meta.url).pathname;

const results = {};

// (a) no config at all -> deterministic failure
{
  const p = new ProbeSession({ label: 'g1a-no-config', home, cwd, logPath });
  try {
    const r = await p.request('session/create', {
      workspace: { workspacePath: cwd, workspaceKey: cwd },
    }, 45_000);
    results.noConfig = { outcome: 'unexpected-success', sessionId: r?.session?.sessionId };
  } catch (e) {
    results.noConfig = {
      outcome: 'failed',
      code: e.innerError?.code,
      message: String(e.innerError?.message ?? e.message).slice(0, 300),
    };
  }
  await p.close();
  note(`G1a no-config create: ${JSON.stringify(results.noConfig).slice(0, 240)}`);
}

// (b) --settings placements against `version` (cheap, no session side effects)
function tryArgs(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      env: { HOME: home, PATH: '/usr/bin:/bin', TMPDIR: '/tmp', LANG: 'en_US.UTF-8' },
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('exit', (code) => resolve({ args, code, output: out }));
  });
}

const fakeSettings = path.join(fs.mkdtempSync('/tmp/zcode-wp0-g1-'), 'zcode-config.json');
fs.writeFileSync(fakeSettings, JSON.stringify({ model: {}, provider: {} }), { mode: 0o600 });

results.settingsPlacements = [
  await tryArgs(['--settings', fakeSettings, 'version']),
  await tryArgs(['version', '--settings', fakeSettings]),
  await tryArgs(['--settings=' + fakeSettings, 'version']),
  await tryArgs(['version', '--settings=' + fakeSettings]),
  await tryArgs(['--settings', fakeSettings, 'app-server', '--cwd', cwd]),
  await tryArgs(['app-server', '--cwd', cwd, '--settings', fakeSettings]),
].map((r) => ({
  args: r.args,
  exitCode: r.code,
  rejected: r.output.includes('Unknown option'),
  output: r.output.slice(0, 120),
}));
note(`G1b placements rejected: ${results.settingsPlacements.filter((r) => r.rejected).length}/6`);

// (c) doctor diagnostics shape (for readiness mapping)
{
  results.doctor = await tryArgs(['doctor']);
  note(`G1c doctor: exit=${results.doctor.exitCode} outputBytes=${results.doctor.output.length}`);
}

fs.writeFileSync(
  new URL('../../evidence/wp0/g1-settings.json', import.meta.url).pathname,
  JSON.stringify({ gate: 'G1', results }, null, 2),
);
note('G1 done');
