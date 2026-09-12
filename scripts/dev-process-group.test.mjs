import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { drainProcessGroup, groupIdentityMatches, processGroupMembers } from './dev-process-group.mjs';

test('group identity excludes PID reuse', () => {
  assert.equal(groupIdentityMatches([{ pid: 7, startedAt: 'new' }], [{ pid: 7, startedAt: 'old' }]), false);
  assert.equal(groupIdentityMatches([{ pid: 7, startedAt: 'same' }], [{ pid: 7, startedAt: 'same' }]), true);
});

test('supervisor harvests a TERM-resistant watcher after its group leader exits', { skip: process.platform === 'win32' }, async t => {
  const childSource = `process.on('SIGTERM', () => {}); console.log('watcher-ready'); setInterval(() => {}, 1000);`;
  const leader = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.once('data', () => { console.log(child.pid); child.unref(); process.exit(0); });
  `], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(leader, 'exit');
  t.after(async () => { await drainProcessGroup(leader.pid, { graceMs: 100 }); });
  const [line] = await once(leader.stdout, 'data');
  const watcherPid = Number(line.toString().trim());
  await exited;
  const members = processGroupMembers(leader.pid);
  assert.ok(members.some(member => member.pid === watcherPid));
  await assert.rejects(drainProcessGroup(leader.pid, { expected: [{ pid: watcherPid, startedAt: 'foreign' }], graceMs: 100 }), /unverified/);
  await drainProcessGroup(leader.pid, { expected: members, graceMs: 100 });
  assert.deepEqual(processGroupMembers(leader.pid), []);
});
