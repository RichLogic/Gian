import {
  AUTH_PROTOCOL, DeviceRelayClient, REMOTE_METHOD_RESULTS, RemoteProtocolError,
  commandResultSchema, deviceChallengeResultSchema, deviceLoginResultSchema,
  generateCanonicalId, generateUuidV7, identityFingerprint, importP256PublicKey,
  parseClosed, pairingClaimResultSchema, serverChallengePayload, verifyBytes, base64UrlToBytes,
  wsTicketResultSchema, type RemoteMethod, type DeviceRelayClientOptions,
} from '@gian/remote-protocol';
import type { RemoteIdentityMaterial } from './identity.js';
import { HttpRemoteServerAuthClient } from './server-client.js';

export interface RemoteControllerEnvironment {
  id: string;
  name: string;
  server_origin: string;
  server_identity_fingerprint: string;
  host_id: string;
  browser_id: string;
  device_id: string | null;
  crypto_connection_id: string | null;
  host_public_key_json: string | null;
  pairing_id: string | null;
  created_at: number;
}

type ControllerRelay = Pick<DeviceRelayClient, 'isOpen' | 'hostGeneration' | 'connect' | 'sendControl' | 'sendContent' | 'close'>;

export class RemoteControllerClient {
  private relay: ControllerRelay | null = null;
  private connecting: Promise<void> | null = null;
  private accountPeerId: string | null = null;
  private epoch = 0;
  private readonly requests = new Map<string, { method: RemoteMethod; params: string; promise: Promise<unknown> }>();
  private readonly pending = new Map<string, { method: RemoteMethod; resolve(value: unknown): void; reject(error: Error): void;
    timer: ReturnType<typeof setTimeout> }>();
  private readonly controls = new Set<(message: Record<string, unknown>) => void | Promise<void>>();

  constructor(
    readonly environment: RemoteControllerEnvironment,
    private readonly identity: RemoteIdentityMaterial,
    private readonly save: (environment: RemoteControllerEnvironment) => void,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly createRelay: (options: DeviceRelayClientOptions) => ControllerRelay = options => new DeviceRelayClient(options),
  ) {}

  get connected(): boolean { return this.relay?.isOpen === true; }

