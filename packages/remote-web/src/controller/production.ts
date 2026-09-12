import {
  REMOTE_METHOD_RESULTS,
  CONTENT_WINDOW_CHUNKS,
  PAIRING_TTL_MS,
  RemoteProtocolError,
  attachmentResultSchema,
  canonicalEventSchema,
  catalogReadResultSchema,
  commandStatusResultSchema,
  filePreviewResultSchema,
  formatPairingCode,
  generateCanonicalId,
  generateUuidV7,
  parseClosed,
  remoteStateSnapshotSchema,
  selfRevokePayload,
  signBytes,
  statePatchSchema,
  transferAckSchema,
  transferCancelSchema,
  transferErrorSchema,
  type RemoteMethod,
  type RemoteStateSnapshot,
  type RemoteTranscriptItem,
} from '@gian/remote-protocol';
import { createEncryptedHostCache, type EncryptedHostCache } from '../cache/encrypted-cache.js';
import { DeviceAuthClient } from '../transport/auth-client.js';
import {
  createBrowserIdentityStore,
  type BrowserIdentityStore,
} from '../transport/identity.js';
import { createRemoteHttpClient, type RemoteHttpClient } from '../transport/http.js';
import {
  DeviceRelayClient,
  type DeviceRelayFactory,
  type DeviceRelayLike,
} from '../transport/relay-client.js';
import {
  applyCanonicalEvent,
  applySnapshotToState,
  applyStatePatch,
  applyTranscriptPage,
  beginTranscriptLoad,
  failTranscriptLoad,
} from './apply-control.js';
import {
  TransferAckGate,
  uploadRemoteAttachment,
  type AttachmentUploadResult,
} from './attachment-upload.js';
import { advanceCanonicalSequence, occupiesCanonicalSequence } from './event-sequence.js';
import {
  applyDownloadChunk,
  applyDownloadMetadata,
  completeDownload,
  previewMayComplete,
  startDownload,
  type DownloadTransfer,
} from './download-transfer.js';
import { viewerFromPreviewBytes, viewerFromPreviewError } from './file-preview.js';
import {
  nextUnknownCommandId,
  statusNeedsRefresh,
  takePendingOnDisconnect,
  type PendingWaiter,
  type RecoverableCommand,
} from './pending-commands.js';
import { sessionSendParams } from './session-send.js';
import {
  draftIsEmpty,
  emptyDraft,
  mutationsEnabled,
  type CreateSessionInput,
  type PairingFailure,
  type RemoteCatalog,
  type RemoteHostEntry,
  type RemoteUiActions,
  type RemoteUiController,
  type RemoteUiState,
} from './types.js';

interface HostAuthSession {
  accessToken: string;
  accessExpiresAt: number;
  deviceId: string;
  hostPublicKey: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  cryptoConnectionId: string;
}

export interface ProductionControllerOptions {
  baseUrl: string;
  publicOrigin: string;
  wsUrl?: string;
  fetchFn?: typeof fetch;
  http?: RemoteHttpClient;
  identity?: BrowserIdentityStore;
  cache?: EncryptedHostCache;
  autoRestore?: boolean;
  platform?: string;
  userAgent?: string;
  createRelay?: DeviceRelayFactory;
  pairingNonce?: string;
  readStallMs?: number;
  readTimeoutMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

export interface ProductionController extends RemoteUiController {
  close(): void;
}

export const PAIRING_POLL_INITIAL_MS = 500;
export const PAIRING_POLL_MAX_MS = 12_000;
// Host-side projections can legitimately take more than a few seconds for a
// large transcript or a cold Agent catalog. Reconnecting sooner than that
// interrupts the response and turns a slow read into a permanent retry loop.
export const READ_STALL_RECONNECT_MS = 30_000;
export const READ_COMMAND_TIMEOUT_MS = 90_000;
export const RECONNECT_BASE_MS = 400;
export const RECONNECT_MAX_MS = 10_000;
const ACCESS_TOKEN_REFRESH_SKEW_MS = 5_000;

export function nextPairingPollDelay(delayMs: number): number {
  return Math.min(PAIRING_POLL_MAX_MS, delayMs * 2);
}

export function createProductionController(options: ProductionControllerOptions): ProductionController {
  const identity = options.identity ?? createBrowserIdentityStore();
  const cache = options.cache ?? createEncryptedHostCache();
  const http = options.http ?? createRemoteHttpClient({
    baseUrl: options.baseUrl,
    origin: options.publicOrigin,
    fetchFn: options.fetchFn,
  });
  const auth = new DeviceAuthClient(http);
  const wsUrl = options.wsUrl ?? relayWsUrl(options.baseUrl);
  const platform = options.platform ?? detectPlatform();
  const userAgent = options.userAgent ?? detectUserAgent();
  const readStallMs = options.readStallMs ?? READ_STALL_RECONNECT_MS;
  const readTimeoutMs = options.readTimeoutMs ?? READ_COMMAND_TIMEOUT_MS;
  const reconnectBaseMs = options.reconnectBaseMs ?? RECONNECT_BASE_MS;
  const reconnectMaxMs = options.reconnectMaxMs ?? RECONNECT_MAX_MS;
  const browserEvents = typeof window === 'undefined' ? null : window;

  const listeners = new Set<() => void>();
  let relay: DeviceRelayLike | null = null;
  let relayHostId: string | null = null;
  let relayEpoch: number | null = null;
  let closed = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connectInFlight: Promise<void> | null = null;
  let refreshInFlight: Promise<void> | null = null;
  const pending = new Map<string, PendingWaiter & {
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }>();
  const hostRuntimes = new Map<string, {
    epoch: number;
    lastEventSequence: number;
    snapshotRevision: string;
    hostGeneration: string;
    recoverable: RecoverableCommand[];
    reconnects: number;
  }>();
  const hostSessions = new Map<string, HostAuthSession>();
  const uploadWaiters = new Map<string, {
    hostId: string;
    resolve: (value: AttachmentUploadResult) => void;
    reject: (error: unknown) => void;
  }>();
  const uploadAcks = new Map<string, TransferAckGate>();
  const downloads = new Map<string, DownloadTransfer>();

  let state: RemoteUiState = emptyUiState();
  let qrNonce = options.pairingNonce;
  let pairingGeneration = 0;
  let restoreInFlight: Promise<void> | null = null;
  let restoreAgain = false;
  if (qrNonce) state.auth = {
    kind: 'pairing',
    pairing: { kind: 'qr-confirm', hostName: new URL(options.publicOrigin).host, deviceName: 'This browser' },
  };

  function emit(): void {
    for (const listener of listeners) listener();
  }

  function update(patch: Partial<RemoteUiState>): void {
    state = { ...state, ...patch };
    emit();
  }

  function setPairingFailure(reason: PairingFailure): void {
    update({
      auth: { kind: 'pairing', pairing: { kind: 'failed', reason } },
    });
  }

  async function clearHostPairingMaterial(hostId: string): Promise<void> {
    hostSessions.delete(hostId);
    await Promise.all([
      identity.clearHost(hostId),
      cache.clear(hostId),
    ]);
  }

  function hostRuntime(hostId: string) {
    const current = hostRuntimes.get(hostId) ?? {
      epoch: 0,
      lastEventSequence: -1,
      snapshotRevision: '',
      hostGeneration: '',
      recoverable: [],
      reconnects: 0,
    };
    hostRuntimes.set(hostId, current);
    return current;
  }

  function bumpEpoch(hostId: string): number {
    const runtime = hostRuntime(hostId);
    runtime.epoch += 1;
    return runtime.epoch;
  }

  function clearRelayBinding(): void {
    relay = null;
    relayHostId = null;
    relayEpoch = null;
  }

  function boundRelay(): { relay: DeviceRelayLike; hostId: string; epoch: number } | null {
    if (!relay?.isOpen || !relayHostId || relayEpoch == null) return null;
    if (state.currentHostId !== relayHostId) return null;
    if (hostRuntime(relayHostId).epoch !== relayEpoch) return null;
    return { relay, hostId: relayHostId, epoch: relayEpoch };
  }

  function transferRelay(): { relay: DeviceRelayLike; hostId: string; epoch: number } | null {
    if (state.connection.kind !== 'online') return null;
    return boundRelay();
  }

  function abortDownloadsForHost(hostId: string): void {
    let touched = false;
    for (const [transferId, entry] of downloads) {
      if (entry.hostId !== hostId) continue;
      downloads.delete(transferId);
      touched = true;
    }
    if (!touched) return;
    const patch: Partial<RemoteUiState> = {};
    if (state.fileDownload.status === 'downloading') {
      patch.fileDownload = { status: 'idle' };
    }
    if (state.fileViewer?.status === 'loading') {
      patch.fileViewer = viewerFromPreviewError(state.fileViewer.handle, 'UNKNOWN_OUTCOME');
    }
    if (Object.keys(patch).length > 0) update(patch);
  }

  function abortAllDownloads(): void {
    const hostIds = new Set(Array.from(downloads.values(), (entry) => entry.hostId));
    for (const hostId of hostIds) abortDownloadsForHost(hostId);
    downloads.clear();
  }

  function applySnapshot(snapshot: RemoteStateSnapshot): void {
    const runtime = hostRuntime(snapshot.host.id);
    runtime.lastEventSequence = snapshot.event_sequence - 1;
    runtime.snapshotRevision = snapshot.revision;
    runtime.hostGeneration = snapshot.host_generation;
    const next = applySnapshotToState(state, snapshot);
    update(next);
    void cache.put(snapshot.host.id, snapshot);
    if (next.view.kind === 'chat') hydrateSessionDetached(next.view.sessionId, 'initial', true);
  }

  function noteSequence(hostId: string, type: string, sequence: number, eventKind?: string): boolean {
    if (!occupiesCanonicalSequence(type, eventKind)) return true;
    const runtime = hostRuntime(hostId);
    if (advanceCanonicalSequence(runtime.lastEventSequence, sequence) === 'gap') {
      requestState();
      return false;
    }
    runtime.lastEventSequence = sequence;
    return true;
  }

  function cancelReconnect(): void {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function scheduleReconnect(hostId: string): void {
    if (
      closed
      || reconnectTimer
      || state.currentHostId !== hostId
      || state.connection.kind === 'browser_offline'
      || state.connection.kind === 'device_revoked'
    ) return;
    const runtime = hostRuntime(hostId);
    runtime.reconnects += 1;
    const attempt = runtime.reconnects;
    const exponent = Math.min(16, Math.max(0, attempt - 1));
    const delayMs = Math.min(reconnectMaxMs, reconnectBaseMs * (2 ** exponent));
    update({ connection: { kind: 'relay_reconnecting', attempt } });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connectHost(hostId).catch(() => undefined);
    }, delayMs);
  }

