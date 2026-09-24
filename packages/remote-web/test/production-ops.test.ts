import { describe, expect, it, vi } from 'vitest';
import {
  AUTH_PROTOCOL,
  MAX_FILE_PREVIEW_BYTES,
  RemoteProtocolError,
  bytesToBase64Url,
  exportPublicJwk,
  generateCanonicalId,
  generateP256KeyPair,
  sha256Hex,
  splitSnapshotParts,
  type RemoteMethod,
  type RemoteStateSnapshot,
} from '@gian/remote-protocol';
import { MemoryEncryptedHostCache, type EncryptedHostCache } from '../src/cache/encrypted-cache.js';
import { createProductionController } from '../src/controller/create.js';
import {
  READ_COMMAND_TIMEOUT_MS,
  READ_STALL_RECONNECT_MS,
  SNAPSHOT_ASSEMBLY_TIMEOUT_MS,
} from '../src/controller/production.js';
import { applyCanonicalEvent, applySnapshotToState, applyStatePatch } from '../src/controller/apply-control.js';
import { advanceCanonicalSequence, occupiesCanonicalSequence } from '../src/controller/event-sequence.js';
import { viewerFromPreviewError } from '../src/controller/file-preview.js';
import {
  nextUnknownCommandId,
  takePendingOnDisconnect,
} from '../src/controller/pending-commands.js';
import type { DeviceRelayClientOptions, DeviceRelayLike } from '../src/transport/relay-client.js';
import { sessionSendParams } from '../src/controller/session-send.js';
import { emptyDraft, type RemoteFileHandle, type RemoteUiState } from '../src/controller/types.js';
import { MemoryBrowserIdentityStore } from '../src/transport/identity.js';
import { MemoryCookieJar, type RemoteHttpClient } from '../src/transport/http.js';
import { sampleInteraction } from '../src/scenarios.js';

const hostId = '11111111-1111-4111-8111-111111111111';
const hostB = '22222222-2222-4222-8222-222222222222';
const deviceA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const deviceB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function emptyState(): RemoteUiState {
  return {
    auth: { kind: 'pairing', pairing: { kind: 'enter-code', attemptsLeft: 5 } },
    connection: { kind: 'online' },
    hosts: [],
    currentHostId: hostId,
    workspaces: [],
    tasks: [],
    sessions: [],
    interactions: [],
    interactionPhases: {},
    interactionErrors: {},
    capabilities: {},
    catalogRevision: 'rev-0',
    catalog: null,
    catalogInvalidated: false,
    logos: {},
    snapshotReceivedAt: null,
    view: { kind: 'empty' },
    mobilePage: 'chat',
    transcripts: {},
    drafts: {},
    queueNotice: null,
    fileViewer: null,
    fileDownload: { status: 'idle' },
    mutations: {},
    unknownCommandId: null,
    settings: { theme: 'light', accent: 'azure' },
  };
}

