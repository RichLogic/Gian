import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_ATTACHMENT_BYTES, MAX_CONCURRENT_TRANSFERS_PER_DEVICE, generateCanonicalId } from '@gian/remote-protocol';
import { RemoteReplayBuffer } from '../src/remote/replay-buffer.js';
import { command, seedDevice, setupRemoteHarness, teardownRemoteHarness } from './fixtures/remote-harness.js';

test('attachment upload enforces size, offset, hash, pin, and orphan GC', async () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context);
    const created = await context.tool.call({
      request_id: generateCanonicalId(),
      caller_id: 'test-caller',
      method: 'session.create',
      params: { workspace_id: context.workspaceId, task_id: context.taskId, agent_id: 'agent-claude-review' },
      idempotency_key: 'create-for-upload',
    });
    const sessionId = (created.data as { session: { id: string } }).session.id;
    await assert.rejects(
      () => context.runtime.attachments.begin({
        deviceId: device.id,
        sessionId: generateCanonicalId(),
        name: 'big.bin',
        mime: 'application/octet-stream',
        size: MAX_ATTACHMENT_BYTES + 1,
        sha256: 'a'.repeat(64),
      }),
      /20 MiB|not visible/,
    );
    await assert.rejects(
      () => context.runtime.attachments.begin({
        deviceId: device.id,
        sessionId: generateCanonicalId(),
        name: 'ghost.bin',
        mime: 'application/octet-stream',
        size: 4,
        sha256: 'a'.repeat(64),
      }),
      /not visible/,
    );

    const payload = Buffer.alloc(64, 7);
    const digest = createHash('sha256').update(payload).digest('hex');
    const intent = await context.runtime.attachments.begin({
      deviceId: device.id,
      sessionId,
      name: 'note.bin',
      mime: 'application/octet-stream',
      size: payload.length,
      sha256: digest,
    });
    await context.runtime.attachments.writeChunk({
      deviceId: device.id,
      uploadId: intent.id,
      offset: 0,
      bytes: payload.subarray(0, 16),
    });
    await assert.rejects(() => context.runtime.attachments.writeChunk({
      deviceId: device.id,
      uploadId: intent.id,
      offset: 0,
      bytes: payload.subarray(0, 16),
    }));
    await context.runtime.attachments.writeChunk({
      deviceId: device.id,
      uploadId: intent.id,
      offset: 16,
      bytes: payload.subarray(16),
    });
    const item = await context.runtime.attachments.complete({
      deviceId: device.id,
      uploadId: intent.id,
    });
    assert.equal(item.type, 'localFile');
    context.runtime.attachments.pin(intent.id);

    const orphan = await context.runtime.attachments.begin({
      deviceId: device.id,
      sessionId,
      name: 'orphan.bin',
      mime: 'application/octet-stream',
      size: 4,
      sha256: 'b'.repeat(64),
    });
    const collected = context.runtime.attachments.gc(Date.now() + 31 * 60 * 1000);
    assert.ok(collected >= 1);
    assert.equal(context.runtime.attachments.get(orphan.id)?.state, 'expired');
    assert.equal(context.runtime.attachments.get(intent.id)?.state, 'complete');
  } finally {
    teardownRemoteHarness(context);
  }
});