  function handleBrowserOffline(): void {
    if (closed || !state.currentHostId || state.connection.kind === 'device_revoked') return;
    cancelReconnect();
    update({ connection: { kind: 'browser_offline' } });
  }

  function handleBrowserOnline(): void {
    const hostId = state.currentHostId;
    if (
      closed
      || !hostId
      || state.connection.kind === 'online'
      || state.connection.kind === 'device_revoked'
    ) return;
    cancelReconnect();
    void connectHost(hostId).catch(() => undefined);
  }

  function retireHostSession(hostId: string, reason: 'replaced' | 'disconnected' = 'replaced'): void {
    bumpEpoch(hostId);
    markDisconnectedPending(hostId);
    if (relayHostId !== hostId) return;
    const current = relay;
    clearRelayBinding();
    current?.close(reason);
  }

  function markDisconnectedPending(hostId: string): void {
    const recovered = takePendingOnDisconnect(pending, hostId);
    const runtime = hostRuntime(hostId);
    runtime.recoverable.push(...recovered);
    for (const command of recovered) {
      finishMutation(
        command.commandId,
        'unknown',
        'UNKNOWN_OUTCOME',
        'disconnected before result',
        showsUnknownOutcome(command.method),
      );
    }
    for (const [transferId, waiter] of [...uploadWaiters]) {
      if (waiter.hostId !== hostId) continue;
      rejectTransfer(
        transferId,
        new RemoteProtocolError('UNKNOWN_OUTCOME', 'disconnected before upload finished'),
      );
    }
    abortDownloadsForHost(hostId);
  }

  function rejectTransfer(transferId: string, error: unknown): void {
    const abortError = error instanceof Error
      ? error
      : new RemoteProtocolError('UNKNOWN_OUTCOME', 'transfer failed');
    uploadAcks.get(transferId)?.abort(abortError);
    const waiter = uploadWaiters.get(transferId);
    uploadWaiters.delete(transferId);
    uploadAcks.delete(transferId);
    waiter?.reject(abortError);
    const download = downloads.get(transferId);
    if (download) {
      downloads.delete(transferId);
      failDownload(download, abortError);
    }
  }

  function failDownload(entry: DownloadTransfer | undefined, error: unknown): void {
    if (!entry) return;
    if (entry.purpose === 'save') {
      update({
        fileDownload: {
          status: 'error',
          message: error instanceof Error ? error.message : 'download failed',
        },
      });
      return;
    }
    if (previewMayComplete(entry, state.fileViewer) && state.fileViewer) {
      update({ fileViewer: viewerFromPreviewError(state.fileViewer.handle, errorCode(error)) });
    }
  }

  async function sendCommand(
    method: RemoteMethod,
    params: unknown,
    label: string,
    options: { recoverOnDisconnect?: boolean } = {},
  ): Promise<unknown> {
    const readable = method === 'state.refresh'
      || method === 'catalog.read'
      || method === 'session.subscribe'
      || method === 'session.page'
      || method === 'command.status';
    const transport = boundRelay();
    if (!transport) {
      if (!readable) throw new RemoteProtocolError('HOST_OFFLINE', 'Host relay is not connected');
      if (state.connection.kind !== 'resyncing' && state.connection.kind !== 'relay_reconnecting') {
        update({ connection: { kind: 'host_offline', lastSeenAt: Date.now() } });
      }
      return undefined;
    }
    if (!readable && !mutationsEnabled(state.connection)) {
      throw new RemoteProtocolError('HOST_OFFLINE', 'Host is not ready for mutations');
    }
    const commandId = generateUuidV7();
    const attemptId = generateCanonicalId();
    const hostId = transport.hostId;
    const result = new Promise<unknown>((resolve, reject) => {
      pending.set(commandId, {
        hostId,
        method,
        label,
        params,
        recoverOnDisconnect: options.recoverOnDisconnect,
        resolve,
        reject,
      });
    });
    update({
      mutations: {
        ...state.mutations,
        [commandId]: { commandId, label, phase: 'pending', startedAt: Date.now() },
      },
    });
    try {
      await transport.relay.sendControl({
        type: 'command.request',
        command_id: commandId,
        created_at: Date.now(),
        attempt_id: attemptId,
        method,
        params,
      });
    } catch (error) {
      const waiter = pending.get(commandId);
      pending.delete(commandId);
      finishMutation(commandId, 'failed', errorCode(error), error instanceof Error ? error.message : 'send failed');
      waiter?.reject(error);
      throw error;
    }
    return result;
  }

  function dispatchCommand(method: RemoteMethod, params: unknown, label: string): void {
    void sendCommand(method, params, label).catch(() => undefined);
  }

