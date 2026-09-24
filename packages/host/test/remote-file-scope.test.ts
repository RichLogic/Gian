import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile, symlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { EventEnvelope } from '@gian/shared';
import { RemoteFileRefService } from '../src/remote/file-ref.js';
import { conversationReferencesAttachment, conversationReferencesFile } from '../src/remote/file-references.js';
import { writeAttachment } from '../src/storage/attachments.js';
import { seedDevice, setupRemoteHarness, teardownRemoteHarness } from './fixtures/remote-harness.js';

test('worktree files are browsable; external references grant one file, never a directory or a sibling', async () => {
  const f = setupRemoteHarness();
  try {
    const device = seedDevice(f);
    const session = await f.sessions.createSession({ workspace_id: f.workspaceId, agent_id: 'agent-claude-review' });
    const root = join(f.dir, 'execution');
    const external = join(f.dir, 'outside');
    await mkdir(root); await mkdir(external);
    await writeFile(join(root, 'index.ts'), 'export const value = 42;');
    await writeFile(join(external, 'allowed.md'), '# Reference');
    await writeFile(join(external, 'secret.txt'), 'not referenced');
    const referenced = join(external, 'allowed.md');
    const events: EventEnvelope[] = [{ session_id: session.id, turn: 1, call_id: 'message', event: 'user_message',
      ts: Date.now(), data: { text: `Review \`${referenced}:12\`` } }];
    const service = new RemoteFileRefService(f.db, () => root, id => id === session.id,
      (_id, path) => conversationReferencesFile(events, path));
    const file = await service.resolveFile({ deviceId: device.id, sessionId: session.id, reference: 'index.ts:1' });
    assert.match(file.mime, /text|javascript/);
    assert.equal((await service.readBytes({ deviceId: device.id, handleId: file.id })).bytes.toString(), 'export const value = 42;');
    const outside = await service.resolveFile({ deviceId: device.id, sessionId: session.id, reference: referenced });
    assert.equal((await service.readBytes({ deviceId: device.id, handleId: outside.id })).bytes.toString(), '# Reference');
    await assert.rejects(service.resolveFile({ deviceId: device.id, sessionId: session.id, reference: join(external, 'secret.txt') }), /not referenced/);
    await assert.rejects(service.tree({ sessionId: session.id, directory: external }), /escaped worktree/);
    await assert.rejects(service.tree({ sessionId: session.id, directory: '..' }), /escaped worktree/);
    await symlink(join(external, 'secret.txt'), join(root, 'escape.txt'));
    await assert.rejects(service.resolveFile({ deviceId: device.id, sessionId: session.id, reference: 'escape.txt' }), /not referenced/);
    const other = seedDevice(f, 'other');
    await assert.rejects(service.readBytes({ deviceId: other.id, handleId: file.id }), /expired/);
    await writeFile(join(root, 'index.ts'), 'replaced');
    await assert.rejects(service.readBytes({ deviceId: device.id, handleId: file.id }), /content changed/);
    const renewed = await service.resolveFile({ deviceId: device.id, sessionId: session.id, reference: file.id });
    assert.equal((await service.readBytes({ deviceId: device.id, handleId: renewed.id })).bytes.toString(), 'replaced');
  } finally { teardownRemoteHarness(f); }
});

test('persisted attachment references survive a device change without granting arbitrary attachment filenames', async () => {
  const f = setupRemoteHarness();
  try {
    const a = seedDevice(f);
    const b = seedDevice(f, 'takeover');
    const session = await f.sessions.createSession({ workspace_id: f.workspaceId, agent_id: 'agent-claude-review' });
    const attachment = await writeAttachment(session.id, Buffer.from('# persistent'), 'text/markdown', 'readme.md');
    const filename = basename(attachment);
    const events: EventEnvelope[] = [{ session_id: session.id, turn: 1, call_id: 'attachment', event: 'user_message',
      ts: Date.now(), data: { text: 'read this', attachments: [{ name: 'readme.md', mime: 'text/markdown', size: 12,
        url: `/api/sessions/${session.id}/attachments/${encodeURIComponent(filename)}` }] } }];
    const service = new RemoteFileRefService(f.db, () => f.dir, undefined, undefined,
      (id, name) => conversationReferencesAttachment(events, id, name));
    const old = await service.resolveFile({ deviceId: a.id, sessionId: session.id, reference: 'attachment:' + filename });
    service.invalidateDevice(a.id);
    const current = await service.resolveFile({ deviceId: b.id, sessionId: session.id, reference: old.reference! });
    assert.notEqual(current.id, old.id);
    assert.equal((await service.readBytes({ deviceId: b.id, handleId: current.id })).bytes.toString(), '# persistent');
    await assert.rejects(service.resolveFile({ deviceId: b.id, sessionId: session.id, reference: 'attachment:other.txt' }), /not referenced/);
    await assert.rejects(service.resolveFile({ deviceId: b.id, sessionId: session.id, reference: 'attachment:../secret' }), /not referenced/);
  } finally { teardownRemoteHarness(f); }
});

test('conversation path matching does not widen prefixes or treat folder context as single-file authorization', () => {
  const event = (text: string, context_items: unknown[] = []): EventEnvelope => ({ session_id: 'session', turn: 1,
    call_id: 'test', event: 'user_message', ts: 1, data: { text, context_items } });
  assert.equal(conversationReferencesFile([event('`/outside/a.txt:12:4`')], '/outside/a.txt'), true);
  assert.equal(conversationReferencesFile([event('/outside/a.txt.backup')], '/outside/a.txt'), false);
  assert.equal(conversationReferencesFile([event('/outside/ab.txt')], '/outside/a.txt'), false);
  assert.equal(conversationReferencesFile([event('', [{ type: 'folder', path: '/outside' }])], '/outside/a.txt'), false);
});