test('open uploads are limited per device and resume by persisted transfer id', async () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context);
    const created = await context.tool.call({
      request_id: generateCanonicalId(),
      caller_id: 'test-caller',
      method: 'session.create',
      params: { workspace_id: context.workspaceId, task_id: context.taskId, agent_id: 'agent-claude-review' },
      idempotency_key: 'create-for-upload-gates',
    });
    const sessionId = (created.data as { session: { id: string } }).session.id;
    const digest = 'c'.repeat(64);
    const transferId = generateCanonicalId();
    const payload = Buffer.from('resume-me');
    const resumeDigest = createHash('sha256').update(payload).digest('hex');
    const first = await context.runtime.attachments.begin({
      deviceId: device.id,
      sessionId,
      name: 'resume.bin',
      mime: 'application/octet-stream',
      size: payload.length,
      sha256: resumeDigest,
      uploadId: transferId,
      transferId,
    });
    await context.runtime.attachments.writeChunk({
      deviceId: device.id,
      uploadId: first.id,
      offset: 0,
      bytes: payload.subarray(0, 4),
    });
    const resumed = await context.runtime.attachments.begin({
      deviceId: device.id,
      sessionId,
      name: 'resume.bin',
      mime: 'application/octet-stream',
      size: payload.length,
      sha256: resumeDigest,
      uploadId: transferId,
      transferId,
    });
    assert.equal(resumed.id, first.id);
    assert.equal(resumed.received, 4);
    const mapped = context.runtime.attachments.getByTransferId(device.id, transferId);
    assert.equal(mapped?.id, first.id);
    await context.runtime.attachments.writeChunk({
      deviceId: device.id,
      uploadId: mapped!.id,
      offset: 4,
      bytes: payload.subarray(4),
    });
    const item = await context.runtime.attachments.complete({ deviceId: device.id, uploadId: mapped!.id });
    assert.equal(item.type, 'localFile');

    const opened = [];
    for (let index = 0; index < MAX_CONCURRENT_TRANSFERS_PER_DEVICE; index += 1) {
      opened.push(await context.runtime.attachments.begin({
        deviceId: device.id,
        sessionId,
        name: `open-${index}.bin`,
        mime: 'application/octet-stream',
        size: 8,
        sha256: digest,
        transferId: generateCanonicalId(),
      }));
    }
    await assert.rejects(
      () => context.runtime.attachments.begin({
        deviceId: device.id,
        sessionId,
        name: 'one-too-many.bin',
        mime: 'application/octet-stream',
        size: 8,
        sha256: digest,
      }),
      /too many open uploads|RATE_LIMITED/,
    );
    context.runtime.attachments.invalidateDevice(device.id);
    for (const intent of opened) {
      assert.equal(context.runtime.attachments.get(intent.id)?.state, 'expired');
    }

    const other = seedDevice(context, 'Tablet');
    await context.runtime.attachments.begin({
      deviceId: other.id,
      sessionId,
      name: 'a.bin',
      mime: 'application/octet-stream',
      size: MAX_ATTACHMENT_BYTES,
      sha256: digest,
    });
    await context.runtime.attachments.begin({
      deviceId: other.id,
      sessionId,
      name: 'b.bin',
      mime: 'application/octet-stream',
      size: MAX_ATTACHMENT_BYTES,
      sha256: digest,
    });
    await context.runtime.attachments.begin({
      deviceId: other.id,
      sessionId,
      name: 'c.bin',
      mime: 'application/octet-stream',
      size: MAX_ATTACHMENT_BYTES,
      sha256: digest,
    });
    await assert.rejects(
      () => context.runtime.attachments.begin({
        deviceId: other.id,
        sessionId,
        name: 'd.bin',
        mime: 'application/octet-stream',
        size: 5 * 1024 * 1024,
        sha256: digest,
      }),
      /open upload bytes|RATE_LIMITED/,
    );
  } finally {
    teardownRemoteHarness(context);
  }
});

test('20 MiB attachment is accepted at the limit and hash mismatch fails closed', async () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context);
    const created = await context.tool.call({
      request_id: generateCanonicalId(),
      caller_id: 'test-caller',
      method: 'session.create',
      params: { workspace_id: context.workspaceId, task_id: context.taskId, agent_id: 'agent-claude-review' },
      idempotency_key: 'create-for-limit',
    });
    const size = MAX_ATTACHMENT_BYTES;
    const intent = await context.runtime.attachments.begin({
      deviceId: device.id,
      sessionId: (created.data as { session: { id: string } }).session.id,
      name: 'limit.bin',
      mime: 'application/octet-stream',
      size,
      sha256: 'c'.repeat(64),
    });
    const chunk = Buffer.alloc(256 * 1024, 1);
    let offset = 0;
    while (offset < size) {
      const next = chunk.subarray(0, Math.min(chunk.length, size - offset));
      await context.runtime.attachments.writeChunk({
        deviceId: device.id,
        uploadId: intent.id,
        offset,
        bytes: next,
      });
      offset += next.length;
    }
    await assert.rejects(() => context.runtime.attachments.complete({
      deviceId: device.id,
      uploadId: intent.id,
    }), /hash mismatch/);
  } finally {
    teardownRemoteHarness(context);
  }
});

test('control replay buffer rejects content frames', () => {
  const buffer = new RemoteReplayBuffer();
  assert.throws(
    () => buffer.push({ type: 'attachment.chunk' } as never),
    /must not enter the control replay buffer/,
  );
});