  async function sendReadCommand(
    method: 'catalog.read' | 'state.refresh' | 'session.subscribe' | 'session.page',
    params: unknown,
    label: string,
    recoverOnDisconnect = true,
  ): Promise<unknown> {
    const hostId = state.currentHostId;
    const command = sendCommand(method, params, label, { recoverOnDisconnect });
    const watchdog = hostId ? setTimeout(() => {
      if (closed || state.currentHostId !== hostId) return;
      const stalled = boundRelay();
      if (!stalled || stalled.hostId !== hostId) return;
      clearRelayBinding();
      stalled.relay.close('read_timeout');
    }, readStallMs) : null;
    try {
      const result = await withTimeout(command, readTimeoutMs, `${label} timed out`);
      if (result === undefined) {
        throw new RemoteProtocolError('HOST_OFFLINE', `${label} is unavailable`);
      }
      return result;
    } finally {
      if (watchdog) clearTimeout(watchdog);
    }
  }

  function requestCatalog(): void {
    void sendReadCommand('catalog.read', {}, 'catalog.read').catch(() => undefined);
  }

  function requestState(): void {
    void sendReadCommand('state.refresh', {}, 'state.refresh').catch(() => undefined);
  }

  function refreshStateFromUi(): void {
    const hostId = state.currentHostId;
    if (!hostId || refreshInFlight) return;
    const hadBoundRelay = Boolean(boundRelay());
    cancelReconnect();
    update({ connection: { kind: 'resyncing', synced: 0, total: 1 } });
    const run = (async () => {
      if (hadBoundRelay) {
        await recoverPendingCommands(hostId);
      } else {
        const connecting = connectInFlight;
        if (connecting) await connecting.catch(() => undefined);
        if (closed || state.currentHostId !== hostId) return;
        if (!boundRelay()) await connectHost(hostId);
      }
      if (closed || state.currentHostId !== hostId) return;
      await sendReadCommand('state.refresh', {}, 'state.refresh');
    })().catch((error) => {
      if (
        closed
        || state.currentHostId !== hostId
        || state.connection.kind !== 'resyncing'
      ) return;
      if (reconnectTimer) return;
      update({ connection: connectionAfterFailure(error) });
    }).finally(() => {
      if (refreshInFlight === run) refreshInFlight = null;
    });
    refreshInFlight = run;
  }

  function hydrateSessionDetached(
    sessionId: string,
    operation: 'initial' | 'older' = 'initial',
    force = false,
  ): void {
    if (operation === 'initial') {
      const current = state.transcripts[sessionId];
      if (!force && current?.hydrated && !current.historyError) return;
    }
    const loading = beginTranscriptLoad(state, sessionId, operation);
    update({ transcripts: loading.transcripts });
    void hydrateSession(sessionId, operation).catch(() => {
      const failed = failTranscriptLoad(state, sessionId, operation);
      update({ transcripts: failed.transcripts });
    });
  }

  async function hydrateSession(sessionId: string, operation: 'initial' | 'older'): Promise<void> {
    if (operation === 'initial') {
      // Live subscription and persisted history are independent. A missing
      // subscribe result must never block the history page request.
      void sendCommand('session.subscribe', { session_id: sessionId }, 'session.subscribe')
        .catch(() => undefined);
    }
    const cursor = operation === 'older' ? state.transcripts[sessionId]?.cursor : undefined;
    const result = await sendReadCommand('session.page', {
      session_id: sessionId,
      turns: 3,
      ...(cursor ? { cursor } : {}),
    }, 'session.page');
    if (!result) throw new RemoteProtocolError('HOST_OFFLINE', 'message history is unavailable');
    const page = parseClosed(REMOTE_METHOD_RESULTS['session.page'], result) as {
      items: RemoteTranscriptItem[];
      has_more: boolean;
      cursor?: string;
    };
    const session = state.sessions.find((item) => item.id === sessionId);
    const exec = session?.agent.proxy || 'claude';
    const next = applyTranscriptPage(
      state,
      sessionId,
      page.items,
      exec,
      page.has_more,
      page.cursor,
      operation === 'older',
    );
    update({ transcripts: next.transcripts });
  }