  static async pair(input: { origin: string; code: string; name: string }, identity: RemoteIdentityMaterial,
    fetchImpl: typeof fetch = globalThis.fetch): Promise<RemoteControllerEnvironment> {
    const credential = await identity.getAccountSession?.(input.origin, 'controller');
    if (!credential || credential.expiresAt <= Date.now()) throw new RemoteProtocolError('AUTH_REQUIRED', 'Remote GitHub login required');
    const id = generateCanonicalId();
    if (!identity.ensureControllerIdentity) throw new RemoteProtocolError('AUTH_REQUIRED', 'secure controller identity unavailable');
    const publicIdentity = await identity.ensureControllerIdentity(id);
    const result = await fetchImpl(new URL('/api/v1/pairings/claim', input.origin), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json', origin: input.origin, 'x-gian-account-token': credential.token },
      body: JSON.stringify({ protocol: AUTH_PROTOCOL, code: input.code, browser_installation_id: id,
        device_public_key: publicIdentity.public_key, platform: process.platform, user_agent: 'Gian Desktop' }),
    });
    if (!result.ok) throw new RemoteProtocolError('AUTH_REQUIRED', 'pairing rejected');
    const claim = parseClosed(pairingClaimResultSchema, await result.json());
    return { id, name: input.name, server_origin: input.origin, server_identity_fingerprint: credential.serverFingerprint,
      host_id: claim.host_id, browser_id: id, device_id: null, crypto_connection_id: claim.crypto_connection_id,
      host_public_key_json: null, pairing_id: claim.pairing_id, created_at: Date.now() };
  }

  async connect(): Promise<void> {
    const credential = await this.identity.getAccountSession?.(this.environment.server_origin, 'controller');
    if (!credential || credential.expiresAt <= Date.now()
      || credential.serverFingerprint !== this.environment.server_identity_fingerprint) {
      this.close();
      throw new RemoteProtocolError('AUTH_REQUIRED', 'Remote account required');
    }
    if (this.connected && this.accountPeerId === credential.installationId) return;
    if (this.connecting) return this.connecting;
    this.close();
    this.accountPeerId = credential.installationId;
    const run = this.connectOnce(this.epoch);
    this.connecting = run;
    try { await run; } finally { if (this.connecting === run) this.connecting = null; }
  }

  request(method: RemoteMethod, params: unknown, commandId = generateUuidV7()): Promise<unknown> {
    const serialized = JSON.stringify(params);
    const existing = this.requests.get(commandId);
    if (existing) return existing.method === method && existing.params === serialized ? existing.promise
      : Promise.reject(new RemoteProtocolError('INVALID_FRAME', 'command identity reused with different input'));
    const promise = this.requestOnce(method, params, commandId).finally(() => this.requests.delete(commandId));
    this.requests.set(commandId, { method, params: serialized, promise });
    return promise;
  }

  private async requestOnce(method: RemoteMethod, params: unknown, commandId: string): Promise<unknown> {
    await this.connect();
    const relay = this.relay;
    if (!relay?.isOpen) throw new RemoteProtocolError('HOST_OFFLINE', 'execution Host disconnected');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A live relay socket does not prove the executing Host still has
        // this E2EE channel. A lost notice must not pin later calls to it.
        if (this.relay === relay) this.close();
      }, 90_000);
      timer.unref();
      this.pending.set(commandId, { method, resolve, reject, timer });
      void relay.sendControl({ type: 'command.request', command_id: commandId,
        attempt_id: generateCanonicalId(), created_at: timestampOf(commandId), method, params,
        expected: { host_generation: relay.hostGeneration } }).catch(() => {
        const request = this.pending.get(commandId);
        if (!request) return;
        clearTimeout(timer); this.pending.delete(commandId);
        reject(new RemoteProtocolError(isRead(method) ? 'HOST_OFFLINE' : 'UNKNOWN_OUTCOME', 'remote connection lost'));
      });
    });
  }

  onControl(listener: (message: Record<string, unknown>) => void | Promise<void>): () => void {
    this.controls.add(listener);
    return () => this.controls.delete(listener);
  }

  async sendControl(message: object): Promise<void> { await this.connect(); await this.relay!.sendControl(message); }
  async sendContent(message: object): Promise<void> { await this.connect(); await this.relay!.sendContent(message); }

  close(): void {
    this.epoch += 1;
    this.connecting = null;
    const relay = this.relay;
    this.relay = null;
    relay?.close('closed');
    this.rejectPending();
  }

  private rejectPending(): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new RemoteProtocolError(isRead(request.method) ? 'HOST_OFFLINE' : 'UNKNOWN_OUTCOME', 'remote connection closed'));
    }
    this.pending.clear();
  }

  private async connectOnce(epoch: number): Promise<void> {
    const environment = this.environment;
    const verifier = new HttpRemoteServerAuthClient(environment.server_origin, this.identity, this.fetchImpl);
    const server = await verifier.challenge(environment.host_id);
    this.assertEpoch(epoch);
    if (server.server_identity_fingerprint !== environment.server_identity_fingerprint
      || await identityFingerprint(server.server_identity.public_key) !== environment.server_identity_fingerprint
      || server.expires_at <= Date.now()) throw new RemoteProtocolError('AUTH_REQUIRED', 'Server identity changed');
    const signatureOk = await verifyBytes(await importP256PublicKey(server.server_identity.public_key, 'verify'),
      new TextEncoder().encode(serverChallengePayload({ host_id: environment.host_id, challenge_id: server.challenge_id,
        challenge: server.challenge, expires_at: server.expires_at, fingerprint: environment.server_identity_fingerprint })),
      base64UrlToBytes(server.server_identity_signature));
    if (!signatureOk) throw new RemoteProtocolError('AUTH_REQUIRED', 'Server signature invalid');
    const challenge = parseClosed(deviceChallengeResultSchema, await this.post('/api/v1/sessions/device-challenge', {
      browser_installation_id: environment.browser_id, host_id: environment.host_id,
    }));
    this.assertEpoch(epoch);
    const login = parseClosed(deviceLoginResultSchema, await this.post('/api/v1/sessions/device-login', {
      browser_installation_id: environment.browser_id, host_id: environment.host_id, challenge_id: challenge.challenge_id,
      signature: await this.sign(new TextEncoder().encode(challenge.challenge_id)),
    }));
    this.assertEpoch(epoch);
    if (environment.host_public_key_json
      && await identityFingerprint(JSON.parse(environment.host_public_key_json)) !== await identityFingerprint(login.host_public_key)) {
      throw new RemoteProtocolError('AUTH_REQUIRED', 'Host key changed');
    }
    this.assertEpoch(epoch);
    environment.device_id = login.device_id;
    environment.crypto_connection_id = login.crypto_connection_id;
    environment.host_public_key_json = JSON.stringify(login.host_public_key);
    environment.pairing_id = null;
    this.save(environment);
    const ticket = parseClosed(wsTicketResultSchema, await this.post('/api/v1/ws-tickets', { host_id: environment.host_id }, login.access_token));
    this.assertEpoch(epoch);
    if (!this.identity.ensureControllerIdentity) throw new RemoteProtocolError('AUTH_REQUIRED', 'secure controller identity unavailable');
    const publicIdentity = await this.identity.ensureControllerIdentity(environment.browser_id);
    this.assertEpoch(epoch);
    const relay = this.createRelay({
      wsUrl: environment.server_origin.replace(/^https:/, 'wss:') + '/ws', ticket: ticket.ticket,
      hostId: environment.host_id, deviceId: login.device_id, cryptoConnectionId: login.crypto_connection_id,
      hostPublicKey: login.host_public_key, application: 'gian-native', requireNegotiated: true, requireExecution: true,
      identity: { hostId: environment.host_id, publicJwk: publicIdentity.public_key, sign: bytes => this.sign(bytes) },
      handlers: {
        onNotice: notice => {
          if (this.epoch !== epoch || this.relay !== relay || notice.host_id !== environment.host_id) return;
          if (notice.type === 'host.offline' || notice.type === 'host.online'
            || (notice.type === 'device.revoked' && notice.device_id === environment.device_id)) {
            // Presence changes invalidate the handshake even if the relay
            // socket survives. Hub sync or the next operation reconnects;
            // uncertain mutations are rejected, never replayed here.
            this.close();
          }
        },
        onControl: async message => {
          if (this.epoch !== epoch || this.relay !== relay) return;
          if (message.type === 'command.result') {
            const result = parseClosed(commandResultSchema, message);
            const pending = this.pending.get(result.command_id);
            if (pending) {
              clearTimeout(pending.timer); this.pending.delete(result.command_id);
              if (result.ok) {
                try {
                  const parsed = REMOTE_METHOD_RESULTS[pending.method].safeParse(result.data);
                  if (!parsed.success) throw new Error('invalid result');
                  pending.resolve(parsed.data);
                }
                catch { pending.reject(new RemoteProtocolError('INVALID_FRAME', 'invalid remote command result')); }
              } else pending.reject(new RemoteProtocolError(result.error?.code ?? 'UNKNOWN_OUTCOME', result.error?.message ?? 'remote command failed'));
            }
          }
          for (const listener of this.controls) await listener(message);
        },
        onClose: () => { if (this.relay === relay) this.close(); },
      },
    });
    this.relay = relay;
    try { await relay.connect(); this.assertEpoch(epoch); }
    catch (error) { if (this.epoch === epoch) this.close(); else relay.close('superseded'); throw error; }
  }

  private assertEpoch(epoch: number): void {
    if (epoch !== this.epoch) throw new RemoteProtocolError('HOST_OFFLINE', 'remote connection superseded');
  }

  private async post(path: string, body: Record<string, unknown>, accessToken?: string): Promise<unknown> {
    const credential = await this.identity.getAccountSession?.(this.environment.server_origin, 'controller');
    if (!credential || credential.expiresAt <= Date.now()) throw new RemoteProtocolError('AUTH_REQUIRED', 'Remote account required');
    const response = await this.fetchImpl(new URL(path, this.environment.server_origin), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json', origin: this.environment.server_origin,
        'x-gian-account-token': credential.token, ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
      body: JSON.stringify({ protocol: AUTH_PROTOCOL, ...body }),
    });
    if (!response.ok) throw new RemoteProtocolError('AUTH_REQUIRED', 'Remote login or pairing required');
    return response.json();
  }

  private async sign(bytes: Uint8Array): Promise<string> {
    if (!this.identity.signControllerIdentity) throw new RemoteProtocolError('AUTH_REQUIRED', 'secure controller signer unavailable');
    return this.identity.signControllerIdentity(this.environment.browser_id, bytes);
  }
}

function isRead(method: RemoteMethod): boolean {
  return ['execution.list', 'execution.sync', 'catalog.read', 'catalog.agent', 'state.refresh', 'session.page',
    'proxy.logo', 'file.preview', 'file.resolve', 'file.tree', 'file.list', 'git.read', 'command.status'].includes(method);
}
function timestampOf(commandId: string): number { return Number.parseInt(commandId.replaceAll('-', '').slice(0, 12), 16); }
