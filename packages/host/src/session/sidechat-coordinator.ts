import { randomUUID } from 'node:crypto';
import { requestViolation, type ProxyProtocolError, type SideChatSnapshot } from '@gian/proxy-protocol';
import type {
  InputItem,
  SideChatPublicSnapshot,
  SidechatCloseResult,
} from '@gian/shared';
import type { ProxyManager } from '../proxy/manager.js';
import type { ProtocolV2SessionClient } from '../proxy/protocol-v2-session-client.js';
import type { WsBroadcaster } from '../web/ws-broadcast.js';
import {
  mintSidechatId,
  SidechatTransientStore,
  toPublicSidechat,
  type SidechatRecord,
} from './sidechat-store.js';

export class SidechatConfirmationRequiredError extends Error {
  readonly code = 'SIDECHAT_CLOSE_CONFIRMATION_REQUIRED';
  constructor(readonly sidechatIds: string[]) {
    super('Closing this Session requires confirming its open Side Chats.');
    this.name = 'SidechatConfirmationRequiredError';
  }
}

function protocolAnchorToPublic(anchor: SideChatSnapshot['anchor']): SidechatRecord['anchor'] {
  if (anchor.type === 'empty') return { type: 'empty' };
  return {
    type: anchor.type,
    turn_id: anchor.turnId,
    source_turn_id: anchor.sourceTurnId,
  };
}

export class SidechatCoordinator {
  private readonly routeBindings = new Map<string, { offNotification: () => void; offFault: () => void }>();
  private readonly recovering = new Map<string, Promise<void>>();
  private readonly recoveredParents = new Map<string, string>();

  constructor(
    private readonly store: SidechatTransientStore,
    private readonly proxy: ProxyManager,
    private readonly broadcaster: WsBroadcaster,
  ) {}

  has(sidechatId: string): boolean {
    return this.store.get(sidechatId) !== null;
  }

  listPublic(): SideChatPublicSnapshot[] {
    return this.store.listOpenOrClosing().map(toPublicSidechat);
  }

  listByParent(parentSessionId: string): SideChatPublicSnapshot[] {
    return this.store.listByParent(parentSessionId).map(toPublicSidechat);
  }

  async create(parentSessionId: string, sidechatId = mintSidechatId()): Promise<SideChatPublicSnapshot> {
    const parent = this.requireV2Client(parentSessionId);
    await this.assertCapability(parent, 'sidechat');
    const fingerprint = `${parentSessionId}\u0000${parent.streamId() ?? ''}`;
    const existing = this.store.get(sidechatId);
    if (existing) {
      if (existing.createFingerprint !== fingerprint) {
        throw requestViolation('CONFLICT', 'sidechatId was reused with a different parent');
      }
      return toPublicSidechat(existing);
    }
    const snapshot = await parent.createSidechat({ sidechatId });
    const now = new Date().toISOString();
    const record: SidechatRecord = {
      sidechatId: snapshot.id,
      parentSessionId: snapshot.parentSessionId,
      parentStreamId: parent.streamId(),
      streamId: snapshot.streamId,
      streamGeneration: 1,
      resumeRefId: snapshot.resumeRef.id,
      status: 'open',
      publicState: snapshot.state,
      anchor: protocolAnchorToPublic(snapshot.anchor),
      sessionConfig: snapshot.sessionConfig,
      events: [],
      userInputs: [],
      lastError: snapshot.lastError ?? null,
      uncertainTurnId: null,
      closeResult: null,
      createFingerprint: fingerprint,
      createdAt: snapshot.createdAt ?? now,
      updatedAt: snapshot.updatedAt ?? now,
    };
    this.store.upsert(record);
    this.bindRoute(sidechatId, parent.runtimeHost().createSessionClient(sidechatId));
    const publicSnapshot = toPublicSidechat(record);
    this.broadcaster.broadcast({ type: 'sidechat:created', sidechat: publicSnapshot });
    return publicSnapshot;
  }

  getPublic(sidechatId: string): SideChatPublicSnapshot | null {
    const record = this.store.get(sidechatId);
    return record ? toPublicSidechat(record) : null;
  }

