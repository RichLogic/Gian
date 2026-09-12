import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export function processGroupMembers(groupId) {
  if (!Number.isInteger(groupId) || groupId <= 1) return [];
  const output = execFileSync('ps', ['-axo', 'pid=,pgid=,stat=,lstart='], { encoding: 'utf8' });
  return output.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match || Number(match[2]) !== groupId || match[3].startsWith('Z')) return [];
    return [{ pid: Number(match[1]), startedAt: match[4] }];
  });
}

export function groupIdentityMatches(members, expected) {
  return members.some(member => expected.some(record => record.pid === member.pid && record.startedAt === member.startedAt));
}

export async function drainProcessGroup(groupId, { expected, graceMs = 8_000, killMs = 3_000 } = {}) {
  if (!Number.isInteger(groupId) || groupId <= 1) return;
  let members = processGroupMembers(groupId);
  if (members.length === 0) return;
  if (expected && !groupIdentityMatches(members, expected)) {
    throw new Error(`refusing to stop reused/unverified process group ${groupId}`);
  }
  const signal = value => {
    try { process.kill(-groupId, value); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  for (const [value, timeout] of [['SIGTERM', graceMs], ['SIGKILL', killMs]]) {
    signal(value);
    const deadline = Date.now() + timeout;
    do {
      members = processGroupMembers(groupId);
      if (members.length === 0) return;
      await delay(100);
    } while (Date.now() < deadline);
  }
  throw new Error(`GianDev process group ${groupId} did not drain`);
}