  function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new RemoteProtocolError('HOST_OFFLINE', message));
      }, timeoutMs);
      promise.then(
        value => { clearTimeout(timeout); resolve(value); },
        error => { clearTimeout(timeout); reject(error); },
      );
    });
  }

  function finishMutation(
    commandId: string,
    phase: 'succeeded' | 'failed' | 'unknown',
    errorCode?: string,
    errorMessage?: string,
    showUnknownOutcome = true,
  ): void {
    const current = state.mutations[commandId];
    if (!current) return;
    update({
      mutations: {
        ...state.mutations,
        [commandId]: { ...current, phase, errorCode, errorMessage },
      },
      unknownCommandId: showUnknownOutcome
        ? nextUnknownCommandId(state.unknownCommandId, commandId, phase)
        : state.unknownCommandId,
    });
  }

  async function onControl(
    message: { type?: string; [key: string]: unknown },
    boundHostId: string,
    boundEpoch: number,
  ): Promise<void> {
    if (hostRuntime(boundHostId).epoch !== boundEpoch) return;
    if (message.type === 'snapshot.required') {
      if (state.currentHostId !== boundHostId) return;
      requestState();
      return;
    }
    if (message.type === 'resume.ok') {
      if (state.currentHostId !== boundHostId) return;
      const runtime = hostRuntime(boundHostId);
      if (typeof message.replay_from === 'number') runtime.lastEventSequence = Number(message.replay_from) - 1;
      if (typeof message.revision === 'string') runtime.snapshotRevision = message.revision;
      update({ connection: { kind: 'online' } });
      if (state.view.kind === 'chat') hydrateSessionDetached(state.view.sessionId, 'initial', true);
      return;
    }
    if (message.type === 'event') {
      if (state.currentHostId !== boundHostId) return;
      const event = parseClosed(canonicalEventSchema, message);
      if (!noteSequence(boundHostId, event.type, event.event_sequence, event.event.kind)) return;
      update(applyCanonicalEvent(state, event));
      return;
    }
    if (message.type === 'state.patch') {
      if (state.currentHostId !== boundHostId) return;
      const patch = parseClosed(statePatchSchema, message);
      const revision = hostRuntime(boundHostId).snapshotRevision;
      if (revision && patch.base_revision !== revision) {
        requestState();
        return;
      }
      if (!noteSequence(boundHostId, patch.type, patch.event_sequence)) return;
      hostRuntime(boundHostId).snapshotRevision = patch.revision;
      update(applyStatePatch(state, patch));
      return;
    }
    if (message.type === 'transfer.ack') {
      try {
        const ack = parseClosed(transferAckSchema, message);
        uploadAcks.get(ack.transfer_id)?.push({
          contiguous_offset: ack.contiguous_offset,
          window_chunks: ack.window_chunks,
        });
      } catch {
        // Closed-schema ack is required; ignore a malformed window update.
      }
      return;
    }
    if (message.type === 'transfer.error' || message.type === 'transfer.cancel') {
      try {
        if (message.type === 'transfer.error') {
          const failed = parseClosed(transferErrorSchema, message);
          rejectTransfer(failed.transfer_id, new RemoteProtocolError(failed.code, failed.message));
        } else {
          const cancelled = parseClosed(transferCancelSchema, message);
          rejectTransfer(
            cancelled.transfer_id,
            new RemoteProtocolError('UNKNOWN_OUTCOME', cancelled.reason),
          );
        }
      } catch (error) {
        const transferId = typeof message.transfer_id === 'string' ? message.transfer_id : '';
        if (transferId) rejectTransfer(transferId, error);
      }
      return;
    }
    if (message.type === 'attachment.result') {
      try {
        const result = parseClosed(attachmentResultSchema, message);
        const waiter = uploadWaiters.get(result.transfer_id);
        uploadWaiters.delete(result.transfer_id);
        uploadAcks.delete(result.transfer_id);
        waiter?.resolve({
          transfer_id: result.transfer_id,
          upload_id: result.upload_id,
          attachment_id: result.attachment_id,
          name: result.name,
          mime: result.mime,
          size: result.size,
        });
      } catch (error) {
        const transferId = typeof message.transfer_id === 'string' ? message.transfer_id : '';
        if (transferId) rejectTransfer(transferId, error);
      }
      return;
    }
    if (
      message.type === 'download.metadata'
      || message.type === 'attachment.chunk'
      || message.type === 'download.complete'
    ) {
      const transferId = typeof message.transfer_id === 'string' ? message.transfer_id : '';
      const current = transferId ? downloads.get(transferId) : undefined;
      if (current && current.hostId !== boundHostId) return;
      try {
        if (!current || !transferId) return;
        if (message.type === 'download.metadata') {
          const next = applyDownloadMetadata(current, message, boundHostId);
          downloads.set(transferId, next);
          if (next.purpose === 'save') {
            update({ fileDownload: { status: 'downloading', pct: 0 } });
          }
          return;
        }
        if (message.type === 'attachment.chunk') {
          const next = applyDownloadChunk(current, message, transferId);
          downloads.set(transferId, next);
          if (next.purpose === 'save') {
            update({
              fileDownload: {
                status: 'downloading',
                pct: next.size > 0 ? Math.min(100, Math.round((next.nextOffset / next.size) * 100)) : 0,
              },
            });
          }
          const transport = boundRelay();
          if (transport && transport.hostId === boundHostId && transport.epoch === boundEpoch) {
            void transport.relay.sendControl({
              type: 'transfer.ack',
              transfer_id: transferId,
              contiguous_offset: next.nextOffset,
              window_chunks: CONTENT_WINDOW_CHUNKS,
            }).catch(() => undefined);
          }
          return;
        }
        downloads.delete(transferId);
        const bytes = await completeDownload(current, message);
        if (current.purpose === 'preview') {
          if (previewMayComplete(current, state.fileViewer)) {
            update({ fileViewer: viewerFromPreviewBytes(current.handle!, bytes, current.mime) });
          }
          return;
        }
        saveBrowserFile(current.name, current.mime, bytes);
        update({ fileDownload: { status: 'idle' } });
      } catch (error) {
        if (transferId) downloads.delete(transferId);
        failDownload(current, error);
      }
      return;
    }
    if (message.type === 'command.accepted') return;
    if (message.type === 'command.result') {
      const commandId = String(message.command_id ?? '');
      const pendingCommand = pending.get(commandId);
      if (!pendingCommand || pendingCommand.hostId !== boundHostId) return;
      pending.delete(commandId);
      if (!message.ok) {
        const code = String((message.error as { code?: string } | undefined)?.code ?? 'UNKNOWN_OUTCOME');
        if (pendingCommand?.method === 'file.preview' && state.fileViewer) {
          update({ fileViewer: viewerFromPreviewError(state.fileViewer.handle, code) });
        }
        finishMutation(
          commandId,
          code === 'UNKNOWN_OUTCOME' ? 'unknown' : 'failed',
          code,
          String((message.error as { message?: string } | undefined)?.message ?? code),
          showsUnknownOutcome(pendingCommand.method),
        );
        pendingCommand?.reject(new RemoteProtocolError(
          code === 'UNKNOWN_OUTCOME' ? 'UNKNOWN_OUTCOME' : 'INVALID_FRAME',
          String((message.error as { message?: string } | undefined)?.message ?? code),
        ));
        return;
      }
      try {
        applyCommandData(pendingCommand.method, message.data, pendingCommand.hostId);
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'invalid command result';
        finishMutation(commandId, 'failed', 'INVALID_FRAME', detail);
        pendingCommand.reject(new RemoteProtocolError('INVALID_FRAME', detail));
        return;
      }
      finishMutation(commandId, 'succeeded');
      pendingCommand.resolve(message.data);
      return;
    }
    if (message.type === 'error' && message.code === 'DEVICE_REVOKED') {
      if (state.currentHostId !== boundHostId) return;
      void clearHostPairingMaterial(boundHostId);
      update({ connection: { kind: 'device_revoked' } });
      relay?.close('device_revoked');
    }
  }

  function applyCommandData(method: RemoteMethod | undefined, data: unknown, hostId?: string): void {
    if (!method) return;
    if (method === 'state.refresh') {
      applySnapshot(parseClosed(remoteStateSnapshotSchema, data));
      return;
    }
    if (method === 'catalog.read') {
      const catalog = parseClosed(catalogReadResultSchema, data) as RemoteCatalog;
      update({
        catalog,
        catalogRevision: catalog.catalog_revision,
        catalogInvalidated: false,
        workspaces: catalog.workspaces,
      });
      return;
    }
    if (method === 'session.create' || method === 'session.update' || method === 'session.send') {
      const session = (data as { session?: unknown; id?: string } | undefined)?.session ?? data;
      if (session && typeof session === 'object' && 'id' in (session as object)) {
        const next = applyCanonicalEvent(state, {
          type: 'event',
          host_generation: (state.currentHostId
            ? hostRuntime(state.currentHostId).hostGeneration
            : '') || generateCanonicalId(),
          event_sequence: (state.currentHostId
            ? hostRuntime(state.currentHostId).lastEventSequence
            : -1) + 1,
          event: { kind: 'session.updated', session: session as never },
        });
        update(method === 'session.create'
          ? {
              ...next,
              view: { kind: 'chat', sessionId: String((session as { id: unknown }).id) },
              mobilePage: 'chat',
              fileViewer: null,
            }
          : next);
      }
      return;
    }
    if (method === 'file.preview' && state.fileViewer) {
      const preview = parseClosed(filePreviewResultSchema, data);
      const handle = state.fileViewer.handle;
      const transferId = preview.transfer_id;
      const transport = transferRelay();
      if (!transport || (hostId && transport.hostId !== hostId)) {
        update({ fileViewer: viewerFromPreviewError(handle, 'HOST_OFFLINE') });
        return;
      }
      downloads.set(transferId, startDownload({
        hostId: transport.hostId,
        purpose: 'preview',
        handle,
        name: preview.file.name,
        mime: preview.file.mime,
        size: preview.file.size,
      }));
      void transport.relay.sendControl({
        type: 'download.request',
        transfer_id: transferId,
        kind: 'file',
        handle_id: handle.id,
      }).catch((error) => {
        downloads.delete(transferId);
        update({
          fileViewer: viewerFromPreviewError(
            handle,
            error instanceof Error ? error.message : 'download failed',
          ),
        });
      });
    }
  }

  async function recoverPendingCommands(hostId: string): Promise<void> {
    const runtime = hostRuntime(hostId);
    // Reconcile writes before replaying presentation reads. A slow history
    // projection must not delay confirmation of a message the user sent.
    const waiting = [...runtime.recoverable].sort((left, right) => (
      Number(isReplaySafeRead(left.method)) - Number(isReplaySafeRead(right.method))
    ));
    runtime.recoverable = [];
    for (const command of waiting) {
      if (state.currentHostId !== hostId) {
        hostRuntime(hostId).recoverable.push(command);
        continue;
      }
      if (isReplaySafeRead(command.method)) {
        try {
          const result = await sendReadCommand(
            command.method,
            command.params ?? {},
            command.label,
            false,
          );
          finishMutation(command.commandId, 'succeeded', undefined, undefined, false);
          command.resolve?.(result);
        } catch (error) {
          if (state.currentHostId === hostId) hostRuntime(hostId).recoverable.push(command);
          finishMutation(
            command.commandId,
            'unknown',
            'UNKNOWN_OUTCOME',
            error instanceof Error ? error.message : 'read replay failed',
            false,
          );
        }
        continue;
      }
      try {
        const status = parseClosed(
          commandStatusResultSchema,
          await sendCommand('command.status', { command_id: command.commandId }, 'command.status'),
        );
        if (status.state === 'succeeded') {
          applyCommandData(command.method, status.result, hostId);
          finishMutation(command.commandId, 'succeeded');
          command.resolve?.(status.result);
          continue;
        }
        if (status.state === 'failed') {
          finishMutation(
            command.commandId,
            'failed',
            status.error?.code ?? 'COMMAND_FAILED',
            status.error?.message,
          );
          command.reject?.(new Error(status.error?.message ?? 'command failed'));
          continue;
        }
        if (status.state === 'accepted') {
          if (state.currentHostId === hostId) hostRuntime(hostId).recoverable.push(command);
          finishMutation(command.commandId, 'unknown', 'UNKNOWN_OUTCOME', status.state);
          continue;
        }
        if (statusNeedsRefresh(status.state)) {
          finishMutation(command.commandId, 'unknown', 'UNKNOWN_OUTCOME', status.state);
          command.reject?.(new RemoteProtocolError('UNKNOWN_OUTCOME', status.state));
        }
      } catch {
        if (state.currentHostId === hostId) {
          hostRuntime(hostId).recoverable.push(command);
        }
        finishMutation(command.commandId, 'unknown', 'UNKNOWN_OUTCOME', 'status lookup failed');
      }
    }
  }

  function onNotice(notice: { type?: string }, boundHostId: string, boundEpoch: number): void {
    if (hostRuntime(boundHostId).epoch !== boundEpoch) return;
    if (notice.type === 'device.revoked') {
      if (state.currentHostId !== boundHostId) return;
      void clearHostPairingMaterial(boundHostId);
      update({ connection: { kind: 'device_revoked' } });
      relay?.close('device_revoked');
      return;
    }
    if (notice.type === 'host.offline') {
      if (state.currentHostId !== boundHostId) return;
      scheduleReconnect(boundHostId);
      return;
    }
    if (notice.type === 'host.online' && state.currentHostId === boundHostId) {
      cancelReconnect();
      void connectHost(boundHostId).catch(() => undefined);
    }
  }

  async function deviceLogin(hostId: string): Promise<HostAuthSession> {
    const browserId = await identity.browserInstallationId();
    const hostIdentity = await identity.hostIdentity(hostId);
    const challenge = await auth.challenge(browserId, hostId);
    const login = await auth.login({
      browserInstallationId: browserId,
      hostId,
      challengeId: challenge.challenge_id,
      signature: await signBytes(hostIdentity.privateKey, new TextEncoder().encode(challenge.challenge_id)),
    });
    const session: HostAuthSession = {
      accessToken: login.access_token,
      accessExpiresAt: login.expires_at,
      deviceId: login.device_id,
      hostPublicKey: login.host_public_key,
      cryptoConnectionId: login.crypto_connection_id,
    };
    hostSessions.set(hostId, session);
    return session;
  }

  async function authenticateHost(
    hostId: string,
    options: { forceRefresh?: boolean } = {},
  ): Promise<HostAuthSession> {
    const existing = hostSessions.get(hostId);
    if (existing) {
      if (!options.forceRefresh && existing.accessExpiresAt > Date.now() + ACCESS_TOKEN_REFRESH_SKEW_MS) {
        return existing;
      }
      try {
        const refreshed = await auth.refresh(hostId);
        const next = {
          ...existing,
          accessToken: refreshed.access_token,
          accessExpiresAt: refreshed.expires_at,
        };
        hostSessions.set(hostId, next);
        return next;
      } catch {
        // Cookie/family lost: fall back to a new device-login.
      }
    }
    return deviceLogin(hostId);
  }

  async function connectHost(hostId: string): Promise<void> {
    if (closed) return;
    const epoch = bumpEpoch(hostId);
    if (connectInFlight) {
      await connectInFlight.catch(() => undefined);
      if (closed || epoch !== hostRuntime(hostId).epoch) return;
    }
    const run = connectHostUnlocked(hostId, epoch);
    connectInFlight = run;
    try {
      await run;
    } catch (error) {
      if (closed || epoch !== hostRuntime(hostId).epoch) return;
      if (devicePairingWasLost(error)) {
        await clearHostPairingMaterial(hostId);
        if (!closed && epoch === hostRuntime(hostId).epoch && state.currentHostId === hostId) {
          update({ connection: { kind: 'device_revoked' } });
        }
      }
      if (relayHostId === hostId) retireHostSession(hostId, 'disconnected');
      else markDisconnectedPending(hostId);
      if (!devicePairingWasLost(error)) scheduleReconnect(hostId);
      throw error;
    } finally {
      if (connectInFlight === run) connectInFlight = null;
    }
  }

  async function connectHostUnlocked(hostId: string, epoch: number): Promise<void> {
    if (closed || epoch !== hostRuntime(hostId).epoch) return;
    cancelReconnect();
    update({ connection: { kind: 'resyncing', synced: 0, total: 1 }, currentHostId: hostId });
    const hostIdentity = await identity.hostIdentity(hostId);
    let session = await authenticateHost(hostId);
    if (closed || epoch !== hostRuntime(hostId).epoch) return;
    let ticket;
    try {
      ticket = await auth.wsTicket(session.accessToken, hostId);
    } catch (error) {
      if (errorCode(error) !== 'AUTH_REQUIRED') throw error;
      session = await authenticateHost(hostId, { forceRefresh: true });
      ticket = await auth.wsTicket(session.accessToken, hostId);
    }
    if (closed || epoch !== hostRuntime(hostId).epoch) return;
    if (relayHostId && relayHostId !== hostId) {
      retireHostSession(relayHostId, 'replaced');
    } else if (relay) {
      const stale = relay;
      clearRelayBinding();
      stale.close('replaced');
    }
    const boundEpoch = epoch;
    const boundHostId = hostId;
    const relayInput = {
      wsUrl,
      ticket: ticket.ticket,
      identity: hostIdentity,
      hostPublicKey: session.hostPublicKey,
      hostId,
      deviceId: session.deviceId,
      cryptoConnectionId: session.cryptoConnectionId,
      handlers: {
        onControl(message: { type?: string; [key: string]: unknown }) {
          return onControl(message, boundHostId, boundEpoch);
        },
        onNotice(notice: { type?: string }) {
          onNotice(notice, boundHostId, boundEpoch);
        },
        onClose(reason: string) {
          markDisconnectedPending(hostId);
          if (closed) return;
          if (
            reason === 'replaced'
            || reason === 'closed'
            || reason === 'disconnected'
            || reason === 'logout'
            || reason === 'handshake_failed'
          ) {
            return;
          }
          if (state.currentHostId !== hostId) return;
          if (state.connection.kind === 'device_revoked' || reason === 'device_revoked') {
            if (reason === 'device_revoked') void clearHostPairingMaterial(hostId);
            update({ connection: { kind: 'device_revoked' } });
            return;
          }
          scheduleReconnect(hostId);
        },
      },
    };
    const nextRelay = options.createRelay ? options.createRelay(relayInput) : new DeviceRelayClient(relayInput);
    relay = nextRelay;
    relayHostId = hostId;
    relayEpoch = boundEpoch;
    try {
      await nextRelay.connect();
      if (closed || epoch !== hostRuntime(hostId).epoch) {
        if (relay === nextRelay) clearRelayBinding();
        nextRelay.close('replaced');
        return;
      }
      const runtime = hostRuntime(hostId);
      if (runtime.lastEventSequence >= 0 && runtime.snapshotRevision && runtime.hostGeneration) {
        await nextRelay.sendControl({
          type: 'resume.request',
          host_generation: runtime.hostGeneration,
          after_event_sequence: runtime.lastEventSequence,
          current_revision: runtime.snapshotRevision,
          ...(state.view.kind === 'chat' ? { subscribed_session_id: state.view.sessionId } : {}),
        }).catch(() => undefined);
      }
    } catch (error) {
      nextRelay.close('handshake_failed');
      if (relay === nextRelay) clearRelayBinding();
      throw error;
    }
    hostRuntime(hostId).reconnects = 0;
    update({ connection: { kind: 'online' } });
    await recoverPendingCommands(hostId);
  }

  async function claimAndWait(code: string | undefined, deviceName: string, grantNonce?: string): Promise<void> {
    const generation = ++pairingGeneration;
    const current = () => !closed && generation === pairingGeneration;
    update({ auth: { kind: 'pairing', pairing: { kind: 'waiting', deviceName, expiresAt: Date.now() + PAIRING_TTL_MS } } });
    let browserId: string;
    let claimed;
    try {
      browserId = await identity.browserInstallationId();
      if (!current()) return;
      const pendingIdentity = await identity.createPending();
      if (!current()) return;
      claimed = await auth.claimPairing({
        browserInstallationId: browserId,
        devicePublicKey: pendingIdentity.publicJwk,
        platform,
        userAgent,
        code,
        grantNonce,
      });
    } catch (error) {
      if (current()) setPairingFailure(mapPairingFailure(error, state));
      return;
    }
    if (!current()) return;
    await identity.bindPending(claimed.host_id);
    if (!current()) return;
    update({
      auth: {
        kind: 'pairing',
        pairing: { kind: 'waiting', deviceName, expiresAt: Date.now() + PAIRING_TTL_MS },
      },
      currentHostId: claimed.host_id,
    });
    const started = Date.now();
    let pollDelayMs = PAIRING_POLL_INITIAL_MS;
    const poll = async (): Promise<void> => {
      if (!current()) return;
      if (Date.now() - started > PAIRING_TTL_MS) {
        setPairingFailure('expired');
        return;
      }
      try {
        await auth.challenge(browserId, claimed.host_id);
        if (!current()) return;
        await connectHost(claimed.host_id);
        return;
      } catch (error) {
        if (!current()) return;
        const codeName = errorCode(error);
        if (codeName === 'DEVICE_REVOKED') {
          setPairingFailure('rejected');
          return;
        }
        if (codeName !== 'DEVICE_NOT_PAIRED' && codeName !== 'AUTH_REQUIRED') {
          setPairingFailure(mapPairingFailure(error, state));
          return;
        }
      }
      const delayMs = pollDelayMs;
      pollDelayMs = nextPairingPollDelay(pollDelayMs);
      pollTimer = setTimeout(() => {
        void poll();
      }, delayMs);
    };
    await poll();
  }

  async function restore(): Promise<void> {
    try {
      const me = await auth.me();
      const hosts = (me.hosts ?? []).map((host) => ({
        id: host.host_id,
        name: host.name,
        online: host.online,
        sessionCount: 0,
      }));
      if (hosts.length === 0) {
        await restoreRememberedHosts();
        return;
      }
      if (hosts.length === 1) {
        update({
          auth: { kind: 'challenge-login', hosts },
          hosts,
          currentHostId: hosts[0]!.id,
        });
        await connectHost(hosts[0]!.id);
        return;
      }
      update({ auth: { kind: 'challenge-login', hosts }, hosts });
    } catch {
      if (state.connection.kind === 'device_revoked') return;
      if (state.auth.kind === 'challenge-login' && state.currentHostId) return;
      await restoreRememberedHosts();
    }
  }

  function requestRestore(): void {
    if (closed || qrNonce) return;
    if (restoreInFlight) {
      restoreAgain = true;
      return;
    }
    const run = restore().finally(() => {
      if (restoreInFlight === run) restoreInFlight = null;
      if (
        !restoreAgain
        || closed
        || state.auth.kind !== 'pairing'
        || state.auth.pairing.kind !== 'enter-code'
      ) return;
      restoreAgain = false;
      requestRestore();
    });
    restoreInFlight = run;
  }

  async function restoreRememberedHosts(): Promise<void> {
    const hostIds = await identity.listHostIds();
    if (hostIds.length === 0) return;
    // Authentication must not wait for encrypted snapshot-cache I/O. The
    // live snapshot supplies the canonical Host name and Session counts once
    // the device-key challenge succeeds.
    const hosts: RemoteHostEntry[] = hostIds.map(hostId => ({
      id: hostId,
      name: 'Gian Host',
      online: false,
      sessionCount: 0,
    }));
    if (hosts.length !== 1) {
      update({ auth: { kind: 'challenge-login', hosts }, hosts });
      return;
    }
    const host = hosts[0]!;
    update({
      auth: { kind: 'challenge-login', hosts },
      hosts,
      currentHostId: host.id,
      connection: { kind: 'resyncing', synced: 0, total: 1 },
    });
    await connectHost(host.id).catch(() => undefined);
  }

  async function forgetHost(hostId: string, options: { revoke: boolean }): Promise<void> {
    if (options.revoke) {
      try {
        const creds = await authenticateHost(hostId);
        const hostIdentity = await identity.hostIdentity(hostId);
        const signedAt = Date.now();
        await auth.selfRevoke({
          hostId,
          signedAt,
          accessToken: creds.accessToken,
          signature: await signBytes(
            hostIdentity.privateKey,
            new TextEncoder().encode(selfRevokePayload({
              hostId,
              deviceId: creds.deviceId,
              signedAt,
            })),
          ),
        });
      } catch (error) {
        update({
          mutations: {
            ...state.mutations,
            [hostId]: {
              commandId: hostId,
              label: 'host.revoke',
              phase: 'failed',
              errorCode: errorCode(error),
              errorMessage: error instanceof Error ? error.message : 'self-revoke failed',
              startedAt: Date.now(),
            },
          },
        });
        return;
      }
    }
    if (state.currentHostId === hostId) {
      cancelReconnect();
      retireHostSession(hostId, 'disconnected');
    }
    hostSessions.delete(hostId);
    await identity.clearHost(hostId);
    await cache.clear(hostId);
    const hosts = state.hosts.filter((host) => host.id !== hostId);
    const next = hosts[0];
    if (next) {
      update({ hosts });
      actions.selectHost(next.id);
    } else {
      update({
        hosts,
        currentHostId: null,
        auth: { kind: 'pairing', pairing: { kind: 'enter-code', attemptsLeft: 5 } },
      });
    }
  }

  const actions: RemoteUiActions = {
    restoreBrowserSession() {
      requestRestore();
    },

    selectHost(hostId) {
      if (hostId === state.currentHostId) return;
      cancelReconnect();
      if (state.currentHostId) retireHostSession(state.currentHostId, 'replaced');
      bumpEpoch(hostId);
      update({
        currentHostId: hostId,
        connection: { kind: 'resyncing', synced: 0, total: 1 },
        catalog: null,
        catalogInvalidated: true,
      });
      void connectHost(hostId).catch(() => undefined);
    },
    selectSession(sessionId) {
      if (!state.sessions.some((session) => session.id === sessionId)) return;
      update({ view: { kind: 'chat', sessionId }, mobilePage: 'chat', fileViewer: null });
      hydrateSessionDetached(sessionId);
    },
    openNewChat(presetTaskId) {
      update({ view: { kind: 'new-chat', presetTaskId }, mobilePage: 'new-chat' });
      requestCatalog();
    },
    openSettings() {
      update({ view: { kind: 'settings' }, mobilePage: 'settings' });
    },
    openMobilePage(page) {
      update({ mobilePage: page });
    },
    backToChat() {
      const view = state.view.kind === 'chat'
        ? state.view
        : state.sessions[0]
          ? { kind: 'chat' as const, sessionId: state.sessions[0].id }
          : { kind: 'empty' as const };
      update({ view, mobilePage: 'chat', fileViewer: null });
    },
    refreshCatalog() {
      requestCatalog();
    },
    createSession(input: CreateSessionInput) {
      dispatchCommand('session.create', {
        catalog_revision: state.catalogRevision,
        workspace_id: input.workspaceId,
        agent_id: input.agentId,
        task_id: input.taskId,
        name: input.name,
        model: input.model,
        thinking: input.thinking,
        service_tier: input.serviceTier,
      }, 'session.create');
    },
    setDraftText(sessionId, text) {
      const draft = state.drafts[sessionId] ?? emptyDraft();
      update({ drafts: { ...state.drafts, [sessionId]: { ...draft, text } } });
    },
    addDraftAttachment(sessionId, attachment) {
      const draft = state.drafts[sessionId] ?? emptyDraft();
      update({
        drafts: {
          ...state.drafts,
          [sessionId]: { ...draft, attachments: [...draft.attachments, attachment] },
        },
      });
    },
    uploadDraftAttachment(sessionId, file) {
      const started = transferRelay();
      if (!started) return;
      const sendOnBound = (
        send: (message: Record<string, unknown>) => Promise<void>,
      ) => (message: Record<string, unknown>) => {
        const current = transferRelay();
        if (
          !current
          || current.relay !== started.relay
          || current.hostId !== started.hostId
          || current.epoch !== started.epoch
        ) {
          return Promise.reject(new RemoteProtocolError('UNKNOWN_OUTCOME', 'host changed before upload finished'));
        }
        return send(message);
      };
      void uploadRemoteAttachment({
        sessionId,
        name: file.name,
        mime: file.mime,
        bytes: file.bytes,
        sendControl: sendOnBound((message) => started.relay.sendControl(message)),
        sendContent: sendOnBound((message) => started.relay.sendContent(message)),
        registerWaiters: (transferId) => {
          const acks = uploadAcks.get(transferId) ?? new TransferAckGate();
          uploadAcks.set(transferId, acks);
          const result = new Promise<AttachmentUploadResult>((resolve, reject) => {
            uploadWaiters.set(transferId, { hostId: started.hostId, resolve, reject });
          });
          return {
            result,
            acks,
            cleanup: () => {
              rejectTransfer(
                transferId,
                new RemoteProtocolError('UNKNOWN_OUTCOME', 'upload aborted'),
              );
            },
          };
        },
      }).then((attachment) => {
        actions.addDraftAttachment(sessionId, attachment);
      }).catch((error) => {
        update({
          queueNotice: null,
          mutations: {
            ...state.mutations,
            [sessionId]: {
              commandId: sessionId,
              label: 'attachment.upload',
              phase: 'failed',
              errorCode: errorCode(error),
              errorMessage: error instanceof Error ? error.message : 'upload failed',
              startedAt: Date.now(),
            },
          },
        });
      });
    },
    addDraftContextItem(sessionId, item) {
      const draft = state.drafts[sessionId] ?? emptyDraft();
      update({
        drafts: {
          ...state.drafts,
          [sessionId]: { ...draft, contextItems: [...draft.contextItems, item] },
        },
      });
    },
    setDraftDocument(sessionId, doc) {
      const draft = state.drafts[sessionId] ?? emptyDraft();
      update({ drafts: { ...state.drafts, [sessionId]: { ...draft, document: doc } } });
    },
    removeDraftAttachment(sessionId, attachmentId) {
      const draft = state.drafts[sessionId] ?? emptyDraft();
      update({
        drafts: {
          ...state.drafts,
          [sessionId]: {
            ...draft,
            attachments: draft.attachments.filter((item) => item.id !== attachmentId),
          },
        },
      });
    },
    removeDraftContextItem(sessionId, itemId) {
      const draft = state.drafts[sessionId] ?? emptyDraft();
      update({
        drafts: {
          ...state.drafts,
          [sessionId]: {
            ...draft,
            contextItems: draft.contextItems.filter((item) => item.id !== itemId),
          },
        },
      });
    },
    sendDraft(sessionId) {
      const draft = state.drafts[sessionId] ?? emptyDraft();
      if (draftIsEmpty(draft)) return;
      const session = state.sessions.find((item) => item.id === sessionId);
      void sendCommand('session.send', sessionSendParams(sessionId, draft, session), 'session.send')
        .then(() => {
          if (state.drafts[sessionId] !== draft) return;
          update({ drafts: { ...state.drafts, [sessionId]: emptyDraft() } });
        })
        .catch(() => undefined);
    },
    stopSession(sessionId) {
      const session = state.sessions.find((item) => item.id === sessionId);
      if (!session) return;
      dispatchCommand('session.stop', {
        session_id: sessionId,
        session_revision: session.revision,
      }, 'session.stop');
    },
    updateSessionConfig(sessionId, config) {
      const session = state.sessions.find((item) => item.id === sessionId);
      if (!session) return;
      dispatchCommand('session.update', {
        session_id: sessionId,
        session_revision: session.revision,
        ...config,
      }, 'session.update');
    },
    retryTranscript(sessionId) {
      hydrateSessionDetached(sessionId, 'initial', true);
    },
    loadOlderTranscript(sessionId) {
      const transcript = state.transcripts[sessionId];
      if (!transcript?.hasOlder || !transcript.cursor || transcript.loadingOlder) return;
      hydrateSessionDetached(sessionId, 'older');
    },
    editQueueEntry(sessionId, queueId, text) {
      const session = state.sessions.find((item) => item.id === sessionId);
      if (!session) return;
      dispatchCommand('queue.update', {
        session_id: sessionId,
        queue_id: queueId,
        text,
        expected_queue_revision: session.queue.revision,
      }, 'queue.update');
    },
    removeQueueEntry(sessionId, queueId) {
      const session = state.sessions.find((item) => item.id === sessionId);
      if (!session) return;
      dispatchCommand('queue.remove', {
        session_id: sessionId,
        queue_id: queueId,
        expected_queue_revision: session.queue.revision,
      }, 'queue.remove');
    },
    clearQueue(sessionId) {
      const session = state.sessions.find((item) => item.id === sessionId);
      if (!session) return;
      dispatchCommand('queue.clear', {
        session_id: sessionId,
        expected_queue_revision: session.queue.revision,
      }, 'queue.clear');
    },
    sendQueueNow(sessionId) {
      const session = state.sessions.find((item) => item.id === sessionId);
      if (!session) return;
      dispatchCommand('queue.send_now', {
        session_id: sessionId,
        expected_queue_revision: session.queue.revision,
      }, 'queue.send_now');
    },
    respondToInteraction(interactionId, actionId, values) {
      const interaction = state.interactions.find((item) => item.id === interactionId);
      if (!interaction) return;
      dispatchCommand('interaction.respond', {
        interaction_id: interactionId,
        interaction_revision: interaction.revision,
        action_id: actionId,
        values,
      }, 'interaction.respond');
    },
    openFile(handle) {
      update({ fileViewer: { status: 'loading', handle } });
      dispatchCommand('file.preview', { handle_id: handle.id }, 'file.preview');
    },
    closeFile() {
      update({ fileViewer: null, fileDownload: { status: 'idle' } });
    },
    reloadFile() {
      if (state.fileViewer) actions.openFile(state.fileViewer.handle);
    },
    downloadFile() {
      const viewer = state.fileViewer;
      const transport = transferRelay();
      if (!viewer || !transport) return;
      const transferId = generateCanonicalId();
      downloads.set(transferId, startDownload({
        hostId: transport.hostId,
        purpose: 'save',
        handle: viewer.handle,
        name: viewer.handle.label,
        mime: 'application/octet-stream',
      }));
      update({ fileDownload: { status: 'downloading', pct: 0 } });
      void transport.relay.sendControl({
        type: 'download.request',
        transfer_id: transferId,
        kind: 'file',
        handle_id: viewer.handle.id,
      }).catch((error) => {
        downloads.delete(transferId);
        update({
          fileDownload: {
            status: 'error',
            message: error instanceof Error ? error.message : 'download failed',
          },
        });
      });
    },
    refreshState() {
      refreshStateFromUi();
    },
    dismissUnknown(commandId) {
      if (state.unknownCommandId === commandId) update({ unknownCommandId: null });
    },
    setTheme(theme) {
      update({ settings: { ...state.settings, theme } });
    },
    setAccent(accent) {
      update({ settings: { ...state.settings, accent } });
    },
    disconnectHost(hostId) {
      void forgetHost(hostId, { revoke: true });
    },
    logoutBrowser() {
      void (async () => {
        cancelReconnect();
        if (state.currentHostId) bumpEpoch(state.currentHostId);
        await auth.logout().catch(() => undefined);
        await cache.clear();
        hostSessions.clear();
        abortAllDownloads();
        relay?.close('logout');
        clearRelayBinding();
        update({
          auth: { kind: 'challenge-login', hosts: state.hosts },
          connection: { kind: 'browser_offline' },
        });
      })();
    },
    submitPairingCode(code) {
      if (state.auth.kind !== 'pairing' || state.auth.pairing.kind !== 'enter-code') return;
      let formatted: string;
      try {
        formatted = formatPairingCode(code);
      } catch {
        const attemptsLeft = state.auth.pairing.attemptsLeft - 1;
        setPairingFailure(attemptsLeft <= 0 ? 'attempt-limit' : 'invalid');
        return;
      }
      void claimAndWait(formatted, 'This browser');
    },
    setPairingDeviceName(name) {
      if (state.auth.kind === 'pairing' && state.auth.pairing.kind === 'qr-confirm') {
        update({ auth: { kind: 'pairing', pairing: { ...state.auth.pairing, deviceName: name } } });
      }
    },
    confirmQrPairing() {
      if (qrNonce && state.auth.kind === 'pairing' && state.auth.pairing.kind === 'qr-confirm') {
        const nonce = qrNonce;
        qrNonce = undefined;
        void claimAndWait(undefined, state.auth.pairing.deviceName, nonce);
      }
    },
    cancelPairing() {
      ++pairingGeneration;
      if (state.currentHostId) bumpEpoch(state.currentHostId);
      if (pollTimer) clearTimeout(pollTimer);
      setPairingFailure('cancelled');
    },
    restartPairing() {
      const generation = ++pairingGeneration;
      const hostId = state.currentHostId;
      cancelReconnect();
      if (hostId) {
        bumpEpoch(hostId);
        retireHostSession(hostId, 'disconnected');
      }
      void (async () => {
        if (hostId) await clearHostPairingMaterial(hostId);
        if (closed || generation !== pairingGeneration) return;
        update({
          auth: { kind: 'pairing', pairing: { kind: 'enter-code', attemptsLeft: 5 } },
          connection: { kind: 'browser_offline' },
          currentHostId: null,
          hosts: hostId ? state.hosts.filter((host) => host.id !== hostId) : state.hosts,
        });
      })();
    },
    challengeLogin(hostId) {
      if (state.currentHostId && state.currentHostId !== hostId) {
        retireHostSession(state.currentHostId, 'replaced');
      }
      update({
        currentHostId: hostId,
        connection: { kind: 'resyncing', synced: 0, total: 1 },
        catalog: null,
        catalogInvalidated: true,
      });
      void connectHost(hostId).catch(() => undefined);
    },
  };

  if (options.autoRestore !== false && !qrNonce) {
    requestRestore();
  }
  browserEvents?.addEventListener('offline', handleBrowserOffline);
  browserEvents?.addEventListener('online', handleBrowserOnline);

  return {
    get state() {
      return state;
    },
    actions,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      closed = true;
      browserEvents?.removeEventListener('offline', handleBrowserOffline);
      browserEvents?.removeEventListener('online', handleBrowserOnline);
      ++pairingGeneration;
      cancelReconnect();
      if (state.currentHostId) bumpEpoch(state.currentHostId);
      if (pollTimer) clearTimeout(pollTimer);
      abortAllDownloads();
      relay?.close('closed');
      clearRelayBinding();
    },
  };
}