  async resume(sidechatId: string, parentSessionId: string): Promise<SideChatPublicSnapshot> {
    const record = this.store.get(sidechatId);
    if (!record) throw requestViolation('SESSION_NOT_FOUND', `Side Chat ${sidechatId} was not found`);
    if (record.parentSessionId !== parentSessionId) {
      throw requestViolation('CONFLICT', 'sidechat.resume parent does not match');
    }
    if (record.status === 'open') {
      const child = this.optionalChildClient(sidechatId);
      if (child?.hasAttachedSession()) return toPublicSidechat(record);
    }
    if (record.status === 'closing') {
      await this.close(sidechatId);
      const closed = this.store.get(sidechatId);
      if (!closed) throw requestViolation('SESSION_NOT_FOUND', 'Side Chat already closed');
      return toPublicSidechat(closed);
    }
    const parent = this.requireV2Client(parentSessionId);
    try {
      const snapshot = await parent.resumeSidechat({
        sidechatId,
        resumeRef: { id: record.resumeRefId },
      });
      record.streamId = snapshot.streamId;
      record.streamGeneration += 1;
      record.resumeRefId = snapshot.resumeRef.id;
      record.status = 'open';
      record.publicState = snapshot.state;
      record.lastError = null;
      record.updatedAt = snapshot.updatedAt;
      this.store.upsert(record);
      this.bindRoute(sidechatId, parent.runtimeHost().createSessionClient(sidechatId));
    } catch (error) {
      const code = domainCode(error);
      if (code === 'SIDECHAT_UNAVAILABLE') {
        this.store.markUnavailable(sidechatId, error instanceof Error ? error.message : String(error));
        const unavailable = this.store.get(sidechatId)!;
        const publicSnapshot = toPublicSidechat(unavailable);
        this.broadcaster.broadcast({ type: 'sidechat:updated', sidechat: publicSnapshot });
        return publicSnapshot;
      }
      throw error;
    }
    const publicSnapshot = toPublicSidechat(this.store.get(sidechatId)!);
    this.broadcaster.broadcast({ type: 'sidechat:updated', sidechat: publicSnapshot });
    return publicSnapshot;
  }

  async close(sidechatId: string): Promise<SidechatCloseResult> {
    const record = this.store.get(sidechatId);
    if (!record) {
      return { ok: true, sidechatId, providerDataDeleted: false };
    }
    if (record.closeResult) {
      this.unbindRoute(sidechatId);
      this.store.delete(sidechatId);
      return record.closeResult;
    }
    const owner = this.store.findByResumeRef(record.resumeRefId);
    if (owner && owner.sidechatId !== sidechatId) {
      throw requestViolation('CONFLICT', 'resumeRef belongs to another live Side Chat');
    }
    this.store.markClosing(sidechatId);
    this.broadcaster.broadcast({
      type: 'sidechat:updated',
      sidechat: toPublicSidechat(this.store.get(sidechatId)!),
    });
    const parent = this.proxy.get(record.parentSessionId);
    if (!parent || !isV2Client(parent) || !parent.closeSidechat) {
      throw requestViolation('RUNTIME_ERROR', 'Parent Side Chat Proxy is unavailable');
    }
    try {
      const result = await parent.closeSidechat({
        sidechatId,
        ...(record.streamId ? { streamId: record.streamId } : {}),
        resumeRef: { id: record.resumeRefId },
      });
      return this.finishClose(sidechatId, record.parentSessionId, result);
    } catch (error) {
      const code = domainCode(error);
      if (code === 'SIDECHAT_UNAVAILABLE' || code === 'SESSION_NOT_FOUND') {
        return this.finishClose(sidechatId, record.parentSessionId, {
          ok: true,
          sidechatId,
          providerDataDeleted: false,
        });
      }
      throw error;
    }
  }

  async recoverForParent(parentSessionId: string): Promise<void> {
    const recoveryKey = this.parentRecoveryKey(parentSessionId);
    if (recoveryKey && this.recoveredParents.get(parentSessionId) === recoveryKey) {
      return;
    }
    const existing = this.recovering.get(parentSessionId);
    if (existing) return existing;
    const pending = this.recoverParent(parentSessionId);
    this.recovering.set(parentSessionId, pending);
    try {
      await pending;
      const confirmed = this.parentRecoveryKey(parentSessionId);
      if (confirmed) this.recoveredParents.set(parentSessionId, confirmed);
    } finally {
      if (this.recovering.get(parentSessionId) === pending) this.recovering.delete(parentSessionId);
    }
  }

  private async recoverParent(parentSessionId: string): Promise<void> {
    for (const record of this.store.listByParent(parentSessionId)) {
      if (record.status === 'closing') {
        await this.close(record.sidechatId);
        continue;
      }
      if (record.uncertainTurnId == null && record.status === 'open') {
        const lastTurn = latestTurnId(record.events);
        if (lastTurn) this.store.markUncertainTurn(record.sidechatId, lastTurn);
      }
      await this.resume(record.sidechatId, parentSessionId);
    }
  }

  assertParentCloseConfirmed(parentSessionId: string, confirmedIds: string[] | undefined): void {
    const open = this.store.listByParent(parentSessionId);
    if (open.length === 0) return;
    const confirmed = new Set(confirmedIds ?? []);
    const missing = open.filter((record) => !confirmed.has(record.sidechatId)).map((record) => record.sidechatId);
    if (missing.length > 0) throw new SidechatConfirmationRequiredError(missing);
  }

  async closeAllForParent(parentSessionId: string, confirmedIds: string[]): Promise<void> {
    this.assertParentCloseConfirmed(parentSessionId, confirmedIds);
    for (const record of this.store.listByParent(parentSessionId)) {
      await this.close(record.sidechatId);
    }
  }

  async startTurn(sidechatId: string, input: InputItem[], turnId = randomUUID()): Promise<void> {
    const child = this.requireChildClient(sidechatId);
    this.store.appendUserInput(sidechatId, turnId, input);
    await child.startTurn({
      sessionId: sidechatId,
      turnId,
      input,
      config: {},
    });
  }

