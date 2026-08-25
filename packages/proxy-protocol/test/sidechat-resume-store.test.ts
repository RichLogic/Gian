import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { OpaqueSidechatResumeStore } from '../src/sidechat-resume-store.js';

test('opaque Side Chat refs survive restart without exposing Provider ids', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gian-sidechat-ref-'));
  const first = new OpaqueSidechatResumeStore(dataDir);
  const ref = first.seal({
    sidechatId: 'sc-1',
    parentSessionId: 'parent-1',
    nativeSessionId: 'provider-secret-1',
    anchor: { type: 'turn', turnId: 'turn-1', sourceTurnId: 'native-turn-1' },
    sessionConfig: { mode: 'agent' },
    createdAt: '2026-08-25T00:00:00.000Z',
  });

  assert.equal(ref.id.includes('provider-secret-1'), false);
  assert.deepEqual(new OpaqueSidechatResumeStore(dataDir).open(ref.id), {
    sidechatId: 'sc-1',
    parentSessionId: 'parent-1',
    nativeSessionId: 'provider-secret-1',
    anchor: { type: 'turn', turnId: 'turn-1', sourceTurnId: 'native-turn-1' },
    sessionConfig: { mode: 'agent' },
    createdAt: '2026-08-25T00:00:00.000Z',
  });
});

test('opaque Side Chat refs reject tampering and persist hashed close tombstones', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gian-sidechat-close-'));
  const first = new OpaqueSidechatResumeStore(dataDir);
  const ref = first.seal({
    sidechatId: 'sc-2',
    parentSessionId: 'parent-2',
    nativeSessionId: 'provider-secret-2',
    anchor: { type: 'empty' },
    sessionConfig: {},
    createdAt: '2026-08-25T00:00:00.000Z',
  });
  const tampered = `${ref.id.slice(0, -1)}${ref.id.endsWith('a') ? 'b' : 'a'}`;
  assert.equal(first.open(tampered), null);

  first.rememberClosed(ref.id, { sidechatId: 'sc-2', providerDataDeleted: false });
  const restarted = new OpaqueSidechatResumeStore(dataDir);
  assert.deepEqual(restarted.closed(ref.id), {
    sidechatId: 'sc-2',
    providerDataDeleted: false,
  });
  assert.equal(readTombstoneText(dataDir).includes(ref.id), false);
  assert.equal(readTombstoneText(dataDir).includes('provider-secret-2'), false);
});

function readTombstoneText(dataDir: string): string {
  return requireRead(join(dataDir, 'sidechat-closed.json'));
}

function requireRead(path: string): string {
  // Dynamic import is unnecessary here; keeping the read at assertion time
  // makes the on-disk sensitivity property explicit.
  return (process.getBuiltinModule('node:fs') as typeof import('node:fs')).readFileSync(path, 'utf8');
}
