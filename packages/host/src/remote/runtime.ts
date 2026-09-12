import {
  PRESENCE_HEARTBEAT_MS,
  RemoteProtocolError,
  cryptoAcceptPayload,
  cryptoOfferPayload,
  exportPublicJwk,
  generateCanonicalId,
  generateP256KeyPair,
  importP256PublicKey,
  type CanonicalEvent,
  type CommandRequest,
  type CryptoOffer,
  type RelayNotice,
  type RemoteAttention,
  type RemoteControlMessage,
  type RemoteStatePatch,
  type StatePatch,
  verifyBytes,
} from '@gian/remote-protocol';
import type { ServerToClientMessage, RemoteSettingsSnapshot, RemoteSettingsPairing } from '@gian/shared';
import { PeerCryptoSession } from './crypto-session.js';
import type { GianToolAccessController } from '../tool/access.js';
import type { GianToolService } from '../tool/service.js';
import type { SessionManager } from '../session/manager.js';
import type { TaskManager } from '../task/manager.js';
import type { Db } from '../storage/db.js';
import { RemoteMutationAudit } from './audit.js';
import { RemoteAttachmentService } from './attachment-stream.js';
import { effectiveRemoteCapabilities } from './capability.js';
import { RemoteCommandAdapter } from './command-adapter.js';
import { RemoteConnector, type RemotePeerTransport } from './connector.js';
import { RemoteDeviceStore, devicePublicKeyCanonical } from './device-store.js';
import type { RemoteDeviceRecord } from './device-store.js';
import { RemoteEnrollmentStore } from './enrollment.js';
import { RemoteFileRefService } from './file-ref.js';
import { HostRelaySocket } from './host-relay.js';
import type { RemoteIdentityMaterial } from './identity.js';
import { RemotePairingService, type RemotePairingRecord } from './pairing.js';
import {
  RemoteProjector,
  isRemoteSessionVisible,
  projectRemoteInteraction,
} from './projection.js';
import { RemoteReplayBuffer } from './replay-buffer.js';
import { HttpRemoteServerAuthClient } from './server-client.js';

export interface RemoteRuntimeDeps {
  db: Db;
  sessions: SessionManager;
  tasks: TaskManager;
  access: GianToolAccessController;
  tool: GianToolService;
  identity: RemoteIdentityMaterial;
  dataDir: string;
  hostVersion: string;
  hostName?: string;
  now?: () => Date;
  listAgents?: () => Array<{
    id: string;
    name?: string;
    proxy?: string;
    defaults?: { model?: string | null; thinking?: string | null };
  }>;
  hostEvents?: {
    onBroadcast(listener: (message: ServerToClientMessage) => void): () => void;
  };
}

export class RemoteRuntime {
  readonly generation = generateCanonicalId();
  readonly devices: RemoteDeviceStore;
  readonly pairings: RemotePairingService;
  readonly enrollment: RemoteEnrollmentStore;
  readonly audit: RemoteMutationAudit;
  readonly attachments: RemoteAttachmentService;
  readonly fileRefs: RemoteFileRefService;
  readonly projector: RemoteProjector;
  readonly replay = new RemoteReplayBuffer();
  readonly commands: RemoteCommandAdapter;
  private readonly connectors = new Map<string, RemoteConnector>();
  private relay: HostRelaySocket | null = null;
  private authClient: HttpRemoteServerAuthClient | null = null;
  private readonly identity: RemoteIdentityMaterial;
  private shuttingDown = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private connecting: Promise<void> | null = null;
  private enrolling: Promise<{ host_id: string }> | null = null;
  private connectionEpoch = 0;
  private lastHeartbeatAt: string | null = null;
  private heartbeatFailed = false;
  private displayGrant: { id: string; code: string; nonce: string } | null = null;
  private dismissedPairingId: string | null = null;
  private creatingPairing = false;
  private readonly decidingPairings = new Set<string>();
  private readonly revokingDevices = new Set<string>();
  private readonly hostName: string;
  private readonly hostVersion: string;
  private readonly sessions: SessionManager;
  private readonly tasks: TaskManager;
  private readonly db: Db;
  private readonly subscriptions = new Map<string, string>();
  private attention: RemoteAttention[] = [];
  private detachHostEvents: (() => void) | null = null;