test('file references are Host-issued and reject path guessing, symlink, expiry, and oversize', async () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context);
    const workspace = context.dir;
    mkdirSync(join(workspace, 'ok'), { recursive: true });
    writeFileSync(join(workspace, 'ok', 'readme.txt'), 'hello remote file');
    symlinkSync(join(workspace, 'ok', 'readme.txt'), join(workspace, 'ok', 'link.txt'));
    writeFileSync(join(workspace, 'ok', 'huge.bin'), Buffer.alloc(2 * 1024 * 1024));

    const session = await context.tool.call({
      request_id: generateCanonicalId(),
      caller_id: 'test-caller',
      method: 'session.create',
      params: { workspace_id: context.workspaceId, task_id: context.taskId, agent_id: 'agent-claude-review' },
      idempotency_key: 'create-for-file',
    });
    const sessionId = (session.data as { session: { id: string } }).session.id;

    assert.throws(() => context.runtime.fileRefs.issue({
      deviceId: device.id,
      sessionId,
      relativePath: '/etc/passwd',
      contentRevision: '1',
    }));

    const issued = context.runtime.fileRefs.issue({
      deviceId: device.id,
      sessionId,
      relativePath: 'ok/readme.txt',
      contentRevision: '1',
    });
    const preview = await context.runtime.fileRefs.preview({
      deviceId: device.id,
      handleId: issued.id,
      expectedRevision: '1',
    });
    assert.equal(preview.bytes.toString(), 'hello remote file');

    await assert.rejects(() => context.runtime.fileRefs.preview({
      deviceId: device.id,
      handleId: issued.id,
      expectedRevision: '2',
    }));

    const link = context.runtime.fileRefs.issue({
      deviceId: device.id,
      sessionId,
      relativePath: 'ok/link.txt',
      contentRevision: '1',
    });
    await assert.rejects(() => context.runtime.fileRefs.preview({
      deviceId: device.id,
      handleId: link.id,
    }));

    const huge = context.runtime.fileRefs.issue({
      deviceId: device.id,
      sessionId,
      relativePath: 'ok/huge.bin',
      contentRevision: '1',
    });
    await assert.rejects(() => context.runtime.fileRefs.preview({
      deviceId: device.id,
      handleId: huge.id,
    }));

    context.runtime.fileRefs.invalidateDevice(device.id);
    await assert.rejects(() => context.runtime.fileRefs.preview({
      deviceId: device.id,
      handleId: issued.id,
    }));
  } finally {
    teardownRemoteHarness(context);
  }
});

test('completed attachments stay bound to their session and pin only after send succeeds', async () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context);
    const first = await context.tool.call({
      request_id: generateCanonicalId(),
      caller_id: 'test-caller',
      method: 'session.create',
      params: { workspace_id: context.workspaceId, task_id: context.taskId, agent_id: 'agent-claude-review' },
      idempotency_key: 'attach-a',
    });
    const second = await context.tool.call({
      request_id: generateCanonicalId(),
      caller_id: 'test-caller',
      method: 'session.create',
      params: { workspace_id: context.workspaceId, task_id: context.taskId, agent_id: 'agent-claude-review' },
      idempotency_key: 'attach-b',
    });
    const sessionA = (first.data as { session: { id: string } }).session.id;
    const sessionB = (second.data as { session: { id: string } }).session.id;
    const payload = Buffer.from('hello-bind');
    const digest = createHash('sha256').update(payload).digest('hex');
    const intent = await context.runtime.attachments.begin({
      deviceId: device.id,
      sessionId: sessionA,
      name: 'note.txt',
      mime: 'text/plain',
      size: payload.length,
      sha256: digest,
    });
    await context.runtime.attachments.writeChunk({
      deviceId: device.id,
      uploadId: intent.id,
      offset: 0,
      bytes: payload,
    });
    await context.runtime.attachments.complete({ deviceId: device.id, uploadId: intent.id });
    assert.equal(context.runtime.attachments.resolveHandle(device.id, intent.id, sessionB), null);
    assert.ok(context.runtime.attachments.resolveHandle(device.id, intent.id, sessionA));

    const send = await context.runtime.commands.execute(device, command('session.send', {
      session_id: sessionB,
      text: 'wrong-session',
      items: [{ type: 'attachment', attachment_id: intent.id }],
    }));
    assert.equal(send.ok, false);
    assert.equal(send.error?.code, 'ATTACHMENT_NOT_FOUND');
    assert.equal(context.runtime.attachments.get(intent.id)?.pinned, false);

    const ok = await context.runtime.commands.execute(device, command('session.send', {
      session_id: sessionA,
      text: 'right-session',
      items: [{ type: 'attachment', attachment_id: intent.id }],
    }));
    assert.equal(ok.ok, true, ok.error?.message);
    assert.equal(context.runtime.attachments.get(intent.id)?.pinned, true);
  } finally {
    teardownRemoteHarness(context);
  }
});