  async interruptTurn(sidechatId: string): Promise<void> {
    await this.requireChildClient(sidechatId).interruptTurn();
  }

  async steerTurn(sidechatId: string, input: InputItem[]): Promise<void> {
    await this.requireChildClient(sidechatId).steerTurn({ sessionId: sidechatId, input });
  }

  handleNotification(sidechatId: string, notification: unknown): void {
    this.store.appendEvent(sidechatId, notification);
    const record = this.store.get(sidechatId);
    if (!record) return;
    this.broadcaster.broadcast({ type: 'sidechat:updated', sidechat: toPublicSidechat(record) });
  }

  quarantine(sidechatId: string, error: Error): void {
    this.store.markUnavailable(sidechatId, error.message);
    const record = this.store.get(sidechatId);
    if (record) {
      this.broadcaster.broadcast({ type: 'sidechat:updated', sidechat: toPublicSidechat(record) });
    }
  }

  private bindRoute(sidechatId: string, client: ProtocolV2SessionClient): void {
    this.unbindRoute(sidechatId);
    this.routeBindings.set(sidechatId, {
      offNotification: client.onNotification((notification) => this.handleNotification(sidechatId, notification)),
      offFault: client.onSessionFault((error) => this.quarantine(sidechatId, error)),
    });
  }

  private unbindRoute(sidechatId: string): void {
    const binding = this.routeBindings.get(sidechatId);
    if (!binding) return;
    this.routeBindings.delete(sidechatId);
    binding.offNotification();
    binding.offFault();
  }

  private optionalChildClient(sidechatId: string): ProtocolV2SessionClient | null {
    const record = this.store.get(sidechatId);
    if (!record) return null;
    const parent = this.proxy.get(record.parentSessionId);
    if (!parent || !isV2Client(parent)) return null;
    return parent.runtimeHost().createSessionClient(sidechatId);
  }

  private requireChildClient(sidechatId: string): ProtocolV2SessionClient {
    const child = this.optionalChildClient(sidechatId);
    if (!child) throw requestViolation('SESSION_NOT_FOUND', `Side Chat ${sidechatId} was not found`);
    return child;
  }

  private finishClose(
    sidechatId: string,
    parentSessionId: string,
    result: SidechatCloseResult,
  ): SidechatCloseResult {
    this.store.persistCloseResult(sidechatId, result);
    this.unbindRoute(sidechatId);
    this.store.delete(sidechatId);
    this.broadcaster.broadcast({
      type: 'sidechat:closed',
      sidechat_id: sidechatId,
      parent_session_id: parentSessionId,
      provider_data_deleted: result.providerDataDeleted,
    });
    return result;
  }

  private parentRecoveryKey(parentSessionId: string): string | null {
    const parent = this.proxy.get(parentSessionId);
    if (!parent) return null;
    const streamCandidate = parent as { streamId?: () => string | null };
    const streamId = typeof streamCandidate.streamId === 'function'
      ? streamCandidate.streamId()
      : null;
    if (typeof streamId !== 'string' || streamId.length === 0) return null;
    const groupCandidate = parent as { processGroupId?: () => number };
    const groupId = typeof groupCandidate.processGroupId === 'function'
      ? groupCandidate.processGroupId()
      : null;
    const generation = typeof groupId === 'number' && Number.isFinite(groupId) && groupId !== 0
      ? String(groupId)
      : '';
    return `${generation}\u0000${streamId}`;
  }

  private requireV2Client(sessionId: string): ProtocolV2SessionClient {
    const client = this.proxy.get(sessionId);
    if (!client || !isV2Client(client) || !client.createSidechat) {
      throw requestViolation('CAPABILITY_NOT_SUPPORTED', 'Parent Session has no Side Chat-capable Proxy');
    }
    return client;
  }

  private async assertCapability(
    client: ProtocolV2SessionClient,
    capability: 'sidechat' | 'session.fork' | 'session.fork.atTurn',
  ): Promise<void> {
    const initialized = await client.initialize();
    if (initialized.capabilities[capability] === undefined) {
      throw requestViolation('CAPABILITY_NOT_SUPPORTED', `${capability} is not advertised`);
    }
  }
}

function isV2Client(client: unknown): client is ProtocolV2SessionClient {
  return !!client
    && typeof client === 'object'
    && 'protocolV2' in client
    && (client as { protocolV2?: true }).protocolV2 === true;
}

function domainCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    return String((error as { code: unknown }).code);
  }
  if (error && typeof error === 'object' && 'domainCode' in error) {
    return String((error as { domainCode: unknown }).domainCode);
  }
  const protocol = error as ProxyProtocolError;
  return protocol?.code;
}

function latestTurnId(events: unknown[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || typeof event !== 'object') continue;
    const params = (event as { params?: { turnId?: unknown } }).params;
    if (typeof params?.turnId === 'string') return params.turnId;
  }
  return null;
}

export function newSidechatId(): string {
  return mintSidechatId();
}

export function newForkSessionId(): string {
  return randomUUID();
}