  constructor(deps: RemoteRuntimeDeps) {
    this.hostName = deps.hostName ?? 'Gian Host';
    this.hostVersion = deps.hostVersion;
    this.sessions = deps.sessions;
    this.tasks = deps.tasks;
    this.db = deps.db;
    this.devices = new RemoteDeviceStore(deps.db);
    this.pairings = new RemotePairingService(deps.db, this.devices, deps.now ?? (() => new Date()));
    this.identity = deps.identity;
    this.enrollment = new RemoteEnrollmentStore(deps.db, deps.identity);
    this.audit = new RemoteMutationAudit(deps.db);
    const sessionVisible = (sessionId: string): boolean => {
      try {
        const session = deps.sessions.getSession(sessionId);
        return isRemoteSessionVisible(deps.db, session);
      } catch {
        return false;
      }
    };
    this.attachments = new RemoteAttachmentService(deps.db, deps.dataDir, sessionVisible);
    this.fileRefs = new RemoteFileRefService(deps.db, sessionId => {
      try {
        if (!sessionVisible(sessionId)) return null;
        const workspaceId = deps.sessions.getSession(sessionId).workspace_id;
        if (!workspaceId) return null;
        const row = deps.db.prepare('SELECT path FROM workspaces WHERE id = ?')
          .get(workspaceId) as { path: string } | undefined;
        return row?.path ?? null;
      } catch {
        return null;
      }
    }, sessionVisible);
    const fallbackHostId = generateCanonicalId();
    const enrollment = this.enrollment;
    const hostName = this.hostName;
    const hostVersion = this.hostVersion;
    this.projector = new RemoteProjector({
      db: deps.db,
      sessions: deps.sessions,
      tasks: deps.tasks,
      hostGeneration: this.generation,
      host: {
        get id() {
          return enrollment.current()?.hostId ?? fallbackHostId;
        },
        get name() {
          return enrollment.current()?.hostName ?? hostName;
        },
        version: hostVersion,
      },
      listAgents: deps.listAgents,
      attachments: this.attachments,
      fileRefs: this.fileRefs,
      workspacePath: sessionId => {
        try {
          const workspaceId = deps.sessions.getSession(sessionId).workspace_id;
          if (!workspaceId) return null;
          const row = deps.db.prepare('SELECT path FROM workspaces WHERE id = ?')
            .get(workspaceId) as { path: string } | undefined;
          return row?.path ?? null;
        } catch {
          return null;
        }
      },
    });
    this.commands = new RemoteCommandAdapter({
      db: deps.db,
      access: deps.access,
      tool: deps.tool,
      sessions: deps.sessions,
      projector: this.projector,
      attachments: this.attachments,
      fileRefs: this.fileRefs,
      audit: this.audit,
      hostGeneration: this.generation,
      listAgents: deps.listAgents,
      snapshot: device => this.projector.snapshot({
        capabilities: effectiveRemoteCapabilities({
          device,
          hostOnline: true,
          wireFeatures: ['wire.snapshot_parts', 'wire.content_resume'],
        }),
        attention: this.attention,
        deviceId: device.id,
        eventSequence: this.replay.eventSequence,
      }),
      onSubscribe: (deviceId, sessionId) => this.subscriptions.set(deviceId, sessionId),
    });
    this.detachHostEvents = deps.hostEvents?.onBroadcast(message => {
      this.observeHostBroadcast(message);
    }) ?? null;
  }

  get relaySocket(): HostRelaySocket | null {
    return this.relay;
  }

  async enroll(input: { serverUrl: string; enrollmentToken: string; publicUrl?: string }): Promise<{ host_id: string }> {
    if (this.enrolling || this.enrollment.current()) throw new Error('already_enrolled');
    const attempt = this.enrollOnce(input);
    this.enrolling = attempt;
    try { return await attempt; } finally { this.enrolling = null; }
  }

  private async enrollOnce(input: { serverUrl: string; enrollmentToken: string; publicUrl?: string }): Promise<{ host_id: string }> {
    const epoch = this.connectionEpoch;
    const serverUrl = remoteOrigin(input.serverUrl);
    const publicUrl = input.publicUrl ? remoteOrigin(input.publicUrl) : serverUrl;
    const identity = await this.identity.ensurePublic();
    const auth = new HttpRemoteServerAuthClient(serverUrl, this.identity);
    const claimed = await auth.claimEnrollment({
      enrollmentToken: input.enrollmentToken,
      hostName: this.hostName,
      hostVersion: this.hostVersion,
      hostPublicKey: identity.public_key,
    });
    if (epoch !== this.connectionEpoch) throw new Error('connection_cancelled');
    await this.enrollment.recordClaim({
      hostId: claimed.host_id,
      serverUrl,
      serverIdentity: claimed.server_identity,
      hostName: this.hostName,
      refreshSecret: claimed.connector_refresh_secret,
    });
    if (epoch !== this.connectionEpoch) throw new Error('connection_cancelled');
    this.enrollment.setPublicUrl(publicUrl);
    this.authClient = auth;
    await this.start();
    return { host_id: claimed.host_id };
  }