test('complete orphan GC deletes the attachment store file', async () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context);
    const created = await context.tool.call({
      request_id: generateCanonicalId(),
      caller_id: 'test-caller',
      method: 'session.create',
      params: { workspace_id: context.workspaceId, task_id: context.taskId, agent_id: 'agent-claude-review' },
      idempotency_key: 'create-for-complete-gc',
    });
    const payload = Buffer.from('gc-complete');
    const digest = createHash('sha256').update(payload).digest('hex');
    const intent = await context.runtime.attachments.begin({
      deviceId: device.id,
      sessionId: (created.data as { session: { id: string } }).session.id,
      name: 'gone.bin',
      mime: 'application/octet-stream',
      size: payload.length,
      sha256: digest,
    });
    await context.runtime.attachments.writeChunk({
      deviceId: device.id,
      uploadId: intent.id,
      offset: 0,
      bytes: payload,
    });
    await context.runtime.attachments.complete({ deviceId: device.id, uploadId: intent.id });
    const path = context.runtime.attachments.get(intent.id)?.tempName;
    assert.ok(path);
    assert.equal(existsSync(path), true);
    const collected = context.runtime.attachments.gc(Date.now() + 31 * 60 * 1000);
    assert.ok(collected >= 1);
    assert.equal(context.runtime.attachments.get(intent.id)?.state, 'expired');
    assert.equal(existsSync(path), false);
  } finally {
    teardownRemoteHarness(context);
  }
});

test('concurrent writeChunk is serialized and appends at offset', async () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context);
    const created = await context.tool.call({
      request_id: generateCanonicalId(),
      caller_id: 'test-caller',
      method: 'session.create',
      params: { workspace_id: context.workspaceId, task_id: context.taskId, agent_id: 'agent-claude-review' },
      idempotency_key: 'create-for-chunk-lock',
    });
    const intent = await context.runtime.attachments.begin({
      deviceId: device.id,
      sessionId: (created.data as { session: { id: string } }).session.id,
      name: 'lock.bin',
      mime: 'application/octet-stream',
      size: 32,
      sha256: 'd'.repeat(64),
    });
    const first = Buffer.alloc(16, 1);
    const second = Buffer.alloc(16, 2);
    const results = await Promise.allSettled([
      context.runtime.attachments.writeChunk({
        deviceId: device.id,
        uploadId: intent.id,
        offset: 0,
        bytes: first,
      }),
      context.runtime.attachments.writeChunk({
        deviceId: device.id,
        uploadId: intent.id,
        offset: 0,
        bytes: second,
      }),
    ]);
    assert.equal(results.filter((entry) => entry.status === 'fulfilled').length, 1);
    assert.equal(results.filter((entry) => entry.status === 'rejected').length, 1);
    const afterConflict = context.runtime.attachments.get(intent.id);
    assert.equal(afterConflict?.received, 16);
    const part = await readFile(join(context.dir, 'remote-uploads', `${intent.id}.part`));
    assert.equal(part.length, 16);
    assert.ok(part.equals(first) || part.equals(second));
    await context.runtime.attachments.writeChunk({
      deviceId: device.id,
      uploadId: intent.id,
      offset: 16,
      bytes: Buffer.alloc(16, 3),
    });
    assert.equal(context.runtime.attachments.get(intent.id)?.received, 32);
    const combined = await readFile(join(context.dir, 'remote-uploads', `${intent.id}.part`));
    assert.equal(combined.length, 32);
    assert.equal(combined.subarray(16).equals(Buffer.alloc(16, 3)), true);
    assert.equal(context.runtime.attachments.writeLockCount(), 0);
  } finally {
    teardownRemoteHarness(context);
  }
});

test('writeLocks are released after complete and GC', async () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context);
    const created = await context.tool.call({
      request_id: generateCanonicalId(),
      caller_id: 'test-caller',
      method: 'session.create',
      params: { workspace_id: context.workspaceId, task_id: context.taskId, agent_id: 'agent-claude-review' },
      idempotency_key: 'create-for-lock-gc',
    });
    const payload = Buffer.from('lock-release');
    const digest = createHash('sha256').update(payload).digest('hex');
    const intent = await context.runtime.attachments.begin({
      deviceId: device.id,
      sessionId: (created.data as { session: { id: string } }).session.id,
      name: 'lock-release.bin',
      mime: 'application/octet-stream',
      size: payload.length,
      sha256: digest,
    });
    await context.runtime.attachments.writeChunk({
      deviceId: device.id,
      uploadId: intent.id,
      offset: 0,
      bytes: payload,
    });
    await context.runtime.attachments.complete({ deviceId: device.id, uploadId: intent.id });
    assert.equal(context.runtime.attachments.writeLockCount(), 0);
    context.runtime.attachments.gc(Date.now() + 31 * 60 * 1000);
    assert.equal(context.runtime.attachments.writeLockCount(), 0);
  } finally {
    teardownRemoteHarness(context);
  }
});
