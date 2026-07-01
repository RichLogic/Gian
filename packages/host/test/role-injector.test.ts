// Coverage for traceability rows:
//   ROLE-INJECT-001 — session-type → role mapping and the ROLE header (§4.8 ①):
//                     INDIVIDUAL has no TASK; PM has no REPORT_PATH; sentinels
//                     strip cleanly.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { stripGianRolePrefix, GIAN_ROLE_OPEN, GIAN_ROLE_CLOSE } from '@gian/shared';
import {
  roleForSessionType,
  buildRoleHeader,
  buildFirstTurnRolePrefix,
} from '../src/task/role-injector.js';

test('ROLE-INJECT-001: session type maps to role', () => {
  assert.equal(roleForSessionType('coding'), 'individual');
  assert.equal(roleForSessionType('subtask'), 'engineer');
  assert.equal(roleForSessionType('manager'), 'pm');
});

test('ROLE-INJECT-001: INDIVIDUAL header — role + workspace + report, no TASK', () => {
  const h = buildRoleHeader({ role: 'individual', sessionId: 's1', workspacePath: '/Users/x/repoA' });
  assert.match(h, /^ROLE: INDIVIDUAL$/m);
  assert.doesNotMatch(h, /^TASK:/m);
  assert.match(h, /^WORKSPACE: \/Users\/x\/repoA$/m);
  assert.match(h, /REPORT_PATH: \/Users\/x\/repoA\/\.ai\/sessions\/s1\.report\.md/);
  assert.match(h, /\.ai\/gian-task\/individual\.md/);
});

test('ROLE-INJECT-001: ENGINEER header carries TASK + report', () => {
  const h = buildRoleHeader({ role: 'engineer', sessionId: 'eng1', workspacePath: '/w', taskName: 'Add X' });
  assert.match(h, /^ROLE: ENGINEER$/m);
  assert.match(h, /^TASK: Add X$/m);
  assert.match(h, /REPORT_PATH: \/w\/\.ai\/sessions\/eng1\.report\.md/);
  assert.match(h, /\.ai\/gian-task\/engineer\.md/);
});

test('ROLE-INJECT-001: PM header has TASK but no REPORT_PATH', () => {
  const h = buildRoleHeader({ role: 'pm', sessionId: 'pm1', workspacePath: '/w', taskName: 'Ship it' });
  assert.match(h, /^ROLE: PM$/m);
  assert.match(h, /^TASK: Ship it$/m);
  assert.doesNotMatch(h, /REPORT_PATH:/);
  assert.match(h, /\.ai\/gian-task\/pm\.md/);
});

test('ROLE-INJECT-001: prefix wraps in sentinels and strips cleanly', () => {
  const prefix = buildFirstTurnRolePrefix({ role: 'individual', sessionId: 's1', workspacePath: '/w' });
  assert.ok(prefix.startsWith(GIAN_ROLE_OPEN));
  assert.ok(prefix.trimEnd().endsWith(GIAN_ROLE_CLOSE));
  // A real user message with the header prepended strips back to just the message.
  const user = 'please fix the login bug';
  assert.equal(stripGianRolePrefix(`${prefix}\n\n${user}`), user);
  // No header → unchanged.
  assert.equal(stripGianRolePrefix(user), user);
});