  async start(): Promise<void> {
    const enrollment = this.enrollment.current();
    if (!enrollment?.connectorEnabled || enrollment.pendingIdentityFingerprint) return;
    if (this.relay?.bound) return;
    this.shuttingDown = false;
    this.startHeartbeat();
    try {
      await this.connectRelay();
      if (!this.relay?.bound && this.enrollment.current()?.serverUrl) {
        this.scheduleReconnect();
      }
    } catch {
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    this.enrollment.setEnabled(false);
    this.stopConnection();
  }

  async reconnect(): Promise<void> {
    if (!this.enrollment.current()) throw new Error('not_enrolled');
    if (this.enrollment.current()?.pendingIdentityFingerprint) throw new Error('identity_changed');
    this.enrollment.setEnabled(true);
    await this.start();
  }

  setPublicUrl(url: string): void {
    if (!this.enrollment.current()) throw new Error('not_enrolled');
    this.enrollment.setPublicUrl(remoteOrigin(url));
  }

  async disableRemote(): Promise<void> {
    this.disconnect();
    // Fence late network/identity writes before dropping the saved credential.
    await Promise.allSettled([this.connecting, this.enrolling].filter(Boolean));
    for (const device of this.devices.list()) this.devices.revoke(device.id);
    this.pairings.clear();
    this.displayGrant = null;
    // The existing broker treats an empty secret as absent.
    await this.identity.setRefreshSecret('');
    this.enrollment.clear();
  }

  async confirmServerIdentityChange(expectedFingerprint: string): Promise<void> {
    if (this.enrollment.current()?.pendingIdentityFingerprint !== expectedFingerprint) {
      throw new Error('identity_changed');
    }
    this.enrollment.confirmServerIdentityChange();
    await this.reconnect();
  }

  rejectServerIdentityChange(): void {
    this.disconnect();
    this.enrollment.rejectServerIdentityChange();
  }

  async revokeDevice(deviceId: string, options?: { notifyServer?: boolean }): Promise<RemoteDeviceRecord> {
    const device = this.devices.revoke(deviceId);
    this.connectors.get(deviceId)?.close();
    this.connectors.delete(deviceId);
    this.subscriptions.delete(deviceId);
    this.fileRefs.invalidateDevice(deviceId);
    this.attachments.invalidateDevice(deviceId);
    if (options?.notifyServer === false) this.devices.markRevocationSynced(deviceId);
    if (options?.notifyServer !== false) {
      this.revokingDevices.add(deviceId);
      try {
        if (!this.authClient) await this.connectRelay();
        if (!this.authClient) throw new RemoteProtocolError('HOST_OFFLINE', 'Host relay is not connected');
        try {
          await this.authClient.revokeDevice(deviceId);
          this.devices.markRevocationSynced(deviceId);
        } catch (error) {
          if (!(error instanceof RemoteProtocolError) || error.code !== 'AUTH_REQUIRED') throw error;
          await this.connectRelay();
          if (!this.devices.revocationSynced(deviceId)) {
            if (!this.authClient) throw error;
            await this.authClient.revokeDevice(deviceId);
            this.devices.markRevocationSynced(deviceId);
          }
        }
      } catch {
        // Host remains the authority even if Server is unreachable.
      } finally {
        this.revokingDevices.delete(deviceId);
      }
    }
    return device;
  }

  async createPairingGrant(): Promise<{
    pairing_id: string;
    grant_id: string;
    code: string;
    grant_nonce: string;
    expires_at: string;
  }> {
    if (this.creatingPairing) throw new Error('pairing_busy');
    this.creatingPairing = true;
    const epoch = this.connectionEpoch;
    try {
      await this.ensureRelay();
      for (const pending of this.pairings.listPending()) await this.cancelPairing(pending.id);
      const grant = await this.authClient!.createPairing();
      if (epoch !== this.connectionEpoch) throw new Error('connection_cancelled');
      const pairing = this.pairings.recordServerGrant({
        grantId: grant.grant_id,
        code: grant.code,
        grantNonce: grant.grant_nonce,
        expiresAt: grant.expires_at,
      });
      this.displayGrant = { id: pairing.id, code: grant.code, nonce: grant.grant_nonce };
      this.dismissedPairingId = null;
      return {
        pairing_id: pairing.id,
        grant_id: grant.grant_id,
        code: grant.code,
        grant_nonce: grant.grant_nonce,
        expires_at: pairing.expiresAt,
      };
    } finally {
      this.creatingPairing = false;
    }
  }

  async cancelPairing(pairingId: string): Promise<void> {
    const pairing = this.pairings.get(pairingId);
    if (!pairing) throw new Error('pairing_not_found');
    if (this.decidingPairings.has(pairing.id)) throw new Error('pairing_busy');
    if (pairing.status === 'pending_claim' || pairing.status === 'pending_confirmation') {
      this.pairings.reject(pairing.id);
      if (pairing.serverPairingId && this.authClient) {
        await this.authClient.confirmPairing(pairing.serverPairingId, 'reject').catch(() => undefined);
      }
    }
    this.displayGrant = null;
    this.dismissedPairingId = pairing.id;
  }

  async confirmPairing(pairingId: string, decision: 'confirm' | 'reject'): Promise<{
    pairing_id: string;
    status: string;
    device_id?: string;
  }> {
    if (this.decidingPairings.has(pairingId)) throw new Error('pairing_busy');
    this.decidingPairings.add(pairingId);
    const epoch = this.connectionEpoch;
    try {
      await this.ensureRelay();
      const local = this.pairings.get(pairingId);
      if (!local || local.status !== 'pending_confirmation' || !local.devicePublicKey) {
        throw new RemoteProtocolError('DEVICE_NOT_PAIRED', 'pairing is not waiting for confirmation');
      }
      const serverId = local.serverPairingId ?? pairingId;
      const result = await this.authClient!.confirmPairing(serverId, decision);
      if (epoch !== this.connectionEpoch) throw new Error('connection_cancelled');
      if (decision === 'reject') {
        this.pairings.reject(local.id);
        return { pairing_id: local.id, status: 'rejected' };
      }
      if (!local.devicePublicKey || !result.device_id) {
        throw new RemoteProtocolError('DEVICE_NOT_PAIRED', 'pairing confirm did not create a device');
      }
      const publicKey = local.devicePublicKey;
      const device = this.db.transaction(() => {
        const created = this.devices.createGeneration({
          id: result.device_id,
          publicKey,
          name: local.deviceName ?? 'Remote device',
          platform: local.platform ?? 'unknown',
          cryptoConnectionId: result.crypto_connection_id,
        });
        this.pairings.confirm(local.id, created.id);
        return created;
      })();
      return { pairing_id: local.id, status: 'confirmed', device_id: device.id };
    } finally {
      this.decidingPairings.delete(pairingId);
    }
  }

  connectDevice(
    device: RemoteDeviceRecord,
    crypto: PeerCryptoSession,
    transport?: RemotePeerTransport,
  ): RemoteConnector {
    this.connectors.get(device.id)?.close();
    const route = transport ?? this.relay?.attachDevice(device.id);
    if (!route) {
      throw new Error('Host relay is not connected');
    }
    const connector = new RemoteConnector(
      route,
      crypto,
      this.replay,
      (record, command: CommandRequest, hooks) => {
        const live = this.devices.get(record.id) ?? record;
        return this.commands.execute(live, command, hooks);
      },
      device,
      this.authClient ?? undefined,
      this.enrollment.current()?.hostId,
      { attachments: this.attachments, fileRefs: this.fileRefs },
    );
    this.connectors.set(device.id, connector);
    return connector;
  }

  connectorFor(deviceId: string): RemoteConnector | undefined {
    return this.connectors.get(deviceId);
  }

  private async ensureRelay(): Promise<void> {
    const enrollment = this.enrollment.current();
    if (!enrollment?.connectorEnabled || enrollment.pendingIdentityFingerprint) {
      throw new RemoteProtocolError('HOST_OFFLINE', 'Remote connection is disabled or awaiting identity confirmation');
    }
    if (this.relay?.bound && this.authClient) return;
    await this.start();
    if (!this.relay?.bound || !this.authClient) {
      throw new RemoteProtocolError('HOST_OFFLINE', 'Host relay is not connected');
    }
  }

  private async connectRelay(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = this.connectRelayOnce().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connectRelayOnce(): Promise<void> {
    const epoch = this.connectionEpoch;
    const checkCurrent = () => {
      if (this.shuttingDown || epoch !== this.connectionEpoch) throw new Error('connection_cancelled');
    };
    const enrollment = this.enrollment.current();
    if (!enrollment?.connectorEnabled || enrollment.pendingIdentityFingerprint || this.shuttingDown) return;
    const refreshSecret = await this.identity.getRefreshSecret();
    checkCurrent();
    if (!enrollment?.serverUrl || !refreshSecret) return;
    const auth = this.authClient ?? new HttpRemoteServerAuthClient(enrollment.serverUrl, this.identity);
    const challenge = await auth.challenge(enrollment.hostId);
    checkCurrent();
    await this.enrollment.verifySignedChallenge({
      hostId: enrollment.hostId,
      challengeId: challenge.challenge_id,
      challenge: challenge.challenge,
      expiresAt: challenge.expires_at,
      serverIdentity: challenge.server_identity,
      signature: challenge.server_identity_signature,
    });
    checkCurrent();
    const signature = await this.identity.sign(new TextEncoder().encode(challenge.challenge_id));
    checkCurrent();
    await auth.login({
      hostId: enrollment.hostId,
      challengeId: challenge.challenge_id,
      signature,
      refreshSecret: (await this.identity.getRefreshSecret()) ?? refreshSecret,
    });
    checkCurrent();
    const ticket = await auth.hostWsTicket();
    checkCurrent();
    const wsUrl = `${enrollment.serverUrl.replace(/^http/i, 'ws').replace(/\/$/, '')}/ws`;
    this.authClient = auth;
    this.relay?.close('replaced');
    const relay = await HostRelaySocket.connect({ url: wsUrl, ticket });
    if (this.shuttingDown || epoch !== this.connectionEpoch) {
      relay.close('connection_cancelled');
      return;
    }
    this.relay = relay;
    this.lastHeartbeatAt = new Date().toISOString();
    this.heartbeatFailed = false;
    this.relay.onNotice((notice) => this.handleNotice(notice));
    this.relay.onHandshake((offer) => {
      void this.acceptHandshake(offer).catch((error) => {
        console.error('[remote] handshake accept failed', error);
      });
    });
    this.relay.onClose((reason) => {
      if (this.relay === relay) this.relay = null;
      if (this.shuttingDown || reason === 'replaced') return;
      this.scheduleReconnect();
    });
    this.reconnectAttempts = 0;
    await this.syncRevokedDevices();
  }

  async maintainPresence(): Promise<void> {
    await this.pulse();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.pulse();
    }, PRESENCE_HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private async pulse(): Promise<void> {
    if (this.shuttingDown) return;
    const enrollment = this.enrollment.current();
    if (!enrollment?.serverUrl || !enrollment.connectorEnabled || enrollment.pendingIdentityFingerprint) return;
    if (!this.relay?.bound || !this.authClient) {
      try {
        await this.connectRelay();
      } catch {
        this.scheduleReconnect();
      }
      return;
    }
    try {
      await this.authClient.heartbeat(enrollment.hostId);
      if (!this.shuttingDown) {
        this.lastHeartbeatAt = new Date().toISOString();
        this.heartbeatFailed = false;
      }
      await this.syncRevokedDevices();
    } catch (error) {
      this.heartbeatFailed = true;
      if (error instanceof RemoteProtocolError && error.code === 'AUTH_REQUIRED') {
        try {
          await this.connectRelay();
        } catch {
          this.scheduleReconnect();
        }
        return;
      }
      this.scheduleReconnect();
    }
  }

  private async syncRevokedDevices(): Promise<void> {
    if (!this.authClient) return;
    for (const device of this.devices.list()) {
      if (!device.revokedAt || this.devices.revocationSynced(device.id)) continue;
      try {
        await this.authClient.revokeDevice(device.id);
        this.devices.markRevocationSynced(device.id);
      } catch {
        // Already revoked or Server has not seen this device yet.
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown || this.reconnectTimer || this.enrollment.current()?.pendingIdentityFingerprint) return;
    const delay = Math.min(30_000, 500 * (2 ** this.reconnectAttempts)) + Math.floor(Math.random() * 200);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectRelay().catch(() => this.scheduleReconnect());
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async acceptHandshake(offer: CryptoOffer): Promise<void> {
    if (!this.relay) return;
    const device = this.devices.getActive(offer.device_id);
    if (!device) return;
    if (!device.cryptoConnectionId || device.cryptoConnectionId !== offer.crypto_connection_id) return;
    if (devicePublicKeyCanonical(offer.device_identity) !== device.publicKey) return;
    const enrollment = this.enrollment.current();
    if (!enrollment || enrollment.hostId !== offer.host_id) return;
    const deviceKey = await importP256PublicKey(JSON.parse(device.publicKey) as {
      kty: 'EC'; crv: 'P-256'; x: string; y: string;
    }, 'verify');
    const offerOk = await verifyBytes(
      deviceKey,
      new TextEncoder().encode(cryptoOfferPayload({
        host_id: offer.host_id,
        device_id: offer.device_id,
        crypto_connection_id: offer.crypto_connection_id,
        handshake_nonce: offer.handshake_nonce,
        sent_at: offer.sent_at,
        device_identity: offer.device_identity,
        device_ephemeral: offer.device_ephemeral,
      })),
      Buffer.from(offer.signature, 'base64url'),
    );
    if (!offerOk) return;
    if (!this.pairings.consumeHandshakeNonce({
      handshakeNonce: offer.handshake_nonce,
      deviceId: offer.device_id,
      signedAt: offer.sent_at,
    })) {
      return;
    }
    const hostIdentity = await this.identity.ensurePublic();
    const ephemeral = await generateP256KeyPair();
    const hostEphemeral = await exportPublicJwk(ephemeral.publicKey);
    const sentAt = Date.now();
    const acceptFields = {
      host_id: offer.host_id,
      device_id: offer.device_id,
      crypto_connection_id: offer.crypto_connection_id,
      handshake_nonce: offer.handshake_nonce,
      sent_at: sentAt,
      host_generation: this.generation,
      host_identity: hostIdentity.public_key,
      device_identity: offer.device_identity,
      host_ephemeral: hostEphemeral,
      device_ephemeral: offer.device_ephemeral,
    };
    const crypto = await PeerCryptoSession.fromHandshake({
      localPrivate: ephemeral.privateKey,
      remotePublic: await importP256PublicKey(offer.device_ephemeral, 'deriveBits'),
      transcript: {
        host_identity: hostIdentity.public_key,
        device_identity: offer.device_identity,
        host_ephemeral: hostEphemeral,
        device_ephemeral: offer.device_ephemeral,
        connection_id: offer.crypto_connection_id,
      },
      sendDirection: 'host_to_device',
      binding: {
        hostGeneration: this.generation,
        hostId: offer.host_id,
        deviceId: offer.device_id,
        routeId: offer.device_id,
        connectionId: offer.crypto_connection_id,
      },
    });
    const connector = this.connectDevice(device, crypto);
    this.relay.sendHandshake({
      protocol: 'gian.relay/1',
      type: 'crypto.accept',
      host_id: acceptFields.host_id,
      device_id: acceptFields.device_id,
      crypto_connection_id: acceptFields.crypto_connection_id,
      handshake_nonce: acceptFields.handshake_nonce,
      host_generation: acceptFields.host_generation,
      host_identity: acceptFields.host_identity,
      host_ephemeral: acceptFields.host_ephemeral,
      device_ephemeral: acceptFields.device_ephemeral,
      signature: await this.identity.sign(new TextEncoder().encode(cryptoAcceptPayload(acceptFields))),
      sent_at: sentAt,
    });
    void connector.sendControl({ type: 'snapshot.required', reason: 'crypto_resumed' }).catch(() => undefined);
  }

  private handleNotice(notice: RelayNotice): void {
    if (notice.type === 'pairing.claimed' && notice.grant_id && notice.pairing_id && notice.device_public_key) {
      try {
      this.pairings.applyServerClaim({
        grantId: notice.grant_id,
        pairingId: notice.pairing_id,
        publicKey: notice.device_public_key,
        platform: notice.platform,
        userAgent: notice.user_agent,
        name: notice.device_name,
      });
      } catch {
        // A delayed claim must never revive a locally cancelled/expired grant.
        void this.authClient?.confirmPairing(notice.pairing_id, 'reject').catch(() => undefined);
      }
      return;
    }
    if (notice.type === 'device.revoked' && notice.device_id) {
      void this.handleSignedSelfRevoke(notice);
    }
  }

  private async handleSignedSelfRevoke(notice: RelayNotice): Promise<void> {
    if (
      !notice.device_id
      || !notice.signature
      || !notice.signed_at
      || !notice.device_public_key
    ) {
      return;
    }
    try {
      await this.pairings.applySignedSelfRevoke({
        deviceId: notice.device_id,
        hostId: notice.host_id,
        signedAt: notice.signed_at,
        signature: notice.signature,
        publicKey: notice.device_public_key,
      });
      await this.revokeDevice(notice.device_id, { notifyServer: false });
      this.relay?.ackRevoked(notice);
    } catch {
      // Unsigned or invalid notices must not permanently revoke.
    }
  }

  observeHostBroadcast(message: ServerToClientMessage): void {
    try {
      if (message.type === 'session:created' || message.type === 'session:updated') {
        this.publishSession(message.session.id);
        return;
      }
      if (message.type === 'session:deleted') {
        this.publishRemove('sessions', message.session_id);
        return;
      }
      if (message.type === 'queue:updated') {
        this.publishSession(message.session_id);
        return;
      }
      if (message.type === 'task:created' || message.type === 'task:updated') {
        this.publishTask(message.task.id, 'status' in message.task ? message.task.status : undefined);
        return;
      }
      if (message.type === 'task:deleted') {
        this.publishTaskUnavailable(message.task_id);
        return;
      }
      if (message.type === 'approval:created' || message.type === 'approval:updated') {
        this.publishInteraction(message.approval.id, message.type === 'approval:updated');
        return;
      }
      if (message.type === 'attention') {
        if (!this.projector.isSessionIdVisible(message.session_id)) {
          const filtered = this.attention.filter(item => item.session_id !== message.session_id);
          if (filtered.length !== this.attention.length) {
            this.attention = filtered;
            this.publish({
              type: 'event',
              host_generation: this.generation,
              event_sequence: this.replay.eventSequence,
              event: { kind: 'attention.updated', attention: this.attention },
            });
            this.publishPatch({ attention: this.attention });
          }
          return;
        }
        const kind = message.kind === 'turn-completed'
          ? 'completed'
          : message.kind === 'error'
            ? 'failed'
            : message.kind === 'approval' || message.kind === 'question'
              ? 'interaction'
              : 'running';
        const attention: RemoteAttention = {
          session_id: message.session_id,
          kind,
          updated_at: new Date(message.timestamp).toISOString(),
        };
        this.attention = [
          ...this.attention.filter(item => item.session_id !== attention.session_id),
          attention,
        ];
        this.publish({
          type: 'event',
          host_generation: this.generation,
          event_sequence: this.replay.eventSequence,
          event: { kind: 'attention.updated', attention: this.attention },
        });
        this.publishPatch({ attention: this.attention });
        return;
      }
      if (message.type === 'event') {
        this.publishTranscriptEvent(message);
      }
    } catch {
      // A bad local broadcast must not drop the Host relay.
    }
  }

  private publishSession(sessionId: string): void {
    try {
      const session = this.sessions.getSession(sessionId);
      if (!this.projector.isSessionVisible(session)) {
        const filtered = this.attention.filter(item => item.session_id !== sessionId);
        const attentionChanged = filtered.length !== this.attention.length;
        this.attention = filtered;
        this.publishPatch({
          sessions: { upsert: [], remove_ids: [sessionId] },
          ...(attentionChanged ? { attention: this.attention } : {}),
        });
        return;
      }
      const projected = this.projector.projectSession(session);
      this.publish({
        type: 'event',
        host_generation: this.generation,
        event_sequence: this.replay.eventSequence,
        event: { kind: 'session.updated', session: projected },
      });
      this.publishPatch({ sessions: { upsert: [projected], remove_ids: [] } });
    } catch {
      this.publishRemove('sessions', sessionId);
    }
  }

  private publishTask(taskId: string, status?: string): void {
    if (status && status !== 'open') {
      this.publishTaskUnavailable(taskId);
      return;
    }
    const task = this.tasks.listTasks().find(item => item.id === taskId);
    if (!task || task.status !== 'open') {
      this.publishTaskUnavailable(taskId);
      return;
    }
    const projected = {
      id: task.id,
      name: task.name,
      updated_at: task.updated_at,
      session_ids: this.sessions.listSessions({ includeArchived: false })
        .filter(session => session.task_id === task.id && this.projector.isSessionVisible(session))
        .map(session => session.id),
    };
    this.publishPatch({ tasks: { upsert: [projected], remove_ids: [] } });
  }

  private publishTaskUnavailable(taskId: string): void {
    const sessionIds = this.sessions.listSessions({ includeArchived: true })
      .filter((session) => session.task_id === taskId)
      .map((session) => session.id);
    const removed = new Set(sessionIds);
    const filtered = this.attention.filter((item) => !removed.has(item.session_id));
    const attentionChanged = filtered.length !== this.attention.length;
    this.attention = filtered;
    this.publishPatch({
      tasks: { upsert: [], remove_ids: [taskId] },
      ...(sessionIds.length > 0
        ? { sessions: { upsert: [], remove_ids: sessionIds } }
        : {}),
      ...(attentionChanged ? { attention: this.attention } : {}),
    });
  }

  private publishInteraction(interactionId: string, maybeResolved: boolean): void {
    const pending = this.sessions.getPendingApproval(interactionId);
    if (!pending) {
      if (maybeResolved) this.publishRemove('interactions', interactionId);
      return;
    }
    if (!this.projector.isSessionIdVisible(pending.sessionId)) return;
    const row = this.db.prepare(
      'SELECT resource_revision FROM proxy_interactions WHERE interaction_id = ?',
    ).get(interactionId) as { resource_revision?: number } | undefined;
    const projected = projectRemoteInteraction(pending, String(row?.resource_revision ?? 0));
    this.publish({
      type: 'event',
      host_generation: this.generation,
      event_sequence: this.replay.eventSequence,
      event: { kind: 'interaction.updated', interaction: projected },
    });
    this.publishPatch({ interactions: { upsert: [projected], remove_ids: [] } });
  }

  private publishRemove(collection: 'sessions' | 'tasks' | 'interactions', id: string): void {
    this.publishPatch({
      [collection]: { upsert: [], remove_ids: [id] },
    } as RemoteStatePatch);
  }

  private publishPatch(patch: RemoteStatePatch): void {
    const baseRevision = this.replay.currentRevision;
    const revision = this.projector.revision();
    this.publish({
      type: 'state.patch',
      host_generation: this.generation,
      event_sequence: this.replay.eventSequence,
      base_revision: baseRevision,
      revision,
      patch,
    });
  }

  private publish(
    message: CanonicalEvent | StatePatch,
    scope?: { sessionId?: string },
  ): void {
    const stamped = {
      ...message,
      host_generation: this.generation,
      event_sequence: this.replay.eventSequence,
    } as RemoteControlMessage;
    if (scope?.sessionId) {
      this.fanout(stamped, scope);
      return;
    }
    const revision = stamped.type === 'state.patch' ? stamped.revision : this.replay.currentRevision;
    this.replay.push(stamped, revision);
    this.fanout(stamped);
  }

  private fanout(message: object, scope?: { sessionId?: string }): void {
    for (const [deviceId, connector] of this.connectors) {
      if (scope?.sessionId && this.subscriptions.get(deviceId) !== scope.sessionId) continue;
      void connector.sendControl(message).catch(() => undefined);
    }
  }

  private publishTranscriptEvent(message: Extract<ServerToClientMessage, { type: 'event' }>): void {
    if (!this.projector.isSessionIdVisible(message.session_id)) return;
    for (const [deviceId, connector] of this.connectors) {
      if (this.subscriptions.get(deviceId) !== message.session_id) continue;
      const item = this.projector.projectTranscriptEvent(message, deviceId);
      if (!item) continue;
      void connector.sendControl({
        type: 'event',
        host_generation: this.generation,
        event_sequence: this.replay.eventSequence,
        event: {
          kind: 'transcript.item',
          session_id: message.session_id,
          item,
        },
      }).catch(() => undefined);
    }
  }

  settingsState(): RemoteSettingsSnapshot {
    const enrollment = this.enrollment.current();
    const latest = this.pairings.latest();
    const pairing = latest?.id === this.dismissedPairingId ? null : latest;
    if (this.displayGrant && (!pairing || pairing.id !== this.displayGrant.id
        || !['pending_claim', 'pending_confirmation'].includes(pairing.status))) this.displayGrant = null;
    const presentPairing = (record: RemotePairingRecord): RemoteSettingsPairing => {
      const display = record.id === this.displayGrant?.id ? this.displayGrant : null;
      const qr = display && enrollment ? new URL('/', enrollment.publicUrl) : null;
      if (qr && display) qr.hash = new URLSearchParams({ nonce: display.nonce }).toString();
      return {
        id: record.id, status: record.status,
        code: display?.code ?? null, qr_payload: qr?.href ?? null,
        device_name: record.deviceName, platform: record.platform,
        user_agent: record.userAgent, claimed_network: record.claimedNetwork,
        claimed_at: record.claimedAt, created_at: record.createdAt, expires_at: record.expiresAt,
      };
    };
    return {
      enrolled: enrollment !== null,
      host_id: enrollment?.hostId ?? null,
      host_name: enrollment?.hostName ?? null,
      server_url: enrollment?.serverUrl ?? null,
      public_url: enrollment?.publicUrl ?? null,
      connection: !enrollment ? 'offline'
        : !enrollment.connectorEnabled || this.shuttingDown ? 'disconnected'
          : enrollment.pendingIdentityFingerprint ? 'offline'
            : this.relay?.bound && !this.heartbeatFailed ? 'online' : 'reconnecting',
      last_heartbeat_at: this.lastHeartbeatAt,
      server_identity_fingerprint: enrollment?.serverIdentityFingerprint ?? null,
      pending_identity_fingerprint: enrollment?.pendingIdentityFingerprint ?? null,
      identity_changed_at: enrollment?.identityChangedAt ?? null,
      pairing: pairing ? presentPairing(pairing) : null,
      devices: (enrollment ? this.devices.list() : []).map(device => ({
        id: device.id,
        name: device.name,
        platform: device.platform,
        grants: [...device.grants],
        created_at: device.createdAt,
        last_seen_at: device.lastSeenAt,
        revoked_at: device.revokedAt,
        revision: device.revision,
        active_connections: this.connectors.get(device.id)?.connected ? 1 : 0,
        revoke_status: !device.revokedAt ? 'active'
          : this.revokingDevices.has(device.id) ? 'revoke-pending'
            : this.devices.revocationSynced(device.id) ? 'revoked' : 'pending-reconciliation',
      })),
      pending_pairings: this.pairings.listPending().map(record => {
        const { code: _code, qr_payload: _qr, ...metadata } = presentPairing(record);
        return metadata;
      }),
    };
  }

  close(): void {
    this.stopConnection();
    this.detachHostEvents?.();
    this.detachHostEvents = null;
    this.displayGrant = null;
  }

  private stopConnection(): void {
    this.shuttingDown = true;
    this.connectionEpoch += 1;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.subscriptions.clear();
    for (const connector of this.connectors.values()) connector.close();
    this.connectors.clear();
    this.relay?.close('host_closed');
    this.relay = null;
    this.authClient = null;
  }
}

export function remoteOrigin(value: string): string {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('invalid_url');
  }
  return url.origin;
}