describe('production controller operations', () => {
  it('restores remembered Hosts without GitHub even when the cookie exposes only one Host', async () => {
    const requests: string[] = [];
    const { controller } = await pairedController({ extraHosts: [hostB], directoryHostIds: [hostId],
      autoRestore: true, onRequest: path => requests.push(path) });
    try {
      await viWait(async () => controller.state.hosts.length === 2);
      expect(controller.state.hosts.map(host => host.id)).toEqual([hostId, hostB]);
      expect(controller.state.account?.status).toBe('signed_out');
      expect(requests.some(path => path.startsWith('/api/v1/account/'))).toBe(false);
    } finally { controller.close(); }
  });
  it('resolves relative paths before preview and reports an error even when the resolved label changed', async () => {
    const relays: FakeRelay[] = [];
    const { controller } = await pairedController({ createRelay(input) {
      const relay = new FakeRelay(input); relays.push(relay); return relay;
    } });
    try {
      controller.actions.challengeLogin(hostId);
      await viWait(async () => controller.state.connection.kind === 'online');
      const handle = { id: './README.md:2', sessionId: generateCanonicalId(), label: 'README.md:2' };
      controller.actions.openFile(handle);
      await viWait(async () => relays[0]!.sent.some(message => message.method === 'file.resolve'));
      const resolving = relays[0]!.sent.find(message => message.method === 'file.resolve')!;
      expect(resolving.params).toEqual({ session_id: handle.sessionId, reference: handle.id });
      const resolved = { ...handle, id: generateCanonicalId(), label: 'README.md' };
      await relays[0]!.emit({ type: 'command.result', command_id: resolving.command_id, ok: true,
        data: previewResult(resolved, generateCanonicalId(), 4).file });
      await viWait(async () => relays[0]!.sent.some(message => message.method === 'file.preview'));
      const preview = relays[0]!.sent.find(message => message.method === 'file.preview')!;
      expect(preview.params).toEqual({ handle_id: resolved.id });
      await relays[0]!.emit({ type: 'command.result', command_id: preview.command_id, ok: false,
        error: { code: 'FILE_REFERENCE_EXPIRED', message: 'changed' } });
      await viWait(async () => controller.state.fileViewer?.status === 'expired');
      expect(controller.state.fileViewer?.handle.label).toBe('README.md');
    } finally { controller.close(); }
  });
  it('ignores an outstanding automatic restore after the user chooses Add computer', async () => {
    let release!: () => void;
    let reached = false;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const connect = vi.fn((input: DeviceRelayClientOptions) => new FakeRelay(input));
    const { controller } = await pairedController({
      autoRestore: true, createRelay: connect,
      async beforeGet() { reached = true; await waiting; },
    });
    try {
      await viWait(async () => reached);
      controller.actions.startPairing();
      release();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(connect).not.toHaveBeenCalled();
      expect(controller.state).toMatchObject({ addingHost: true, currentHostId: null,
        auth: { kind: 'pairing', pairing: { kind: 'enter-code' } } });
    } finally { release(); controller.close(); }
  });
  it('requests a full snapshot after switching back and keeps drafts partitioned by Host', async () => {
    const relays: FakeRelay[] = [];
    const { controller } = await pairedController({
      extraHosts: [hostB],
      createRelay(input) { const relay = new FakeRelay(input); relays.push(relay); return relay; },
    });
    try {
      controller.actions.challengeLogin(hostId);
      await viWait(async () => controller.state.connection.kind === 'online');
      await relays[0]!.emit({ ...sampleSnapshot(hostId, 'Office'), event_sequence: 1 });
      const draftId = generateCanonicalId();
      controller.actions.setDraftText(draftId, 'unsent office draft');
      controller.actions.selectHost(hostB);
      expect(controller.state.sessions).toEqual([]);
      expect(controller.state.drafts[draftId]).toBeUndefined();
      await viWait(async () => relays.length === 2 && controller.state.connection.kind === 'online');
      controller.actions.selectHost(hostId);
      expect(controller.state.drafts[draftId]?.text).toBe('unsent office draft');
      await viWait(async () => relays.length === 3 && relays[2]!.sent.some(message => message.method === 'state.refresh'));
      expect(relays[2]!.sent.some(message => message.type === 'resume.request')).toBe(false);
    } finally { controller.close(); }
  });
  it('keeps other Hosts selectable while the remembered computer fails authentication', async () => {
    const { controller } = await pairedController({
      extraHosts: [hostB], autoRestore: true, reconnectBaseMs: 10_000,
      hostSelection: { get: () => hostId, set() {} },
      beforeRequest(path, body) {
        if (path === '/api/v1/sessions/device-challenge' && (body as { host_id: string }).host_id === hostId) {
          throw new Error('network failed');
        }
      },
      createRelay: input => new FakeRelay(input),
    });
    try {
      await viWait(async () => controller.state.connectionFailed === true);
      expect(controller.state.connectionPhase).toBe('auth');
      expect(controller.state.hosts.map(host => host.id)).toEqual([hostId, hostB]);
      controller.actions.selectHost(hostB);
      await viWait(async () => controller.state.connection.kind === 'online');
      expect(controller.state.currentHostId).toBe(hostB);
    } finally { controller.close(); }
  });
  it('restores the selected paired Host and keeps the full list available', async () => {
    let selected: string | null = hostB;
    const connected: string[] = [];
    const { controller } = await pairedController({
      extraHosts: [hostB], autoRestore: true,
      hostSelection: { get: () => selected, set: id => { selected = id; } },
      createRelay(input) { connected.push(input.hostId); return new FakeRelay(input); },
    });
    try {
      await viWait(async () => controller.state.connection.kind === 'online');
      expect(connected).toEqual([hostB]);
      expect(controller.state.hosts.map(host => host.id)).toEqual([hostId, hostB]);
      controller.actions.selectHost(hostId);
      await viWait(async () => connected.length === 2);
      expect(selected).toBe(hostId);
    } finally { controller.close(); }
  });

  it('does not connect an unknown remembered selection when several paired Hosts exist', async () => {
    let selected: string | null = 'removed-host';
    const connect = vi.fn((input: DeviceRelayClientOptions) => new FakeRelay(input));
    const { controller } = await pairedController({
      extraHosts: [hostB], autoRestore: true, createRelay: connect,
      hostSelection: { get: () => selected, set: id => { selected = id; } },
    });
    try {
      await viWait(async () => controller.state.hosts.length === 2);
      expect(controller.state.currentHostId).toBeNull();
      expect(connect).not.toHaveBeenCalled();
      expect(selected).toBeNull();
    } finally { controller.close(); }
  });

  it('adding a computer suppresses old-Host restore and cancel keeps existing keys', async () => {
    const paths: string[] = [];
    const { controller, identity } = await pairedController({
      autoRestore: true, onRequest: path => paths.push(path),
      createRelay: input => new FakeRelay(input),
    });
    try {
      await viWait(async () => controller.state.connection.kind === 'online');
      const key = await identity.hostIdentity(hostId);
      controller.actions.startPairing();
      const previousCalls = paths.length;
      controller.actions.restoreBrowserSession();
      await Promise.resolve();
      expect(paths).toHaveLength(previousCalls);
      expect(controller.state).toMatchObject({ addingHost: true, currentHostId: null,
        auth: { kind: 'pairing', pairing: { kind: 'enter-code' } } });
      controller.actions.cancelPairing();
      await viWait(async () => controller.state.connection.kind === 'online');
      expect(controller.state.currentHostId).toBe(hostId);
      expect(await identity.hostIdentity(hostId)).toBe(key);
    } finally { controller.close(); }
  });

  it('refreshes all pairings after adding a second Host without a page reload', async () => {
    const { controller, identity } = await pairedController({
      autoRestore: true, pairingHost: hostB, createRelay: input => new FakeRelay(input),
    });
    try {
      await viWait(async () => controller.state.connection.kind === 'online');
      const originalKey = await identity.hostIdentity(hostId);
      controller.actions.startPairing();
      controller.actions.submitPairingCode('K7DM-F2Q9');
      await viWait(async () => controller.state.currentHostId === hostB
        && controller.state.connection.kind === 'online' && controller.state.addingHost === false);
      expect(controller.state.hosts.map(host => host.id)).toEqual([hostId, hostB]);
      expect(await identity.hostIdentity(hostId)).toBe(originalKey);
      controller.actions.selectHost(hostId);
      await viWait(async () => controller.state.currentHostId === hostId && controller.state.connection.kind === 'online');
    } finally { controller.close(); }
  });

  it.each(['send-failure', 'command-rejected'] as const)('observes command rejection while transport send is pending: %s', async (failure) => {
    let relay: FakeRelay | undefined;
    let releaseSend!: () => void;
    let rejectSend!: (error: Error) => void;
    const sending = new Promise<void>((resolve, reject) => {
      releaseSend = resolve;
      rejectSend = reject;
    });
    const { controller } = await pairedController({
      createRelay(input) {
        relay = new FakeRelay(input);
        const send = relay.sendControl.bind(relay);
        relay.sendControl = async (message) => {
          await send(message);
          if ((message as { method?: string }).method === 'session.subscribe') await sending;
        };
        return relay;
      },
    });
    try {
      controller.actions.challengeLogin(hostId);
      await viWait(async () => controller.state.connection.kind === 'online');
      controller.actions.retryTranscript(generateCanonicalId());
      await viWait(async () => relay!.sent.some(message => message.method === 'session.subscribe'));
      const request = relay!.sent.find(message => message.method === 'session.subscribe')!;
      if (failure === 'command-rejected') {
        await relay!.emit({
          type: 'command.result',
          command_id: String(request.command_id),
          ok: false,
          error: { code: 'UNKNOWN_OUTCOME', message: 'disconnected before session.subscribe returned' },
        });
      } else rejectSend(new RemoteProtocolError('HOST_OFFLINE', 'send failed before receipt'));
      // Let the runtime's unhandled-rejection check run before transport settles.
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(controller.state.mutations[String(request.command_id)]?.phase)
        .toBe(failure === 'command-rejected' ? 'unknown' : 'failed');
    } finally {
      releaseSend();
      controller.close();
    }
  });

  it('allows slow Host projections to finish before rebuilding the Relay', () => {
    expect(READ_STALL_RECONNECT_MS).toBeGreaterThanOrEqual(30_000);
    expect(READ_COMMAND_TIMEOUT_MS).toBeGreaterThanOrEqual(READ_STALL_RECONNECT_MS * 3);
  });

  it('keeps a message draft until the Host canonically accepts session.send', async () => {
    let relay: FakeRelay | undefined;
    const { controller } = await pairedController({
      createRelay(input) {
        relay = new FakeRelay(input);
        return relay;
      },
    });
    controller.actions.challengeLogin(hostId);
    await viWait(async () => controller.state.connection.kind === 'online');

    const sessionId = generateCanonicalId();
    controller.actions.setDraftText(sessionId, 'message from mobile');
    controller.actions.sendDraft(sessionId);
    await viWait(async () => relay!.sent.some(message => (
      message.type === 'command.request' && message.method === 'session.send'
    )));
    expect(controller.state.drafts[sessionId]?.text).toBe('message from mobile');

    const request = relay!.sent.find(message => message.method === 'session.send')!;
    await relay!.emit({
      type: 'command.result',
      command_id: String(request.command_id),
      ok: true,
      data: { session: remoteSession(sessionId) },
    });
    await viWait(async () => controller.state.drafts[sessionId]?.text === '');
    controller.close();
  });

  it('does not erase a newer edit when an earlier session.send succeeds', async () => {
    let relay: FakeRelay | undefined;
    const { controller } = await pairedController({
      createRelay(input) {
        relay = new FakeRelay(input);
        return relay;
      },
    });
    controller.actions.challengeLogin(hostId);
    await viWait(async () => controller.state.connection.kind === 'online');

    const sessionId = generateCanonicalId();
    controller.actions.setDraftText(sessionId, 'first message');
    controller.actions.sendDraft(sessionId);
    await viWait(async () => relay!.sent.some(message => message.method === 'session.send'));
    const request = relay!.sent.find(message => message.method === 'session.send')!;
    controller.actions.setDraftText(sessionId, 'next message');
    await relay!.emit({
      type: 'command.result',
      command_id: String(request.command_id),
      ok: true,
      data: { session: remoteSession(sessionId) },
    });

    await viWait(async () => controller.state.mutations[String(request.command_id)]?.phase === 'succeeded');
    expect(controller.state.drafts[sessionId]?.text).toBe('next message');
    controller.close();
  });

  it('keeps a message draft when no live Relay can accept it', async () => {
    const { controller } = await pairedController();
    const sessionId = generateCanonicalId();
    controller.actions.setDraftText(sessionId, 'do not lose this');

    controller.actions.sendDraft(sessionId);
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(controller.state.drafts[sessionId]?.text).toBe('do not lose this');
    controller.close();
  });

  it('clears the retained draft after reconnect confirms the original command id', async () => {
    const relays: FakeRelay[] = [];
    const { controller } = await pairedController({
      createRelay(input) {
        const relay = new FakeRelay(input);
        relays.push(relay);
        return relay;
      },
    });
    controller.actions.challengeLogin(hostId);
    await viWait(async () => controller.state.connection.kind === 'online');

    const sessionId = generateCanonicalId();
    controller.actions.setDraftText(sessionId, 'survive reconnect');
    controller.actions.sendDraft(sessionId);
    await viWait(async () => relays[0]!.sent.some(message => message.method === 'session.send'));
    const original = relays[0]!.sent.find(message => message.method === 'session.send')!;
    relays[0]!.close('socket_closed');

    await viWait(async () => relays.length === 2 && relays[1]!.sent.some(message => (
      message.method === 'command.status'
    )));
    expect(controller.state.drafts[sessionId]?.text).toBe('survive reconnect');
    const statusRequest = relays[1]!.sent.find(message => message.method === 'command.status')!;
    await relays[1]!.emit({
      type: 'command.result',
      command_id: String(statusRequest.command_id),
      ok: true,
      data: {
        command_id: String(original.command_id),
        state: 'succeeded',
        result: { session: remoteSession(sessionId) },
      },
    });

    await viWait(async () => controller.state.drafts[sessionId]?.text === '');
    expect(controller.state.mutations[String(original.command_id)]?.phase).toBe('succeeded');
    controller.close();
  });

  it('rebuilds a stalled Relay and replays transcript reads instead of status lookups', async () => {
    const relays: FakeRelay[] = [];
    const { controller } = await pairedController({
      readStallMs: 20,
      readTimeoutMs: 1_000,
      createRelay(input) {
        const relay = new FakeRelay(input);
        relays.push(relay);
        return relay;
      },
    });
    controller.actions.challengeLogin(hostId);
    await viWait(async () => controller.state.connection.kind === 'online');
    const initialSync = relays[0]!.sent.find(message => message.method === 'state.refresh');
    await relays[0]!.emit({
      type: 'command.result',
      command_id: String(initialSync!.command_id),
      ok: true,
      data: { ...sampleSnapshot(hostId, 'Office Mac'), event_sequence: 5 },
    });

    const sessionId = generateCanonicalId();
    controller.actions.retryTranscript(sessionId);
    await viWait(async () => relays[0]!.sent.some(message => message.method === 'session.page'));
    const originalPage = relays[0]!.sent.find(message => message.method === 'session.page')!;

    await viWait(async () => relays.length === 2 && relays[1]!.sent.some(message => (
      message.method === 'session.subscribe'
    )));
    expect(relays[1]!.sent.some(message => message.method === 'command.status')).toBe(false);
    const replayedSubscribe = relays[1]!.sent.find(message => message.method === 'session.subscribe')!;
    await relays[1]!.emit({
      type: 'command.result',
      command_id: String(replayedSubscribe.command_id),
      ok: true,
      data: { session: remoteSession(sessionId), cursor: 'session-rev-1' },
    });

    await viWait(async () => relays[1]!.sent.some(message => message.method === 'session.page'));
    const replayedPage = relays[1]!.sent.find(message => message.method === 'session.page')!;
    expect(replayedPage.command_id).not.toBe(originalPage.command_id);
    await relays[1]!.emit({
      type: 'command.result',
      command_id: String(replayedPage.command_id),
      ok: true,
      data: { session_id: sessionId, has_more: false, items: [] },
    });

    await viWait(async () => controller.state.transcripts[sessionId]?.hydrated === true);
    expect(controller.state.transcripts[sessionId]?.historyError).toBeNull();
    controller.close();
  });

  it('does not deadlock reconnect when the first replayed read also stalls', async () => {
    const relays: FakeRelay[] = [];
    const { controller } = await pairedController({
      readStallMs: 20,
      readTimeoutMs: 1_000,
      createRelay(input) {
        const relay = new FakeRelay(input);
        relays.push(relay);
        return relay;
      },
    });
    controller.actions.challengeLogin(hostId);
    await viWait(async () => controller.state.connection.kind === 'online');
    const initialSync = relays[0]!.sent.find(message => message.method === 'state.refresh');
    await relays[0]!.emit({
      type: 'command.result',
      command_id: String(initialSync!.command_id),
      ok: true,
      data: { ...sampleSnapshot(hostId, 'Office Mac'), event_sequence: 5 },
    });

    controller.actions.retryTranscript(generateCanonicalId());
    await viWait(async () => relays.length >= 2 && relays[1]!.sent.some(message => (
      message.method === 'session.subscribe' || message.method === 'session.page'
    )));
    expect(controller.state.unknownCommandId).toBeNull();

    // Leave the replay on relay 2 unanswered. Its own stall watchdog must
    // release connectInFlight so the scheduled reconnect can create relay 3.
    await viWait(async () => relays.length >= 3, 1_500);
    controller.close();
  });

  it('keeps retrying after repeated handshake failures until the Host is reachable', async () => {
    const relays: FakeRelay[] = [];
    let failuresRemaining = 4;
    const { controller } = await pairedController({
      reconnectBaseMs: 5,
      reconnectMaxMs: 20,
      createRelay(input) {
        const isReconnect = relays.length > 0;
        const relay = new FakeRelay(input, async () => {
          if (isReconnect && failuresRemaining > 0) {
            failuresRemaining -= 1;
            throw new RemoteProtocolError('HOST_OFFLINE', 'temporary handshake failure');
          }
        });
        relays.push(relay);
        return relay;
      },
    });
    controller.actions.challengeLogin(hostId);
    await viWait(async () => controller.state.connection.kind === 'online');

    relays[0]!.close('socket_closed');

    await viWait(async () => relays.length >= 6 && relays.at(-1)?.isOpen === true, 1_500);
    expect(controller.state.connection.kind).toBe('online');
    expect(failuresRemaining).toBe(0);
    controller.close();
  });

  it('reconnects immediately when the browser comes back online', async () => {
    const relays: FakeRelay[] = [];
    const { controller } = await pairedController({
      reconnectBaseMs: 1_000,
      reconnectMaxMs: 1_000,
      createRelay(input) {
        const relay = new FakeRelay(input);
        relays.push(relay);
        return relay;
      },
    });
    try {
      controller.actions.challengeLogin(hostId);
      await viWait(async () => controller.state.connection.kind === 'online');

      window.dispatchEvent(new Event('offline'));
      expect(controller.state.connection.kind).toBe('browser_offline');
      window.dispatchEvent(new Event('online'));

      await viWait(async () => relays.length >= 2 && relays[1]!.isOpen, 500);
      expect(controller.state.connection.kind).toBe('online');
    } finally {
      controller.close();
    }
  });

  it('Refresh state immediately reconnects an unavailable Relay and shows progress', async () => {
    const relays: FakeRelay[] = [];
    const { controller } = await pairedController({
      createRelay(input) {
        const relay = new FakeRelay(input);
        relays.push(relay);
        return relay;
      },
    });
    controller.actions.challengeLogin(hostId);
    await viWait(async () => controller.state.connection.kind === 'online');

    relays[0]!.close('socket_closed');
    expect(controller.state.connection.kind).toBe('relay_reconnecting');
    controller.actions.refreshState();
    expect(controller.state.connection.kind).toBe('resyncing');

    await viWait(async () => relays.length >= 2 && relays[1]!.sent.some(message => (
      message.method === 'state.refresh'
    )));
    const refresh = relays[1]!.sent.find(message => message.method === 'state.refresh')!;
    await relays[1]!.emit({
      type: 'command.result',
      command_id: String(refresh.command_id),
      ok: true,
      data: sampleSnapshot(hostId, 'Office Mac'),
    });
    await viWait(async () => controller.state.connection.kind === 'online');
    controller.close();
  });

  it('fresh connect requests a full state refresh instead of waiting for a host push', async () => {
    const relays: FakeRelay[] = [];
    const { controller } = await pairedController({
      createRelay(input) {
        const relay = new FakeRelay(input);
        relays.push(relay);
        return relay;
      },
    });
    try {
      controller.actions.challengeLogin(hostId);
      await viWait(async () => controller.state.connection.kind === 'online');
      await viWait(async () => relays[0]!.sent.some(message => (
        message.type === 'command.request' && message.method === 'state.refresh'
      )));
    } finally {
      controller.close();
    }
  });

  it('reconnect with prior state resumes without a full state refresh', async () => {
    const relays: FakeRelay[] = [];
    const { controller } = await pairedController({
      createRelay(input) {
        const relay = new FakeRelay(input);
        relays.push(relay);
        return relay;
      },
    });
    try {
      controller.actions.challengeLogin(hostId);
      await viWait(async () => controller.state.connection.kind === 'online');
      await viWait(async () => relays[0]!.isOpen);
      const refresh = relays[0]!.sent.find(message => message.method === 'state.refresh');
      await relays[0]!.emit({
        type: 'command.result',
        command_id: String(refresh!.command_id),
        ok: true,
        data: { ...sampleSnapshot(hostId, 'Office Mac'), event_sequence: 5 },
      });
      relays[0]!.close('socket_closed');
      await viWait(async () => relays.length >= 2 && relays[1]!.isOpen, 2_000);
      await viWait(async () => relays[1]!.sent.some(message => message.type === 'resume.request'));
      expect(relays[1]!.sent.some(message => message.method === 'state.refresh')).toBe(false);
      const resume = relays[1]!.sent.find(message => message.type === 'resume.request');
      expect(resume).toMatchObject({ after_event_sequence: 4, current_revision: 'rev-1' });
    } finally {
      controller.close();
    }
  });

  it('resume with an included transcript page hydrates without a session.page round trip', async () => {
    const relays: FakeRelay[] = [];
    const { controller } = await pairedController({
      createRelay(input) {
        const relay = new FakeRelay(input);
        relays.push(relay);
        return relay;
      },
    });
    const sessionId = generateCanonicalId();
    try {
      controller.actions.challengeLogin(hostId);
      await viWait(async () => controller.state.connection.kind === 'online');
      const initialSync = relays[0]!.sent.find(message => message.method === 'state.refresh');
      await relays[0]!.emit({
        type: 'command.result',
        command_id: String(initialSync!.command_id),
        ok: true,
        data: {
          ...sampleSnapshot(hostId, 'Office Mac'),
          event_sequence: 5,
          sessions: [remoteSession(sessionId)],
        },
      });
      controller.actions.selectSession(sessionId);
      await viWait(async () => relays[0]!.sent.some(message => message.method === 'session.page'));
      const pageCommand = relays[0]!.sent.find(message => message.method === 'session.page')!;
      await relays[0]!.emit({
        type: 'command.result',
        command_id: String(pageCommand.command_id),
        ok: true,
        data: { session_id: sessionId, has_more: false, items: [] },
      });
      await viWait(async () => controller.state.transcripts[sessionId]?.hydrated === true);

      relays[0]!.close('socket_closed');
      await viWait(async () => relays.length >= 2 && relays[1]!.isOpen, 2_000);
      await viWait(async () => relays[1]!.sent.some(message => message.type === 'resume.request'));
      await relays[1]!.emit({
        type: 'resume.ok',
        host_generation: generateCanonicalId(),
        replay_from: 5,
        replay_through: 5,
        revision: 'rev-1',
        transcript_included: true,
      });
      await relays[1]!.emit({
        type: 'transcript.page',
        session_id: sessionId,
        has_more: false,
        items: [{
          id: generateCanonicalId(),
          turn_id: generateCanonicalId(),
          turn: 0,
          ts: Date.now(),
          kind: 'user',
          text: 'pushed history',
        }],
      });
      await viWait(async () => (controller.state.transcripts[sessionId]?.items.length ?? 0) === 1);
      expect(controller.state.transcripts[sessionId]?.hydrated).toBe(true);
      expect(relays[1]!.sent.some(message => message.method === 'session.page')).toBe(false);
    } finally {
      controller.close();
    }
  });

  it('a host.offline notice shows the host offline and retries with a short cap', async () => {
    const relays: FakeRelay[] = [];
    const { controller } = await pairedController({
      reconnectBaseMs: 20,
      createRelay(input) {
        const relay = new FakeRelay(input);
        relays.push(relay);
        return relay;
      },
    });
    try {
      controller.actions.challengeLogin(hostId);
      await viWait(async () => controller.state.connection.kind === 'online');
      const initialSync = relays[0]!.sent.find(message => message.method === 'state.refresh');
      await relays[0]!.emit({
        type: 'command.result',
        command_id: String(initialSync!.command_id),
        ok: true,
        data: { ...sampleSnapshot(hostId, 'Office Mac'), event_sequence: 5 },
      });
      relays[0]!.emitNotice({ type: 'host.offline', host_id: hostId });
      expect(controller.state.connection.kind).toBe('host_offline');
      await viWait(async () => relays.length >= 2 && relays[1]!.isOpen, 1_000);
      await viWait(async () => controller.state.connection.kind === 'online');
    } finally {
      controller.close();
    }
  });

  it('a host.online notice reconnects immediately without waiting out the backoff', async () => {
    const relays: FakeRelay[] = [];
    const { controller } = await pairedController({
      reconnectBaseMs: 30_000,
      createRelay(input) {
        const relay = new FakeRelay(input);
        relays.push(relay);
        return relay;
      },
    });
    try {
      controller.actions.challengeLogin(hostId);
      await viWait(async () => controller.state.connection.kind === 'online');
      relays[0]!.close('socket_closed');
      expect(controller.state.connection.kind).toBe('relay_reconnecting');
      relays[0]!.emitNotice({ type: 'host.online', host_id: hostId });
      await viWait(async () => relays.length >= 2 && relays[1]!.isOpen, 1_000);
      await viWait(async () => controller.state.connection.kind === 'online');
    } finally {
      controller.close();
    }
  });

  it('keeps draft and selected session until a split snapshot is fully verified', async () => {
    const relays: FakeRelay[] = [];
    const { controller } = await pairedController({
      createRelay(input) {
        const relay = new FakeRelay(input);
        relays.push(relay);
        return relay;
      },
    });
    const sessionId = generateCanonicalId();
    const full = {
      ...sampleSnapshot(hostId, 'Office Mac'),
      event_sequence: 9,
      catalog_revision: 'full-snapshot',
      sessions: [remoteSession(sessionId)],
    };
    try {
      controller.actions.challengeLogin(hostId);
      await viWait(async () => controller.state.connection.kind === 'online');
      const initialSync = relays[0]!.sent.find(message => message.method === 'state.refresh');
      await relays[0]!.emit({
        type: 'command.result',
        command_id: String(initialSync!.command_id),
        ok: true,
        data: { ...full, event_sequence: 5, catalog_revision: 'old-snapshot' },
      });
      controller.actions.setDraftText(sessionId, 'Unsent work');
      controller.actions.refreshState();
      await viWait(async () => relays[0]!.sent.filter(message => message.method === 'state.refresh').length === 2);
      const refresh = relays[0]!.sent.filter(message => message.method === 'state.refresh').at(-1)!;
      await relays[0]!.emit({
        type: 'command.result', command_id: refresh.command_id, ok: true,
        data: { type: 'state.snapshot.pending', snapshot_id: full.snapshot_id },
      });
      const parts = await splitSnapshotParts(full, 256);
      await relays[0]!.emit(parts[0]!);
      expect(controller.state.catalogRevision).toBe('old-snapshot');
      expect(controller.state.view).toEqual({ kind: 'chat', sessionId });
      expect(controller.state.drafts[sessionId]?.text).toBe('Unsent work');
      expect(controller.state.mutations[String(refresh.command_id)]?.phase).toBe('pending');
      expect(controller.state.connection.kind).toBe('resyncing');
      for (const part of parts.slice(1)) await relays[0]!.emit(part);
      expect(controller.state.catalogRevision).toBe('full-snapshot');
      expect(controller.state.drafts[sessionId]?.text).toBe('Unsent work');
      expect(controller.state.mutations[String(refresh.command_id)]?.phase).toBe('succeeded');
      expect(controller.state.connection.kind).toBe('online');
    } finally {
      controller.close();
    }
  });

  it.each(['missing', 'hash', 'stale'] as const)('retains old state and reconnects for a %s split snapshot', async (failure) => {
    const relays: FakeRelay[] = [];
    const { controller } = await pairedController({
      createRelay(input) { const relay = new FakeRelay(input); relays.push(relay); return relay; },
    });
    try {
      controller.actions.challengeLogin(hostId);
      await viWait(async () => relays[0]?.sent.some(message => message.method === 'state.refresh') === true);
      const first = relays[0]!.sent.find(message => message.method === 'state.refresh')!;
      const sessionId = generateCanonicalId();
      const previous = { ...sampleSnapshot(hostId, 'Office'), event_sequence: 5, sessions: [remoteSession(sessionId)] };
      await relays[0]!.emit({ type: 'command.result', command_id: first.command_id, ok: true, data: previous });
      controller.actions.setDraftText(sessionId, 'Keep this draft');
      controller.actions.refreshState();
      await viWait(async () => relays[0]!.sent.filter(message => message.method === 'state.refresh').length === 2);
      const refresh = relays[0]!.sent.filter(message => message.method === 'state.refresh').at(-1)!;
      const full = { ...previous, snapshot_id: generateCanonicalId(), catalog_revision: 'new-snapshot' };
      const parts = await splitSnapshotParts(full, 256);
      if (failure === 'missing') vi.useFakeTimers();
      await relays[0]!.emit({ type: 'command.result', command_id: refresh.command_id, ok: true, data: { type: 'state.snapshot.pending', snapshot_id: full.snapshot_id } });
      if (failure === 'missing') {
        await relays[0]!.emit(parts[0]!);
        await vi.advanceTimersByTimeAsync(SNAPSHOT_ASSEMBLY_TIMEOUT_MS);
      } else {
        if (failure === 'stale') {
          await relays[0]!.emit({ type: 'state.patch', host_generation: full.host_generation, event_sequence: 5, base_revision: 'rev-1', revision: 'rev-2', patch: {} });
        }
        for (const part of parts) await relays[0]!.emit(failure === 'hash' ? { ...part, payload_sha256: '0'.repeat(64) } : part);
      }
      expect(relays[0]!.isOpen).toBe(false);
      expect(controller.state.catalogRevision).toBe('cat-1');
      expect(controller.state.drafts[sessionId]?.text).toBe('Keep this draft');
      expect(controller.state.mutations[String(refresh.command_id)]?.phase).not.toBe('succeeded');
      // A late part from the retired transport cannot apply the abandoned snapshot.
      for (const part of parts) await relays[0]!.emit(part);
      expect(controller.state.catalogRevision).toBe('cat-1');
    } finally { controller.close(); vi.useRealTimers(); }
  });

  it('advances the local revision through replayed patches without requesting a full snapshot', async () => {
    const relays: FakeRelay[] = [];
    const { controller } = await pairedController({
      reconnectBaseMs: 10,
      createRelay(input) { const relay = new FakeRelay(input); relays.push(relay); return relay; },
    });
    try {
      controller.actions.challengeLogin(hostId);
      await viWait(async () => relays[0]?.sent.some(message => message.method === 'state.refresh') === true);
      const first = relays[0]!.sent.find(message => message.method === 'state.refresh')!;
      const full = { ...sampleSnapshot(hostId, 'Office'), event_sequence: 5 };
      await relays[0]!.emit({ type: 'command.result', command_id: first.command_id, ok: true, data: full });
      relays[0]!.close('socket_closed');
      await viWait(async () => relays[1]?.sent.some(message => message.type === 'resume.request') === true);
      await relays[1]!.emit({ type: 'resume.ok', host_generation: full.host_generation, replay_from: 5, replay_through: 7, revision: 'rev-3' });
      await relays[1]!.emit({ type: 'state.patch', host_generation: full.host_generation, event_sequence: 5, base_revision: 'rev-1', revision: 'rev-2', patch: {} });
      await relays[1]!.emit({ type: 'state.patch', host_generation: full.host_generation, event_sequence: 6, base_revision: 'rev-2', revision: 'rev-3', patch: {} });
      expect(relays[1]!.sent.filter(message => message.method === 'state.refresh')).toHaveLength(0);
      relays[1]!.close('socket_closed');
      await viWait(async () => relays[2]?.sent.some(message => message.type === 'resume.request') === true);
      expect(relays[2]!.sent.find(message => message.type === 'resume.request')).toMatchObject({ current_revision: 'rev-3', after_event_sequence: 6 });
    } finally { controller.close(); }
  });

  it('Refresh state rechecks an accepted send without sending the message twice', async () => {
    const relays: FakeRelay[] = [];
    const { controller } = await pairedController({
      createRelay(input) {
        const relay = new FakeRelay(input);
        relays.push(relay);
        return relay;
      },
    });
    controller.actions.challengeLogin(hostId);
    await viWait(async () => controller.state.connection.kind === 'online');

    const sessionId = generateCanonicalId();
    controller.actions.setDraftText(sessionId, 'check this send');
    controller.actions.sendDraft(sessionId);
    await viWait(async () => relays[0]!.sent.some(message => message.method === 'session.send'));
    const original = relays[0]!.sent.find(message => message.method === 'session.send')!;
    relays[0]!.close('socket_closed');

    await viWait(async () => relays.length >= 2 && relays[1]!.sent.some(message => (
      message.method === 'command.status'
    )));
    const firstStatus = relays[1]!.sent.find(message => message.method === 'command.status')!;
    await relays[1]!.emit({
      type: 'command.result',
      command_id: String(firstStatus.command_id),
      ok: true,
      data: { command_id: String(original.command_id), state: 'accepted' },
    });
    await viWait(async () => controller.state.mutations[String(original.command_id)]?.phase === 'unknown');
    expect(controller.state.drafts[sessionId]?.text).toBe('check this send');

    controller.actions.refreshState();
    await viWait(async () => relays[1]!.sent.filter(message => message.method === 'command.status').length >= 2);
    const secondStatus = relays[1]!.sent.filter(message => message.method === 'command.status').at(-1)!;
    await relays[1]!.emit({
      type: 'command.result',
      command_id: String(secondStatus.command_id),
      ok: true,
      data: {
        command_id: String(original.command_id),
        state: 'succeeded',
        result: { session: remoteSession(sessionId) },
      },
    });

    await viWait(async () => controller.state.drafts[sessionId]?.text === '');
    expect(controller.state.unknownCommandId).toBeNull();
    expect(relays.flatMap(relay => relay.sent).filter(message => message.method === 'session.send')).toHaveLength(1);
    controller.close();
  });

  it('replaces an existing Host key when a fresh pairing generation is bound', async () => {
    const identity = new MemoryBrowserIdentityStore();
    await identity.createPending();
    const first = await identity.bindPending(hostId);

    await identity.createPending();
    const replacement = await identity.bindPending(hostId);

    expect(replacement.publicJwk).not.toEqual(first.publicJwk);
    expect((await identity.hostIdentity(hostId)).publicJwk).toEqual(replacement.publicJwk);
  });

  it('treats a missing remembered pairing as revoked and clears stale browser material', async () => {
    const { controller, identity, cache } = await pairedController({
      async beforeRequest(path) {
        if (path === '/api/v1/sessions/device-challenge') {
          throw new RemoteProtocolError('DEVICE_NOT_PAIRED', 'pairing was revoked');
        }
      },
    });

    controller.actions.challengeLogin(hostId);
    await viWait(async () => controller.state.connection.kind === 'device_revoked');

    expect(await identity.listHostIds()).not.toContain(hostId);
    expect(await cache.get(hostId)).toBeNull();
    controller.close();
  });

  it('clears browser material when an active relay is revoked', async () => {
    let relay: FakeRelay | undefined;
    const { controller, identity, cache } = await pairedController({
      createRelay(input) {
        relay = new FakeRelay(input);
        return relay;
      },
    });

    controller.actions.challengeLogin(hostId);
    await viWait(async () => controller.state.connection.kind === 'online');
    relay!.close('device_revoked');
    await viWait(async () => (await identity.listHostIds()).includes(hostId) === false);

    expect(controller.state.connection.kind).toBe('device_revoked');
    expect(await cache.get(hostId)).toBeNull();
    controller.actions.restartPairing();
    await viWait(async () => controller.state.auth.kind === 'pairing'
      && controller.state.auth.pairing.kind === 'enter-code'
      && controller.state.currentHostId === null);
    expect(controller.state.currentHostId).toBeNull();
    controller.close();
  });

  it('sends attachments, context, and composer document instead of dropping them', () => {
    const draft = {
      ...emptyDraft(),
      text: 'hello',
      attachments: [{ id: generateCanonicalId(), name: 'note.txt', mime: 'text/plain', size: 4 }],
      contextItems: [{ id: generateCanonicalId(), kind: 'pasted_text' as const, label: 'office spec' }],
      document: { id: generateCanonicalId(), label: 'brief' },
    };
    const params = sessionSendParams(generateCanonicalId(), draft);
    expect(params.items).toEqual(expect.arrayContaining([
      { type: 'text', text: 'hello' },
      { type: 'attachment', attachment_id: draft.attachments[0]!.id },
    ]));
    expect(params.context_items).toEqual([
      { type: 'pasted_text', text: 'office spec' },
    ]);
    expect(params.composer_document?.nodes).toEqual(expect.arrayContaining([
      { type: 'reference', handle_id: draft.document!.id },
    ]));
  });

  it('applies live events and state patches onto the current snapshot', () => {
    const sessionId = generateCanonicalId();
    const session = {
      id: sessionId,
      revision: '2',
      name: 'Live',
      task_id: null,
      workspace_id: generateCanonicalId(),
      agent: { id: generateCanonicalId(), name: 'Claude', proxy: 'claude' },
      status: 'running' as const,
      queue: { revision: '1', entries: [] },
      updated_at: new Date().toISOString(),
    };
    const afterEvent = applyCanonicalEvent(emptyState(), {
      type: 'event',
      host_generation: generateCanonicalId(),
      event_sequence: 0,
      event: { kind: 'session.updated', session },
    });
    expect(afterEvent.sessions[0]?.id).toBe(sessionId);
    const afterPatch = applyStatePatch({
      ...afterEvent,
      view: { kind: 'chat', sessionId },
      transcripts: {
        [sessionId]: {
          items: [], hydrated: true, streaming: false, hasOlder: false,
          loadingOlder: false, historyError: null,
        },
      },
      drafts: {
        [sessionId]: { text: 'private draft', attachments: [], contextItems: [], document: null },
      },
      interactions: [sampleInteraction({ session_id: sessionId })],
      fileViewer: {
        status: 'loading',
        handle: { id: generateCanonicalId(), sessionId, label: 'private.txt' },
      },
    }, {
      type: 'state.patch',
      host_generation: generateCanonicalId(),
      event_sequence: 1,
      base_revision: 'rev-0',
      revision: 'rev-1',
      patch: { sessions: { upsert: [], remove_ids: [sessionId] } },
    });
    expect(afterPatch.sessions).toEqual([]);
    expect(afterPatch.view).toEqual({ kind: 'empty' });
    expect(afterPatch.transcripts).toEqual({});
    expect(afterPatch.drafts).toEqual({});
    expect(afterPatch.interactions).toEqual([]);
    expect(afterPatch.fileViewer).toBeNull();
  });

  it('sends thinking and mode through the closed session.update command', async () => {
    const relays = new Map<string, FakeRelay>();
    const { controller } = await pairedController({
      createRelay(input) {
        const relay = new FakeRelay(input);
        relays.set(input.hostId, relay);
        return relay;
      },
    });
    controller.actions.challengeLogin(hostId);
    await viWait(async () => controller.state.connection.kind === 'online');

    const sessionId = generateCanonicalId();
    controller.actions.refreshState();
    await viWait(async () => relays.get(hostId)!.sent.some((message) => (
      message.type === 'command.request' && message.method === 'state.refresh'
    )));
    const refresh = relays.get(hostId)!.sent.find((message) => (
      message.type === 'command.request' && message.method === 'state.refresh'
    ))!;
    await relays.get(hostId)!.emit({
      type: 'command.result',
      command_id: String(refresh.command_id),
      ok: true,
      data: {
        ...sampleSnapshot(hostId, 'Office Mac'),
        sessions: [{
          id: sessionId,
          revision: 'session-rev-1',
          name: 'Configurable',
          task_id: null,
          workspace_id: generateCanonicalId(),
          agent: { id: generateCanonicalId(), name: 'Codex', proxy: 'codex' },
          model: 'gpt-5.3-codex',
          thinking: 'medium',
          service_tier: null,
          status: 'done',
          queue: { revision: 'queue-rev-1', entries: [] },
          updated_at: new Date().toISOString(),
        }],
      },
    });
    await viWait(async () => controller.state.sessions.some((session) => session.id === sessionId));

    controller.actions.updateSessionConfig(sessionId, { thinking: 'high', service_tier: 'fast' });
    await viWait(async () => relays.get(hostId)!.sent.some((message) => (
      message.type === 'command.request' && message.method === 'session.update'
    )));
    const update = relays.get(hostId)!.sent.find((message) => (
      message.type === 'command.request' && message.method === 'session.update'
    ))!;
    expect(update.params).toEqual({
      session_id: sessionId,
      session_revision: 'session-rev-1',
      thinking: 'high',
      service_tier: 'fast',
    });
    controller.close();
  });

  it('treats transcript items as live-only and requires contiguous canonical sequences', () => {
    expect(occupiesCanonicalSequence('event', 'transcript.item')).toBe(false);
    expect(occupiesCanonicalSequence('event', 'session.updated')).toBe(true);
    expect(occupiesCanonicalSequence('state.patch')).toBe(true);
    expect(advanceCanonicalSequence(-1, 1)).toBe('ok');
    expect(advanceCanonicalSequence(0, 1)).toBe('ok');
    expect(advanceCanonicalSequence(0, 2)).toBe('gap');
  });

  it('marks in-flight commands unknown on disconnect and rejects status lookups', async () => {
    let rejected: unknown;
    let resolved: unknown;
    const pending = new Map<string, {
      hostId: string;
      method: RemoteMethod;
      label: string;
      resolve?: (value: unknown) => void;
      reject?: (error: unknown) => void;
    }>([
      ['11111111-1111-4111-8111-111111111111', {
        hostId,
        method: 'session.send',
        label: 'session.send',
        resolve: (value) => {
          resolved = value;
        },
      }],
      ['22222222-2222-4222-8222-222222222222', {
        hostId,
        method: 'command.status',
        label: 'command.status',
        reject: (error) => {
          rejected = error;
        },
      }],
      ['33333333-3333-4333-8333-333333333333', {
        hostId: hostB,
        method: 'session.create',
        label: 'session.create',
      }],
    ]);
    const [recoverable] = takePendingOnDisconnect(pending, hostId);
    expect(recoverable).toMatchObject({
      commandId: '11111111-1111-4111-8111-111111111111',
      hostId,
      method: 'session.send',
      label: 'session.send',
    });
    recoverable?.resolve?.('accepted');
    expect(resolved).toBe('accepted');
    expect(pending.has('33333333-3333-4333-8333-333333333333')).toBe(true);
    expect(rejected).toBeInstanceOf(Error);
    expect(nextUnknownCommandId('cmd-1', 'cmd-1', 'succeeded')).toBeNull();
    expect(nextUnknownCommandId('cmd-1', 'cmd-2', 'succeeded')).toBe('cmd-1');
    expect(nextUnknownCommandId(null, 'cmd-1', 'unknown')).toBe('cmd-1');
  });

  it('maps file.preview errors onto the viewer instead of leaving it loading', () => {
    const handle: RemoteFileHandle = { id: generateCanonicalId(), sessionId: generateCanonicalId(), label: 'notes.md' };
    expect(viewerFromPreviewError(handle, 'FILE_TOO_LARGE').status).toBe('too_large');
    expect(viewerFromPreviewError(handle, 'FILE_REFERENCE_EXPIRED').status).toBe('expired');
    expect(viewerFromPreviewError(handle, 'INVALID_FRAME').status).toBe('error');
  });

  it('keeps key and cache when self-revoke fails', async () => {
    const { identity, cache, controller } = await pairedController({
      del() {
        throw new Error('revoke failed');
      },
    });
    controller.actions.disconnectHost(hostId);
    await viWait(async () => Boolean(controller.state.mutations[hostId]));
    expect(await identity.listHostIds()).toEqual([hostId]);
    expect(await cache.get(hostId)).not.toBeNull();
    controller.close();
  });

  it('clears key and cache only after the target Host self-revoke is accepted', async () => {
    const revoked: Array<{ path: string; token?: string }> = [];
    const { identity, cache, controller } = await pairedController({
      async del(path, _body, token) {
        revoked.push({ path, token });
        return { protocol: AUTH_PROTOCOL, host_id: hostId, status: 'revoked' };
      },
    });
    controller.actions.disconnectHost(hostId);
    await viWait(async () => (await identity.listHostIds()).length === 0);
    expect(revoked[0]?.path).toContain(hostId);
    expect(revoked[0]?.token).toBe(`token-${hostId}`);
    await expect(cache.get(hostId)).resolves.toBeNull();
    await cache.put(hostId, { leftover: true });
    controller.actions.logoutBrowser();
    await viWait(async () => (await cache.get(hostId)) === null);
    controller.close();
  });

  it('signs self-revoke with the target Host token and device, not the current Host', async () => {
    const revoked: Array<{ path: string; token?: string }> = [];
    const { identity, controller } = await pairedController({
      extraHosts: [hostB],
      async del(path, _body, token) {
        revoked.push({ path, token });
        return { protocol: AUTH_PROTOCOL, host_id: hostB, status: 'revoked' };
      },
    });
    await identity.createPending();
    await identity.bindPending(hostB);
    controller.actions.disconnectHost(hostB);
    await viWait(async () => revoked.length > 0);
    expect(revoked[0]?.path).toContain(hostB);
    expect(revoked[0]?.token).toBe(`token-${hostB}`);
    expect(await identity.listHostIds()).toEqual([hostId]);
    controller.close();
  });

  it('marks pending unknown on replaced close and recovers only on the original Host', async () => {
    const relays = new Map<string, FakeRelay>();
    const { controller } = await pairedController({
      extraHosts: [hostB],
      createRelay: (input) => {
        const relay = new FakeRelay(input);
        relays.set(input.hostId, relay);
        return relay;
      },
    });
    controller.actions.challengeLogin(hostId);
    await viWait(async () => controller.state.connection.kind === 'online');
    controller.actions.createSession({
      workspaceId: generateCanonicalId(),
      agentId: generateCanonicalId(),
      taskId: generateCanonicalId(),
      name: 'A job',
    });
    await viWait(async () => Boolean(relays.get(hostId)?.sent.find((message) => (
      message.type === 'command.request' && message.method === 'session.create'
    ))));
    const first = relays.get(hostId)!.sent.find((message) => (
      message.type === 'command.request' && message.method === 'session.create'
    ))!;
    const commandId = String(first.command_id);
    expect(controller.state.mutations[commandId]?.phase).toBe('pending');
    controller.actions.selectHost(hostB);
    await viWait(async () => controller.state.connection.kind === 'online' && controller.state.currentHostId === hostB);
    expect(controller.state.mutations[commandId]?.phase).toBe('unknown');
    expect(controller.state.unknownCommandId).toBeNull();
    const hostBStatus = (relays.get(hostB)?.sent ?? []).filter((message) => (
      message.type === 'command.request' && message.method === 'command.status'
    ));
    expect(hostBStatus).toEqual([]);
    controller.actions.selectHost(hostId);
    expect(controller.state.unknownCommandId).toBe(commandId);
    await viWait(async () => (
      (relays.get(hostId)?.sent ?? []).some((message) => (
        message.type === 'command.request'
        && message.method === 'command.status'
        && (message.params as { command_id?: string } | undefined)?.command_id === commandId
      ))
    ));
    const statusRequest = relays.get(hostId)!.sent.find((message) => (
      message.type === 'command.request' && message.method === 'command.status'
    ))!;
    await relays.get(hostId)!.emit({
      type: 'command.result',
      command_id: String(statusRequest.command_id),
      ok: true,
      data: { command_id: commandId, state: 'succeeded' },
    });
    await viWait(async () => controller.state.mutations[commandId]?.phase === 'succeeded');
    expect(controller.state.unknownCommandId).toBeNull();
    expect((relays.get(hostB)?.sent ?? []).some((message) => (
      message.type === 'command.request' && message.method === 'command.status'
    ))).toBe(false);
    controller.close();
  });

  it('rejects an in-flight upload as soon as the Host sends transfer.error', async () => {
    const relays = new Map<string, FakeRelay>();
    const { controller } = await pairedController({
      createRelay: (input) => {
        const relay = new FakeRelay(input);
        relays.set(input.hostId, relay);
        return relay;
      },
    });
    const sessionId = generateCanonicalId();
    controller.actions.challengeLogin(hostId);
    await viWait(async () => controller.state.connection.kind === 'online');
    controller.actions.uploadDraftAttachment(sessionId, {
      name: 'shot.bin',
      mime: 'application/octet-stream',
      size: 4,
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    await viWait(async () => Boolean(relays.get(hostId)?.sent.find((message) => (
      message.type === 'attachment.begin'
    ))));
    const begin = relays.get(hostId)!.sent.find((message) => message.type === 'attachment.begin')!;
    const transferId = String(begin.transfer_id);
    await relays.get(hostId)!.emit({
      type: 'transfer.error',
      transfer_id: transferId,
      code: 'ATTACHMENT_HASH_MISMATCH',
      message: 'hash mismatch',
    });
    await viWait(async () => controller.state.mutations[sessionId]?.phase === 'failed');
    expect(controller.state.mutations[sessionId]?.errorCode).toBe('ATTACHMENT_HASH_MISMATCH');
    await relays.get(hostId)!.emit({
      type: 'attachment.result',
      transfer_id: transferId,
      upload_id: generateCanonicalId(),
      attachment_id: generateCanonicalId(),
      name: 'shot.bin',
      mime: 'application/octet-stream',
      size: 4,
    });
    expect(controller.state.drafts[sessionId]?.attachments ?? []).toEqual([]);
    controller.close();
  });

  it('drops late events and results from a replaced Host', async () => {
    const relays = new Map<string, FakeRelay>();
    const { controller } = await pairedController({
      extraHosts: [hostB],
      createRelay: (input) => {
        const relay = new FakeRelay(input);
        relays.set(input.hostId, relay);
        return relay;
      },
    });
    controller.actions.challengeLogin(hostId);
    await viWait(async () => controller.state.connection.kind === 'online');
    const sessionA = {
      id: generateCanonicalId(),
      revision: '1',
      name: 'From A',
      task_id: null,
      workspace_id: generateCanonicalId(),
      agent: { id: generateCanonicalId(), name: 'Claude', proxy: 'claude' },
      status: 'running' as const,
      queue: { revision: '1', entries: [] },
      updated_at: new Date().toISOString(),
    };
    await relays.get(hostId)!.emit({
      type: 'event',
      host_generation: generateCanonicalId(),
      event_sequence: 0,
      event: { kind: 'session.updated', session: sessionA },
    });
    await viWait(async () => controller.state.sessions.some((session) => session.id === sessionA.id));
    controller.actions.selectHost(hostB);
    await viWait(async () => controller.state.connection.kind === 'online' && controller.state.currentHostId === hostB);
    const sessionsAfterSwitch = controller.state.sessions.map((session) => session.id);
    const lateSession = {
      ...sessionA,
      id: generateCanonicalId(),
      name: 'Late from A',
      revision: '2',
    };
    await relays.get(hostId)!.emit({
      type: 'event',
      host_generation: generateCanonicalId(),
      event_sequence: 1,
      event: { kind: 'session.updated', session: lateSession },
    });
    controller.actions.createSession({
      workspaceId: generateCanonicalId(),
      agentId: generateCanonicalId(),
      taskId: generateCanonicalId(),
      name: 'B job',
    });
    await viWait(async () => Boolean(relays.get(hostB)?.sent.find((message) => (
      message.type === 'command.request' && message.method === 'session.create'
    ))));
    const bCommand = relays.get(hostB)!.sent.find((message) => (
      message.type === 'command.request' && message.method === 'session.create'
    ))!;
    await relays.get(hostId)!.emit({
      type: 'command.result',
      command_id: String(bCommand.command_id),
      attempt_id: generateCanonicalId(),
      ok: true,
      data: {
        session: {
          ...lateSession,
          id: generateCanonicalId(),
          name: 'Forged by A',
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(controller.state.sessions.map((session) => session.id)).toEqual(sessionsAfterSwitch);
    expect(controller.state.sessions.some((session) => session.name === 'Late from A')).toBe(false);
    expect(controller.state.sessions.some((session) => session.name === 'Forged by A')).toBe(false);
    expect(controller.state.mutations[String(bCommand.command_id)]?.phase).toBe('pending');
    const sessionB = {
      id: generateCanonicalId(),
      revision: '1',
      name: 'From B',
      task_id: null,
      workspace_id: generateCanonicalId(),
      agent: { id: generateCanonicalId(), name: 'Claude', proxy: 'claude' },
      status: 'running' as const,
      queue: { revision: '1', entries: [] },
      updated_at: new Date().toISOString(),
    };
    await relays.get(hostB)!.emit({
      type: 'command.result',
      command_id: String(bCommand.command_id),
      attempt_id: generateCanonicalId(),
      ok: true,
      data: { session: sessionB },
    });
    await viWait(async () => controller.state.mutations[String(bCommand.command_id)]?.phase === 'succeeded');
    expect(controller.state.sessions.some((session) => session.id === sessionB.id)).toBe(true);
    controller.close();
  });

  it('keeps other paired Hosts when the current snapshot arrives', () => {
    const hiddenSessionId = generateCanonicalId();
    const started = {
      ...emptyState(),
      hosts: [
        { id: hostId, name: 'Office', online: true, sessionCount: 2 },
        { id: hostB, name: 'Laptop', online: false, sessionCount: 1, lastSeenAt: 1_700_000_000_000 },
      ],
      transcripts: {
        [hiddenSessionId]: {
          items: [], hydrated: true, streaming: false, hasOlder: false,
          loadingOlder: false, historyError: null,
        },
      },
      drafts: {
        [hiddenSessionId]: { text: 'private draft', attachments: [], contextItems: [], document: null },
      },
    };
    const next = applySnapshotToState(started, sampleSnapshot(hostId, 'Office Mac'));
    expect(next.hosts.map((host) => host.id)).toEqual([hostId, hostB]);
    expect(next.hosts[0]).toMatchObject({ id: hostId, name: 'Office Mac', online: true, sessionCount: 0 });
    expect(next.hosts[1]).toEqual({
      id: hostB,
      name: 'Laptop',
      online: false,
      sessionCount: 1,
      lastSeenAt: 1_700_000_000_000,
    });
    expect(next.currentHostId).toBe(hostId);
    expect(next.catalogInvalidated).toBe(true);
    expect(next.transcripts).toEqual({});
    expect(next.drafts).toEqual({});
  });

  it('does not send commands or transfers to the previous Host while switching', async () => {
    let releaseB!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const relays = new Map<string, FakeRelay>();
    const { controller } = await pairedController({
      extraHosts: [hostB],
      createRelay: (input) => {
        const relay = new FakeRelay(input);
        relays.set(input.hostId, relay);
        return relay;
      },
      async beforeRequest(path, body) {
        const target = String((body as { host_id?: string } | undefined)?.host_id ?? '');
        if (path === '/api/v1/ws-tickets' && target === hostB) await blocked;
      },
    });
    controller.actions.challengeLogin(hostId);
    await viWait(async () => controller.state.connection.kind === 'online');
    const sentOnA = relays.get(hostId)!.sent.length;
    controller.actions.selectHost(hostB);
    expect(controller.state.connection.kind).toBe('resyncing');
    controller.actions.refreshCatalog();
    controller.actions.uploadDraftAttachment(generateCanonicalId(), {
      name: 'shot.bin',
      mime: 'application/octet-stream',
      size: 4,
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    controller.actions.openFile({
      id: generateCanonicalId(),
      sessionId: generateCanonicalId(),
      label: 'notes.md',
    });
    controller.actions.downloadFile();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(relays.get(hostId)!.sent).toHaveLength(sentOnA);
    expect(relays.get(hostB)).toBeUndefined();
    expect(Object.values(controller.state.mutations).some((entry) => entry.phase === 'pending')).toBe(false);
    releaseB();
    await viWait(async () => controller.state.connection.kind === 'online' && controller.state.currentHostId === hostB);
    controller.close();
  });

  it('aborts an in-flight download when the current Host is replaced', async () => {
    const relays = new Map<string, FakeRelay>();
    const { controller } = await pairedController({
      extraHosts: [hostB],
      createRelay: (input) => {
        const relay = new FakeRelay(input);
        relays.set(input.hostId, relay);
        return relay;
      },
    });
    controller.actions.challengeLogin(hostId);
    await viWait(async () => controller.state.connection.kind === 'online');
    const handle = {
      id: generateCanonicalId(),
      sessionId: generateCanonicalId(),
      label: 'notes.md',
    };
    controller.actions.openFile(handle);
    controller.actions.downloadFile();
    await viWait(async () => Boolean(relays.get(hostId)?.sent.find((message) => (
      message.type === 'download.request'
    ))));
    const transferId = String(relays.get(hostId)!.sent.find((message) => (
      message.type === 'download.request'
    ))!.transfer_id);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await relays.get(hostId)!.emit(await legalDownloadMetadata(transferId, handle.label, bytes));
    await viWait(async () => controller.state.fileDownload.status === 'downloading');
    controller.actions.selectHost(hostB);
    expect(controller.state.fileDownload.status).toBe('idle');
    await relays.get(hostId)!.emit(legalDownloadChunk(transferId, bytes));
    await relays.get(hostId)!.emit(await legalDownloadComplete(transferId, bytes));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(controller.state.fileDownload.status).toBe('idle');
    expect(controller.state.fileViewer?.status).not.toBe('ready');
    controller.close();
  });

  it('marks old pending and upload unknown when the next Host fails before a ticket', async () => {
    const relays = new Map<string, FakeRelay>();
    const { controller } = await pairedController({
      extraHosts: [hostB],
      createRelay: (input) => {
        const relay = new FakeRelay(input);
        relays.set(input.hostId, relay);
        return relay;
      },
      async beforeRequest(path, body) {
        const target = String((body as { host_id?: string } | undefined)?.host_id ?? '');
        if (target === hostB && path === '/api/v1/sessions/device-challenge') {
          throw new RemoteProtocolError('HOST_OFFLINE', 'host B unreachable');
        }
      },
    });
    controller.actions.challengeLogin(hostId);
    await viWait(async () => controller.state.connection.kind === 'online');
    controller.actions.refreshCatalog();
    await viWait(async () => Boolean(relays.get(hostId)?.sent.find((message) => (
      message.type === 'command.request' && message.method === 'catalog.read'
    ))));
    const commandId = String(relays.get(hostId)!.sent.find((message) => (
      message.type === 'command.request' && message.method === 'catalog.read'
    ))!.command_id);
    expect(controller.state.mutations[commandId]?.phase).toBe('pending');
    const sessionId = generateCanonicalId();
    controller.actions.uploadDraftAttachment(sessionId, {
      name: 'shot.bin',
      mime: 'application/octet-stream',
      size: 4,
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    await viWait(async () => Boolean(relays.get(hostId)?.sent.find((message) => (
      message.type === 'attachment.begin'
    ))));
    controller.actions.selectHost(hostB);
    expect(relays.get(hostId)!.isOpen).toBe(false);
    expect(controller.state.mutations[commandId]?.phase).toBe('unknown');
    await viWait(async () => Object.values(controller.state.mutations).some((entry) => (
      entry.label === 'attachment.upload' && entry.phase === 'failed'
    )));
    await viWait(async () => controller.state.connection.kind === 'relay_reconnecting');
    expect(controller.state.drafts[sessionId]?.attachments ?? []).toEqual([]);
    controller.close();
  });

  it('rejects download metadata that omits sha256 instead of starting the transfer', async () => {
    const relays = new Map<string, FakeRelay>();
    const { controller } = await pairedController({
      createRelay: (input) => {
        const relay = new FakeRelay(input);
        relays.set(input.hostId, relay);
        return relay;
      },
    });
    controller.actions.challengeLogin(hostId);
    await viWait(async () => controller.state.connection.kind === 'online');
    const handle = {
      id: generateCanonicalId(),
      sessionId: generateCanonicalId(),
      label: 'notes.md',
    };
    controller.actions.openFile(handle);
    controller.actions.downloadFile();
    await viWait(async () => Boolean(relays.get(hostId)?.sent.find((message) => (
      message.type === 'download.request'
    ))));
    const transferId = String(relays.get(hostId)!.sent.find((message) => (
      message.type === 'download.request'
    ))!.transfer_id);
    await relays.get(hostId)!.emit({
      type: 'download.metadata',
      transfer_id: transferId,
      name: handle.label,
      mime: 'text/plain',
      size: 4,
    });
    await viWait(async () => controller.state.fileDownload.status === 'error');
    controller.close();
  });

  it('rejects out-of-order download chunks and does not save them', async () => {
    const relays = new Map<string, FakeRelay>();
    const clicked: string[] = [];
    const createElement = document.createElement.bind(document);
    const spy = vi.spyOn(document, 'createElement').mockImplementation((tagName) => {
      const el = createElement(tagName);
      if (tagName === 'a') {
        const link = el as HTMLAnchorElement;
        link.click = () => {
          clicked.push(link.download);
        };
      }
      return el;
    });
    const { controller } = await pairedController({
      createRelay: (input) => {
        const relay = new FakeRelay(input);
        relays.set(input.hostId, relay);
        return relay;
      },
    });
    controller.actions.challengeLogin(hostId);
    await viWait(async () => controller.state.connection.kind === 'online');
    const handle = {
      id: generateCanonicalId(),
      sessionId: generateCanonicalId(),
      label: 'notes.md',
    };
    controller.actions.openFile(handle);
    controller.actions.downloadFile();
    await viWait(async () => Boolean(relays.get(hostId)?.sent.find((message) => (
      message.type === 'download.request'
    ))));
    const transferId = String(relays.get(hostId)!.sent.find((message) => (
      message.type === 'download.request'
    ))!.transfer_id);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await relays.get(hostId)!.emit(await legalDownloadMetadata(transferId, handle.label, bytes));
    await relays.get(hostId)!.emit({
      type: 'attachment.chunk',
      transfer_id: transferId,
      transfer_sequence: 1,
      offset: 0,
      bytes: bytesToBase64Url(bytes),
    });
    await viWait(async () => controller.state.fileDownload.status === 'error');
    expect(clicked).toEqual([]);
    spy.mockRestore();
    controller.close();
  });

  it('does not save a preview after the viewer is closed', async () => {
    const relays = new Map<string, FakeRelay>();
    const clicked: string[] = [];
    const createElement = document.createElement.bind(document);
    const spy = vi.spyOn(document, 'createElement').mockImplementation((tagName) => {
      const el = createElement(tagName);
      if (tagName === 'a') {
        const link = el as HTMLAnchorElement;
        link.click = () => {
          clicked.push(link.download);
        };
      }
      return el;
    });
    const { controller } = await pairedController({
      createRelay: (input) => {
        const relay = new FakeRelay(input);
        relays.set(input.hostId, relay);
        return relay;
      },
    });
    controller.actions.challengeLogin(hostId);
    await viWait(async () => controller.state.connection.kind === 'online');
    const handle = {
      id: generateCanonicalId(),
      sessionId: generateCanonicalId(),
      label: 'notes.md',
    };
    controller.actions.openFile(handle);
    await viWait(async () => Boolean(relays.get(hostId)?.sent.find((message) => (
      message.type === 'command.request' && message.method === 'file.resolve'
    ))));
    await resolvePreviewHandle(relays.get(hostId)!, handle);
    await viWait(async () => Boolean(relays.get(hostId)?.sent.find((message) => (
      message.type === 'command.request' && message.method === 'file.preview'
    ))));
    const previewCommand = relays.get(hostId)!.sent.find((message) => (
      message.type === 'command.request' && message.method === 'file.preview'
    ))!;
    const transferId = generateCanonicalId();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await relays.get(hostId)!.emit({
      type: 'command.result',
      command_id: String(previewCommand.command_id),
      attempt_id: generateCanonicalId(),
      ok: true,
      data: previewResult(handle, transferId, bytes.byteLength),
    });
    await viWait(async () => Boolean(relays.get(hostId)?.sent.find((message) => (
      message.type === 'download.request' && message.transfer_id === transferId
    ))));
    await relays.get(hostId)!.emit(await legalDownloadMetadata(transferId, handle.label, bytes, true));
    await relays.get(hostId)!.emit(legalDownloadChunk(transferId, bytes));
    controller.actions.closeFile();
    expect(controller.state.fileViewer).toBeNull();
    await relays.get(hostId)!.emit(await legalDownloadComplete(transferId, bytes));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(controller.state.fileViewer).toBeNull();
    expect(clicked).toEqual([]);
    spy.mockRestore();
    controller.close();
  });

  it('does not complete a preview for a different viewer handle', async () => {
    const relays = new Map<string, FakeRelay>();
    const { controller } = await pairedController({
      createRelay: (input) => {
        const relay = new FakeRelay(input);
        relays.set(input.hostId, relay);
        return relay;
      },
    });
    controller.actions.challengeLogin(hostId);
    await viWait(async () => controller.state.connection.kind === 'online');
    const handleA = {
      id: generateCanonicalId(),
      sessionId: generateCanonicalId(),
      label: 'a.md',
    };
    const handleB = {
      id: generateCanonicalId(),
      sessionId: generateCanonicalId(),
      label: 'b.md',
    };
    controller.actions.openFile(handleA);
    await resolvePreviewHandle(relays.get(hostId)!, handleA);
    await viWait(async () => Boolean(relays.get(hostId)?.sent.find((message) => (
      message.type === 'command.request' && message.method === 'file.preview'
    ))));
    const previewCommand = relays.get(hostId)!.sent.find((message) => (
      message.type === 'command.request' && message.method === 'file.preview'
    ))!;
    const transferId = generateCanonicalId();
    const bytes = new TextEncoder().encode('from-a');
    await relays.get(hostId)!.emit({
      type: 'command.result',
      command_id: String(previewCommand.command_id),
      attempt_id: generateCanonicalId(),
      ok: true,
      data: previewResult(handleA, transferId, bytes.byteLength),
    });
    await viWait(async () => Boolean(relays.get(hostId)?.sent.find((message) => (
      message.type === 'download.request' && message.transfer_id === transferId
    ))));
    await relays.get(hostId)!.emit(await legalDownloadMetadata(transferId, handleA.label, bytes, true));
    await relays.get(hostId)!.emit(legalDownloadChunk(transferId, bytes));
    controller.actions.openFile(handleB);
    expect(controller.state.fileViewer).toMatchObject({ status: 'loading', handle: handleB });
    await relays.get(hostId)!.emit(await legalDownloadComplete(transferId, bytes));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(controller.state.fileViewer).toMatchObject({ status: 'loading', handle: handleB });
    controller.close();
  });

  it('does not let an obsolete relay handshake failure overwrite the reselected Host', async () => {
    let releaseHostB!: () => void;
    const hostBHandshake = new Promise<void>((resolve) => {
      releaseHostB = resolve;
    });
    const relays = new Map<string, FakeRelay>();
    const { controller } = await pairedController({
      extraHosts: [hostB],
      createRelay: (input) => {
        const relay = new FakeRelay(
          input,
          input.hostId === hostB ? () => hostBHandshake : undefined,
        );
        relays.set(input.hostId, relay);
        return relay;
      },
    });
    controller.actions.challengeLogin(hostId);
    await viWait(async () => controller.state.connection.kind === 'online');
    const firstHostARelay = relays.get(hostId);
    const observed: string[] = [];
    const unsubscribe = controller.subscribe(() => {
      observed.push(`${controller.state.currentHostId}:${controller.state.connection.kind}`);
    });

    controller.actions.selectHost(hostB);
    await viWait(async () => relays.has(hostB));
    controller.actions.selectHost(hostId);
    releaseHostB();

    await viWait(async () => (
      controller.state.currentHostId === hostId
      && controller.state.connection.kind === 'online'
      && relays.get(hostId) !== firstHostARelay
    ));
    expect(observed).not.toContain(`${hostId}:host_offline`);
    expect(relays.get(hostB)?.isOpen).toBe(false);
    unsubscribe();
    controller.close();
  });

  it('terminates a download immediately when the Host sends transfer.error', async () => {
    const relays = new Map<string, FakeRelay>();
    const { controller } = await pairedController({
      createRelay: (input) => {
        const relay = new FakeRelay(input);
        relays.set(input.hostId, relay);
        return relay;
      },
    });
    controller.actions.challengeLogin(hostId);
    await viWait(async () => controller.state.connection.kind === 'online');
    controller.actions.openFile({
      id: generateCanonicalId(),
      sessionId: generateCanonicalId(),
      label: 'expired.md',
    });
    controller.actions.downloadFile();
    await viWait(async () => Boolean(relays.get(hostId)?.sent.find((message) => (
      message.type === 'download.request'
    ))));
    const transferId = String(relays.get(hostId)!.sent.find((message) => (
      message.type === 'download.request'
    ))!.transfer_id);

    await relays.get(hostId)!.emit({
      type: 'transfer.error',
      transfer_id: transferId,
      code: 'FILE_REFERENCE_EXPIRED',
      message: 'file reference expired',
    });

    await viWait(async () => controller.state.fileDownload.status === 'error');
    expect(controller.state.fileDownload).toEqual({
      status: 'error',
      message: 'file reference expired',
    });
    controller.close();
  });

  it('keeps /me Hosts after the first live snapshot', async () => {
    const relays = new Map<string, FakeRelay>();
    const { controller } = await pairedController({
      extraHosts: [hostB],
      autoRestore: true,
      createRelay: (input) => {
        const relay = new FakeRelay(input);
        relays.set(input.hostId, relay);
        return relay;
      },
    });
    await viWait(async () => controller.state.hosts.length === 2);
    controller.actions.challengeLogin(hostId);
    await viWait(async () => controller.state.connection.kind === 'online');
    controller.actions.refreshState();
    await viWait(async () => Boolean(relays.get(hostId)?.sent.find((message) => (
      message.type === 'command.request' && message.method === 'state.refresh'
    ))));
    const refresh = relays.get(hostId)!.sent.find((message) => (
      message.type === 'command.request' && message.method === 'state.refresh'
    ))!;
    await relays.get(hostId)!.emit({
      type: 'command.result',
      command_id: String(refresh.command_id),
      ok: true,
      data: sampleSnapshot(hostId, 'Office Mac'),
    });
    await viWait(async () => controller.state.hosts.some((host) => host.name === 'Office Mac'));
    expect(controller.state.hosts.map((host) => host.id)).toEqual([hostId, hostB]);
    controller.close();
  });

  it('loads the production catalog when New Chat opens without one', async () => {
    const relays = new Map<string, FakeRelay>();
    const { controller } = await pairedController({
      createRelay: (input) => {
        const relay = new FakeRelay(input);
        relays.set(input.hostId, relay);
        return relay;
      },
    });
    controller.actions.challengeLogin(hostId);
    await viWait(async () => controller.state.connection.kind === 'online');

    controller.actions.openNewChat(generateCanonicalId());
    await viWait(async () => Boolean(relays.get(hostId)?.sent.find((message) => (
      message.type === 'command.request' && message.method === 'catalog.read'
    ))));
    const request = relays.get(hostId)!.sent.find((message) => (
      message.type === 'command.request' && message.method === 'catalog.read'
    ))!;
    const workspaceId = generateCanonicalId();
    const agentId = generateCanonicalId();
    await relays.get(hostId)!.emit({
      type: 'command.result',
      command_id: String(request.command_id),
      ok: true,
      data: {
        catalog_revision: 'cat-live',
        workspaces: [{ id: workspaceId, name: 'remote-integration' }],
        agents: [{
          id: agentId,
          name: 'Claude',
          proxy: 'claude',
          readiness: 'ready',
          models: [{
            id: 'sonnet',
            label: 'Claude Sonnet',
            is_default: true,
            supported_thinking: ['high'],
          }],
        }],
        tasks: [],
      },
    });

    await viWait(async () => controller.state.catalog?.catalog_revision === 'cat-live');
    expect(controller.state.catalog?.workspaces).toEqual([
      { id: workspaceId, name: 'remote-integration' },
    ]);
    expect(controller.state.catalog?.agents[0]).toMatchObject({ id: agentId, readiness: 'ready' });
    expect(controller.state.catalog?.agents[0]?.models?.[0]?.id).toBe('sonnet');
    expect(controller.state.catalogInvalidated).toBe(false);
    controller.close();
  });

  it('replays a stalled catalog read on the rebuilt Relay', async () => {
    const relays: FakeRelay[] = [];
    const { controller } = await pairedController({
      readStallMs: 20,
      readTimeoutMs: 1_000,
      createRelay(input) {
        const relay = new FakeRelay(input);
        relays.push(relay);
        return relay;
      },
    });
    controller.actions.challengeLogin(hostId);
    await viWait(async () => controller.state.connection.kind === 'online');
    const initialSync = relays[0]!.sent.find(message => message.method === 'state.refresh');
    await relays[0]!.emit({
      type: 'command.result',
      command_id: String(initialSync!.command_id),
      ok: true,
      data: { ...sampleSnapshot(hostId, 'Office Mac'), event_sequence: 5 },
    });

    controller.actions.refreshCatalog();
    await viWait(async () => relays[0]!.sent.some(message => message.method === 'catalog.read'));
    const first = relays[0]!.sent.find(message => message.method === 'catalog.read')!;
    await viWait(async () => relays.length === 2 && relays[1]!.sent.some(message => (
      message.method === 'catalog.read'
    )));
    const replay = relays[1]!.sent.find(message => message.method === 'catalog.read')!;
    expect(replay.command_id).not.toBe(first.command_id);
    expect(relays[1]!.sent.some(message => message.method === 'command.status')).toBe(false);
    await relays[1]!.emit({
      type: 'command.result',
      command_id: String(replay.command_id),
      ok: true,
      data: {
        catalog_revision: 'cat-recovered',
        workspaces: [],
        agents: [],
        tasks: [],
      },
    });

    await viWait(async () => controller.state.catalog?.catalog_revision === 'cat-recovered');
    controller.close();
  });

  it('rejects a malformed command result without closing the Relay', async () => {
    const relays = new Map<string, FakeRelay>();
    const { controller } = await pairedController({
      createRelay: (input) => {
        const relay = new FakeRelay(input);
        relays.set(input.hostId, relay);
        return relay;
      },
    });
    controller.actions.challengeLogin(hostId);
    await viWait(async () => controller.state.connection.kind === 'online');
    controller.actions.openNewChat(generateCanonicalId());
    await viWait(async () => relays.get(hostId)!.sent.some(message => (
      message.type === 'command.request' && message.method === 'catalog.read'
    )));
    const request = relays.get(hostId)!.sent.find(message => (
      message.type === 'command.request' && message.method === 'catalog.read'
    ))!;

    await expect(relays.get(hostId)!.emit({
      type: 'command.result',
      command_id: String(request.command_id),
      ok: true,
      data: { invalid: true },
    })).resolves.toBeUndefined();

    await viWait(async () => controller.state.mutations[String(request.command_id)]?.phase === 'failed');
    expect(controller.state.mutations[String(request.command_id)]?.errorCode).toBe('INVALID_FRAME');
    expect(relays.get(hostId)?.isOpen).toBe(true);
    expect(controller.state.connection.kind).toBe('online');
    controller.close();
  });

  it('requests history without waiting for subscribe and exposes the loading lifecycle', async () => {
    const relays = new Map<string, FakeRelay>();
    const { controller } = await pairedController({
      createRelay: (input) => {
        const relay = new FakeRelay(input);
        relays.set(input.hostId, relay);
        return relay;
      },
    });
    controller.actions.challengeLogin(hostId);
    await viWait(async () => controller.state.connection.kind === 'online');

    const sessionId = generateCanonicalId();
    const agentId = generateCanonicalId();
    controller.actions.refreshState();
    await viWait(async () => relays.get(hostId)!.sent.some(message => (
      message.type === 'command.request' && message.method === 'state.refresh'
    )));
    const refresh = relays.get(hostId)!.sent.find(message => (
      message.type === 'command.request' && message.method === 'state.refresh'
    ))!;
    await relays.get(hostId)!.emit({
      type: 'command.result',
      command_id: String(refresh.command_id),
      ok: true,
      data: {
        ...sampleSnapshot(hostId, 'Office Mac'),
        sessions: [{
          id: sessionId,
          revision: '1',
          name: 'History',
          task_id: null,
          workspace_id: generateCanonicalId(),
          agent: { id: agentId, name: 'Codex', proxy: 'codex' },
          model: 'gpt-5.3-codex',
          status: 'done',
          queue: { revision: '1', entries: [] },
          updated_at: new Date().toISOString(),
        }],
      },
    });

    await viWait(async () => (
      relays.get(hostId)!.sent.some(message => message.type === 'command.request' && message.method === 'session.subscribe')
      && relays.get(hostId)!.sent.some(message => message.type === 'command.request' && message.method === 'session.page')
    ));
    expect(controller.state.transcripts[sessionId]).toMatchObject({
      hydrated: false,
      loadingOlder: false,
      historyError: null,
    });

    const page = relays.get(hostId)!.sent.find(message => (
      message.type === 'command.request' && message.method === 'session.page'
    ))!;
    await relays.get(hostId)!.emit({
      type: 'command.result',
      command_id: String(page.command_id),
      ok: true,
      data: {
        session_id: sessionId,
        has_more: false,
        items: [{
          id: generateCanonicalId(),
          turn_id: generateCanonicalId(),
          turn: 1,
          ts: Date.now(),
          kind: 'assistant',
          text: 'Loaded from history',
          delta: false,
        }],
      },
    });

    await viWait(async () => controller.state.transcripts[sessionId]?.hydrated === true);
    expect(controller.state.transcripts[sessionId]?.items).toEqual([
      expect.objectContaining({ kind: 'assistant', text: 'Loaded from history' }),
    ]);
    controller.close();
  });

  it('opens the canonical session on mobile when session.create succeeds', async () => {
    const relays = new Map<string, FakeRelay>();
    const { controller } = await pairedController({
      createRelay: (input) => {
        const relay = new FakeRelay(input);
        relays.set(input.hostId, relay);
        return relay;
      },
    });
    controller.actions.challengeLogin(hostId);
    await viWait(async () => controller.state.connection.kind === 'online');
    controller.actions.openNewChat(generateCanonicalId());
    controller.actions.createSession({
      workspaceId: generateCanonicalId(),
      agentId: generateCanonicalId(),
      taskId: generateCanonicalId(),
    });
    await viWait(async () => Boolean(relays.get(hostId)?.sent.find((message) => (
      message.type === 'command.request' && message.method === 'session.create'
    ))));
    const request = relays.get(hostId)!.sent.find((message) => (
      message.type === 'command.request' && message.method === 'session.create'
    ))!;
    const sessionId = generateCanonicalId();
    await relays.get(hostId)!.emit({
      type: 'command.result',
      command_id: String(request.command_id),
      ok: true,
      data: {
        session: {
          id: sessionId,
          revision: '1',
          name: 'Remote mobile session',
          task_id: null,
          workspace_id: generateCanonicalId(),
          agent: { id: generateCanonicalId(), name: 'Claude', proxy: 'claude' },
          status: 'idle',
          queue: { revision: '1', entries: [] },
          updated_at: new Date().toISOString(),
        },
      },
    });

    await viWait(async () => controller.state.view.kind === 'chat');
    expect(controller.state.view).toEqual({ kind: 'chat', sessionId });
    expect(controller.state.mobilePage).toBe('chat');
    controller.close();
  });

  it('reuses an unexpired access token on reconnect without another auth round trip', async () => {
    const paths: string[] = [];
    const relays: FakeRelay[] = [];
    const { controller } = await pairedController({
      onRequest(path) {
        paths.push(path);
      },
      createRelay(input) {
        const relay = new FakeRelay(input);
        relays.push(relay);
        return relay;
      },
    });
    try {
      controller.actions.challengeLogin(hostId);
      // Wait for the completed connection, not merely the login request.
      // Real WebSocket/DNS failure timing is unrelated to refresh reuse.
      await viWait(async () => relays[0]?.isOpen === true);
      controller.actions.challengeLogin(hostId);
      await viWait(async () => relays.length === 2 && relays[1]?.isOpen === true);
      expect(paths.filter((path) => path === '/api/v1/sessions/device-login')).toHaveLength(1);
      expect(paths.filter((path) => path === '/api/v1/sessions/refresh')).toHaveLength(0);
    } finally {
      controller.close();
    }
  });

  it('refreshes an expired access token before reconnecting', async () => {
    const paths: string[] = [];
    const relays: FakeRelay[] = [];
    const { controller } = await pairedController({
      accessTokenTtlMs: -1,
      onRequest(path) {
        paths.push(path);
      },
      createRelay(input) {
        const relay = new FakeRelay(input);
        relays.push(relay);
        return relay;
      },
    });
    try {
      controller.actions.challengeLogin(hostId);
      await viWait(async () => relays[0]?.isOpen === true);
      controller.actions.challengeLogin(hostId);
      await viWait(async () => relays.length === 2 && relays[1]?.isOpen === true);
      expect(paths.filter((path) => path === '/api/v1/sessions/refresh')).toHaveLength(1);
    } finally {
      controller.close();
    }
  });

  it('refreshes and retries once when the Server rejects a cached access token', async () => {
    const paths: string[] = [];
    const relays: FakeRelay[] = [];
    const { controller } = await pairedController({
      rejectSecondCachedTicket: true,
      onRequest(path) {
        paths.push(path);
      },
      createRelay(input) {
        const relay = new FakeRelay(input);
        relays.push(relay);
        return relay;
      },
    });
    try {
      controller.actions.challengeLogin(hostId);
      await viWait(async () => relays[0]?.isOpen === true);
      controller.actions.challengeLogin(hostId);
      await viWait(async () => relays.length === 2 && relays[1]?.isOpen === true);
      expect(paths.filter((path) => path === '/api/v1/ws-tickets')).toHaveLength(3);
      expect(paths.filter((path) => path === '/api/v1/sessions/refresh')).toHaveLength(1);
    } finally {
      controller.close();
    }
  });

  it('restores a remembered Host key when the refresh cookie is unavailable', async () => {
    const paths: string[] = [];
    const relays: FakeRelay[] = [];
    const { controller } = await pairedController({
      autoRestore: true,
      meFails: true,
      onRequest(path) {
        paths.push(path);
      },
      createRelay(input) {
        const relay = new FakeRelay(input);
        relays.push(relay);
        return relay;
      },
    });

    await viWait(async () => controller.state.connection.kind === 'online');
    expect(controller.state.currentHostId).toBe(hostId);
    expect(relays).toHaveLength(1);
    expect(paths).toContain('/api/v1/sessions/device-login');
    controller.close();
  });

  it('does not let a hung encrypted snapshot cache block device-key login', async () => {
    const relays: FakeRelay[] = [];
    const cache: EncryptedHostCache = {
      async put() {},
      async get() { return new Promise(() => undefined); },
      async clear() {},
    };
    const { controller } = await pairedController({
      autoRestore: true,
      cache,
      createRelay(input) {
        const relay = new FakeRelay(input);
        relays.push(relay);
        return relay;
      },
    });

    await viWait(async () => controller.state.connection.kind === 'online');
    expect(relays).toHaveLength(1);
    controller.close();
  });

  it('surfaces a failed interaction.respond on the card instead of swallowing it', async () => {
    let relay: FakeRelay | undefined;
    const { controller } = await pairedController({
      createRelay(input) {
        relay = new FakeRelay(input);
        return relay;
      },
    });
    controller.actions.challengeLogin(hostId);
    await viWait(async () => controller.state.connection.kind === 'online');

    const sessionId = generateCanonicalId();
    const allowActionId = generateCanonicalId();
    const declineActionId = generateCanonicalId();
    const interaction = sampleInteraction({
      id: generateCanonicalId(),
      session_id: sessionId,
      turn_id: generateCanonicalId(),
      presentation: {
        title: 'Run command',
        description: 'needs approval',
        risk: 'medium',
        actions: [
          { id: allowActionId, label: 'Allow once', tone: 'default' },
          { id: declineActionId, label: 'Decline', tone: 'danger' },
        ],
      },
    });
    const refresh = relay!.sent.find(message => message.method === 'state.refresh')!;
    await relay!.emit({
      type: 'command.result',
      command_id: String(refresh.command_id),
      ok: true,
      data: {
        ...sampleSnapshot(hostId, 'Office Mac'),
        sessions: [remoteSession(sessionId)],
        interactions: [interaction],
      },
    });
    await viWait(async () => controller.state.interactions.some(item => item.id === interaction.id));

    controller.actions.respondToInteraction(interaction.id, allowActionId);
    expect(controller.state.interactionPhases[interaction.id]).toBe('responding');
    // A card already responding never fires a second mutation.
    controller.actions.respondToInteraction(interaction.id, allowActionId);
    await viWait(async () => relay!.sent.some(message => message.method === 'interaction.respond'));
    const respondRequests = relay!.sent.filter(message => message.method === 'interaction.respond');
    expect(respondRequests).toHaveLength(1);

    await relay!.emit({
      type: 'command.result',
      command_id: String(respondRequests[0]!.command_id),
      ok: false,
      error: { code: 'INTERACTION_ACTION_NOT_FOUND', message: 'Interaction action is not available.' },
    });
    await viWait(async () => controller.state.interactionPhases[interaction.id] === 'pending');
    expect(controller.state.interactionErrors[interaction.id])
      .toBe('Interaction action is not available.');
    expect(controller.state.mutations[String(respondRequests[0]!.command_id)]?.phase).toBe('failed');

    // Retrying clears the recorded error and re-enters the responding phase.
    controller.actions.respondToInteraction(interaction.id, declineActionId);
    expect(controller.state.interactionErrors[interaction.id]).toBeUndefined();
    expect(controller.state.interactionPhases[interaction.id]).toBe('responding');
    controller.close();
  });
});

class FakeRelay implements DeviceRelayLike {
  isOpen = false;
  private closed = false;
  readonly sent: Array<{
    type?: string;
    command_id?: string;
    method?: string;
    params?: unknown;
    transfer_id?: string;
  }> = [];

  constructor(
    private readonly input: DeviceRelayClientOptions,
    private readonly beforeConnect?: () => Promise<void>,
  ) {}

  async connect(): Promise<void> {
    await this.beforeConnect?.();
    if (this.closed) throw new RemoteProtocolError('HOST_OFFLINE', 'relay closed while connecting');
    this.isOpen = true;
  }

  async sendControl(message: object): Promise<void> {
    this.sent.push(message as (typeof this.sent)[number]);
  }

  async sendContent(message: object): Promise<void> {
    this.sent.push({ ...(message as object), type: `content:${String((message as { type?: string }).type)}` });
  }

  close(reason = 'device_closed'): void {
    if (this.closed) return;
    this.closed = true;
    this.isOpen = false;
    this.input.handlers.onClose?.(reason);
  }

  async emit(message: { type?: string; [key: string]: unknown }): Promise<void> {
    await this.input.handlers.onControl(message);
  }

  emitNotice(notice: { type: 'host.offline' | 'host.online'; host_id: string }): void {
    this.input.handlers.onNotice?.(notice as never);
  }
}

async function legalDownloadMetadata(
  transferId: string,
  name: string,
  bytes: Uint8Array,
  preview = false,
) {
  return {
    type: 'download.metadata' as const,
    transfer_id: transferId,
    name,
    mime: 'text/plain',
    size: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    disposition: 'inline' as const,
    preview,
  };
}

function legalDownloadChunk(transferId: string, bytes: Uint8Array, sequence = 0, offset = 0) {
  return {
    type: 'attachment.chunk' as const,
    transfer_id: transferId,
    transfer_sequence: sequence,
    offset,
    bytes: bytesToBase64Url(bytes),
  };
}

async function legalDownloadComplete(transferId: string, bytes: Uint8Array) {
  return {
    type: 'download.complete' as const,
    transfer_id: transferId,
    size: bytes.byteLength,
    sha256: await sha256Hex(bytes),
  };
}

function previewResult(handle: RemoteFileHandle, transferId: string, size: number) {
  return {
    transfer_id: transferId,
    preview_max_bytes: MAX_FILE_PREVIEW_BYTES,
    file: {
      id: handle.id,
      session_id: handle.sessionId,
      name: handle.label,
      mime: 'text/plain',
      size,
      revision: '1',
      previewable: true,
      downloadable: true,
      expires_at: new Date().toISOString(),
    },
  };
}

async function resolvePreviewHandle(relay: FakeRelay, handle: RemoteFileHandle) {
  await viWait(async () => relay.sent.some(message => message.method === 'file.resolve'
    && (message.params as { reference?: string })?.reference === handle.id));
  const request = relay.sent.find(message => message.method === 'file.resolve'
    && (message.params as { reference?: string })?.reference === handle.id)!;
  await relay.emit({ type: 'command.result', command_id: request.command_id, ok: true,
    data: previewResult(handle, generateCanonicalId(), 4).file });
}

function sampleSnapshot(id: string, name: string): RemoteStateSnapshot {
  return {
    type: 'state.snapshot',
    snapshot_id: generateCanonicalId(),
    host_generation: generateCanonicalId(),
    revision: 'rev-1',
    event_sequence: 0,
    host: { id, name, online: true, version: '0.5.3' },
    workspaces: [],
    tasks: [],
    sessions: [],
    interactions: [],
    capabilities: {},
    attention: [],
    catalog_revision: 'cat-1',
  };
}

function remoteSession(id: string) {
  return {
    id,
    revision: 'session-rev-1',
    name: 'Mobile message',
    task_id: null,
    workspace_id: generateCanonicalId(),
    agent: { id: generateCanonicalId(), name: 'Codex', proxy: 'codex' },
    status: 'running' as const,
    queue: { revision: 'queue-rev-1', entries: [] },
    updated_at: new Date().toISOString(),
  };
}

async function pairedController(options: {
  beforeGet?: () => Promise<void>;
  hostSelection?: import('../src/host-selection.js').HostSelectionStore;
  pairingHost?: string;
  extraHosts?: string[];
  directoryHostIds?: string[];
  autoRestore?: boolean;
  cache?: EncryptedHostCache;
  meFails?: boolean;
  del?: RemoteHttpClient['del'];
  onRequest?: (path: string) => void;
  beforeRequest?: (path: string, body?: unknown) => Promise<void> | void;
  createRelay?: (input: DeviceRelayClientOptions) => DeviceRelayLike;
  readStallMs?: number;
  readTimeoutMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  accessTokenTtlMs?: number;
  rejectSecondCachedTicket?: boolean;
} = {}) {
  const identity = new MemoryBrowserIdentityStore();
  const cache = options.cache ?? new MemoryEncryptedHostCache();
  await cache.put('__account__', { protocol: 'gian.remote.account/1', status: 'authorized', role: 'controller',
    installation_id: generateCanonicalId(), account: { id: '42', login: 'fixture-owner' },
    account_token: 'fixture-account-token', expires_at: Date.now() + 60_000 });
  await identity.createPending();
  await identity.bindPending(hostId);
  await cache.put(hostId, { type: 'state.snapshot', host: { id: hostId, name: 'Office' } });
  for (const extra of options.extraHosts ?? []) {
    await identity.createPending();
    await identity.bindPending(extra);
    await cache.put(extra, { type: 'state.snapshot', host: { id: extra, name: 'Laptop' } });
  }
  const hostKey = await exportPublicJwk((await generateP256KeyPair()).publicKey);
  let ticketRequests = 0;
  let pairClaimed = false;
  const http: RemoteHttpClient = {
    cookies: new MemoryCookieJar(),
    async request(path, body, token) {
      await options.beforeRequest?.(path, body);
      options.onRequest?.(path);
      if (path === '/api/v1/pairings/claim' && options.pairingHost) {
        pairClaimed = true;
        return { protocol: AUTH_PROTOCOL, pairing_id: generateCanonicalId(), host_id: options.pairingHost,
          status: 'pending_confirmation', crypto_connection_id: generateCanonicalId() };
      }
      if (path === '/api/v1/sessions/logout') {
        return { protocol: AUTH_PROTOCOL, ok: true };
      }
      if (path === '/api/v1/sessions/device-challenge') {
        return {
          protocol: AUTH_PROTOCOL,
          challenge_id: generateCanonicalId(),
          challenge: 'challenge',
          expires_at: Date.now() + 60_000,
        };
      }
      if (path === '/api/v1/sessions/device-login') {
        const target = String((body as { host_id?: string } | undefined)?.host_id ?? hostId);
        return {
          protocol: AUTH_PROTOCOL,
          access_token: `token-${target}`,
          expires_at: Date.now() + (options.accessTokenTtlMs ?? 60_000),
          device_id: target === hostB ? deviceB : deviceA,
          host_id: target,
          crypto_connection_id: generateCanonicalId(),
          host_public_key: hostKey,
        };
      }
      if (path === '/api/v1/sessions/refresh') {
        return { protocol: AUTH_PROTOCOL, access_token: `refresh-${hostId}`, expires_at: Date.now() + 60_000 };
      }
      if (path === '/api/v1/ws-tickets') {
        ticketRequests += 1;
        if (
          options.rejectSecondCachedTicket
          && ticketRequests === 2
          && token?.startsWith('token-')
        ) {
          throw new RemoteProtocolError('AUTH_REQUIRED', 'cached token was invalidated');
        }
        return { protocol: AUTH_PROTOCOL, ticket: 'ticket', expires_at: Date.now() + 60_000 };
      }
      throw new Error(path);
    },
    async get(path) {
      if (path === '/api/v1/account/me') return { protocol: 'gian.remote.account/1', account: { id: '42', login: 'fixture-owner' } };
      await options.beforeGet?.();
      if (path === '/api/v1/me') {
        if (options.meFails) throw new RemoteProtocolError('AUTH_REQUIRED', 'refresh cookie unavailable');
        return {
          protocol: AUTH_PROTOCOL,
          hosts: (options.directoryHostIds ?? [hostId, ...(options.extraHosts ?? []), ...(pairClaimed && options.pairingHost ? [options.pairingHost] : [])]).map((id) => ({
            host_id: id,
            name: id === hostB ? 'Laptop' : 'Office',
            online: true,
          })),
        };
      }
      return { protocol: AUTH_PROTOCOL };
    },
    async del(path, body, token) {
      if (options.del) return options.del(path, body, token);
      return { protocol: AUTH_PROTOCOL, host_id: hostId, status: 'revoked' };
    },
  };
  const controller = createProductionController({
    baseUrl: 'https://remote.test',
    publicOrigin: 'https://remote.test',
    identity,
    cache,
    http,
    autoRestore: options.autoRestore ?? false,
    createRelay: options.createRelay,
    readStallMs: options.readStallMs,
    readTimeoutMs: options.readTimeoutMs,
    reconnectBaseMs: options.reconnectBaseMs,
    reconnectMaxMs: options.reconnectMaxMs,
    hostSelection: options.hostSelection,
  });
  return { identity, cache, controller, extraHosts: options.extraHosts };
}

async function viWait(check: () => Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out');
}