function emptyUiState(): RemoteUiState {
  return {
    auth: { kind: 'pairing', pairing: { kind: 'enter-code', attemptsLeft: 5 } },
    connection: { kind: 'browser_offline' },
    hosts: [],
    currentHostId: null,
    workspaces: [],
    tasks: [],
    sessions: [],
    interactions: [],
    interactionPhases: {},
    capabilities: {},
    catalogRevision: '',
    catalog: null,
    catalogInvalidated: false,
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

function relayWsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/ws`;
  url.search = '';
  return url.toString();
}

function detectPlatform(): string {
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform;
  if (/mac/i.test(platform)) return 'macOS';
  if (/win/i.test(platform)) return 'Windows';
  if (/linux/i.test(platform)) return 'Linux';
  return 'Web';
}

function detectUserAgent(): string {
  return typeof navigator === 'undefined' ? 'GianRemote/1' : navigator.userAgent.slice(0, 256);
}

function errorCode(error: unknown): string {
  if (error instanceof RemoteProtocolError) return error.code;
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code;
  return 'AUTH_REQUIRED';
}

function devicePairingWasLost(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'DEVICE_NOT_PAIRED' || code === 'DEVICE_REVOKED';
}

function isReplaySafeRead(
  method: RemoteMethod,
): method is 'catalog.read' | 'state.refresh' | 'session.subscribe' | 'session.page' {
  return method === 'catalog.read'
    || method === 'state.refresh'
    || method === 'session.subscribe'
    || method === 'session.page';
}

function showsUnknownOutcome(method: RemoteMethod): boolean {
  return method === 'session.create'
    || method === 'session.update'
    || method === 'session.send'
    || method === 'session.stop'
    || method === 'queue.update'
    || method === 'queue.remove'
    || method === 'queue.clear'
    || method === 'queue.send_now'
    || method === 'interaction.respond';
}

function connectionAfterFailure(error: unknown): RemoteUiState['connection'] {
  return devicePairingWasLost(error)
    ? { kind: 'device_revoked' }
    : { kind: 'host_offline', lastSeenAt: Date.now() };
}

function saveBrowserFile(name: string, mime: string, bytes: Uint8Array): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([bytes.slice().buffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function mapPairingFailure(error: unknown, current: RemoteUiState): PairingFailure {
  const code = errorCode(error);
  if (code === 'HOST_OFFLINE') return 'host-offline';
  if (code === 'DEVICE_REVOKED') return 'rejected';
  if (code === 'RATE_LIMITED') return 'attempt-limit';
  if (current.auth.kind === 'pairing' && current.auth.pairing.kind === 'enter-code' && current.auth.pairing.attemptsLeft <= 1) {
    return 'attempt-limit';
  }
  return 'invalid';
}

export function resolveRemoteWebBoot(search: string): 'production' | { fixture: string } {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const fixture = params.get('fixture');
  return fixture ? { fixture } : 'production';
}
