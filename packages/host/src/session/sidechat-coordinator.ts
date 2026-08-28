import { randomUUID } from 'node:crypto';
import { requestViolation, type ProxyProtocolError, type SideChatSnapshot } from '@gian/proxy-protocol';
import type {
  ConfigOption,
  ConfigValue,
  InputItem,
  Session,
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
import { deriveSidechatAgentTitle } from './sidechat-title.js';

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

function isConfigValue(value: unknown): value is ConfigValue {
  return value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}

function turnOptions(options: readonly ConfigOption[]): ConfigOption[] {
  return options.filter((option) => option.binding === 'turn');
}

function inheritTurnOptionRoles(
  options: readonly ConfigOption[],
  roleSource: readonly ConfigOption[],
): ConfigOption[] {
  const roles = new Map(roleSource.flatMap((option) => (
    option.role ? [[option.id, option.role] as const] : []
  )));
  return turnOptions(options).map((option) => {
    const role = roles.get(option.id);
    return role && option.role === undefined ? { ...option, role } : option;
  });
}

function optionAccepts(option: ConfigOption, value: unknown): value is ConfigValue {
  if (!isConfigValue(value)) return false;
  if (option.control === 'select' && option.choices?.length) {
    return option.choices.some((choice) => Object.is(choice.value, value));
  }
  if (value === null) return true;
  if (option.control === 'boolean') return typeof value === 'boolean';
  if (option.control === 'number') return typeof value === 'number';
  if (option.control === 'text') return typeof value === 'string';
  return true;
}

function roleValue(parent: Session, role: ConfigOption['role']): ConfigValue | undefined {
  if (role === 'model') return parent.model;
  if (role === 'effort') return parent.thinking_effort;
  if (role === 'approval_mode') return parent.approval_mode;
  if (role === 'fast') return parent.service_tier === 'fast';
  return undefined;
}

function ownConfigValue(
  values: Record<string, ConfigValue> | undefined,
  id: string,
): ConfigValue | undefined {
  return values && Object.prototype.hasOwnProperty.call(values, id) ? values[id] : undefined;
}

export function initialSidechatTurnConfig(
  parent: Session,
  options: readonly ConfigOption[],
): Record<string, ConfigValue> {
  const result: Record<string, ConfigValue> = {};
  for (const option of turnOptions(options)) {
    const persisted = ownConfigValue(parent.turn_config, option.id);
    const native = ownConfigValue(parent.executor_config?.values, option.id);
    const role = roleValue(parent, option.role);
    const candidate = persisted !== undefined
      ? persisted
      : native !== undefined
        ? native
        : role !== undefined ? role : option.defaultValue;
    if (candidate !== undefined && optionAccepts(option, candidate)) result[option.id] = candidate;
  }
  return result;
}

function normalizeStoredTurnConfig(
  options: readonly ConfigOption[],
  requested: Record<string, ConfigValue>,
): Record<string, ConfigValue> {
  const result: Record<string, ConfigValue> = {};
  for (const option of turnOptions(options)) {
    const requestedValue = Object.prototype.hasOwnProperty.call(requested, option.id)
      ? requested[option.id]
      : option.defaultValue;
    const value = requestedValue !== undefined && optionAccepts(option, requestedValue)
      ? requestedValue
      : option.defaultValue;
    if (value !== undefined && optionAccepts(option, value)) result[option.id] = value;
  }
  return result;
}

function reconcileTurnConfig(
  options: readonly ConfigOption[],
  requested: Record<string, ConfigValue>,
): Record<string, ConfigValue> {
  const byId = new Map(turnOptions(options).map((option) => [option.id, option]));
  for (const [id, value] of Object.entries(requested)) {
    const option = byId.get(id);
    if (!option) throw requestViolation('CONFIG_VALUE_INVALID', `Side Chat config ${id} is not advertised.`);
    if (!optionAccepts(option, value)) {
      throw requestViolation('CONFIG_VALUE_INVALID', `Side Chat config ${id} has an invalid value.`);
    }
  }
  return normalizeStoredTurnConfig([...byId.values()], requested);
}

function configConditionsMatch(
  conditions: ConfigOption['visibleWhen'] | ConfigOption['enabledWhen'],
  values: Record<string, ConfigValue>,
): boolean {
  return (conditions ?? []).every((condition) => (
    condition.oneOf.some((candidate) => Object.is(candidate, values[condition.optionId]))
  ));
}

function dispatchableTurnConfig(record: SidechatRecord): Record<string, ConfigValue> {
  const result: Record<string, ConfigValue> = {};
  for (const option of record.turnConfigOptions) {
    if (!configConditionsMatch(option.visibleWhen, record.turnConfig)
      || !configConditionsMatch(option.enabledWhen, record.turnConfig)) continue;
    const value = record.turnConfig[option.id];
    if (value !== undefined) result[option.id] = value;
  }
  return result;
}

function notificationTurnCatalog(notification: unknown): {
  options: ConfigOption[];
  revision: string;
} | null {
  if (!notification || typeof notification !== 'object') return null;
  const message = notification as {
    method?: unknown;
    params?: { data?: { turnConfigOptions?: unknown; turnConfigRevision?: unknown } };
  };
  const options = message.params?.data?.turnConfigOptions;
  const revision = message.params?.data?.turnConfigRevision;
  return message.method === 'session.updated' && Array.isArray(options) && typeof revision === 'string'
    ? { options: turnOptions(options as ConfigOption[]), revision }
    : null;
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
    return this.store.listOpenOrClosing().map(record => toPublicSidechat(this.ensureTitle(record)));
  }

  listByParent(parentSessionId: string): SideChatPublicSnapshot[] {
    return this.store.listByParent(parentSessionId).map(record => toPublicSidechat(this.ensureTitle(record)));
  }

  async create(
    parentSession: Session,
    fallbackTurnOptions: ConfigOption[],
    fallbackTurnRevision: string | null,
    sidechatId = mintSidechatId(),
  ): Promise<SideChatPublicSnapshot> {
    const parentSessionId = parentSession.id;
    const parent = this.requireV2Client(parentSessionId);
    await this.assertCapability(parent, 'sidechat');
    const fingerprint = `${parentSessionId}\u0000${parent.streamId() ?? ''}`;
    const existing = this.store.get(sidechatId);
    if (existing) {
      if (existing.createFingerprint !== fingerprint) {
        throw requestViolation('CONFLICT', 'sidechatId was reused with a different parent');
      }
      return toPublicSidechat(this.ensureTitle(existing));
    }
    const snapshot = await parent.createSidechat({ sidechatId });
    const advertisedTurnOptions = snapshot.turnConfigOptions === undefined
      ? turnOptions(fallbackTurnOptions)
      : inheritTurnOptionRoles(snapshot.turnConfigOptions, fallbackTurnOptions);
    const turnConfig = initialSidechatTurnConfig(parentSession, advertisedTurnOptions);
    const now = new Date().toISOString();
    const record: SidechatRecord = {
      sidechatId: snapshot.id,
      parentSessionId: snapshot.parentSessionId,
      ordinal: this.store.nextOrdinal(snapshot.parentSessionId),
      name: null,
      parentStreamId: parent.streamId(),
      streamId: snapshot.streamId,
      streamGeneration: 1,
      resumeRefId: snapshot.resumeRef.id,
      status: 'open',
      publicState: snapshot.state,
      anchor: protocolAnchorToPublic(snapshot.anchor),
      sessionConfig: snapshot.sessionConfig,
      turnConfig,
      turnConfigOptions: advertisedTurnOptions,
      turnConfigRevision: snapshot.turnConfigOptions !== undefined
        ? snapshot.turnConfigRevision ?? null
        : fallbackTurnRevision,
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
    return record ? toPublicSidechat(this.ensureTitle(record)) : null;
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
      if (snapshot.turnConfigOptions !== undefined) {
        const options = inheritTurnOptionRoles(snapshot.turnConfigOptions, record.turnConfigOptions);
        record.turnConfig = normalizeStoredTurnConfig(options, record.turnConfig);
        record.turnConfigOptions = options;
        record.turnConfigRevision = snapshot.turnConfigRevision ?? null;
      }
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

  async startTurn(
    sidechatId: string,
    input: InputItem[],
    turnId = randomUUID(),
    contextItems?: import('@gian/shared').MessageContextItem[],
    storedInput: InputItem[] = input,
    composerDocument?: import('@gian/shared').ComposerDocument,
    turnConfig?: Record<string, ConfigValue>,
  ): Promise<void> {
    const child = this.requireChildClient(sidechatId);
    const record = turnConfig === undefined
      ? this.store.get(sidechatId)
      : this.persistTurnConfigSnapshot(sidechatId, turnConfig);
    if (!record) throw requestViolation('SESSION_NOT_FOUND', `Side Chat ${sidechatId} was not found`);
    this.store.appendUserInput(sidechatId, turnId, storedInput, contextItems, composerDocument);
    await child.startTurn({
      sessionId: sidechatId,
      turnId,
      input,
      config: dispatchableTurnConfig(record),
    });
  }

  setTurnConfigValue(sidechatId: string, optionId: string, value: ConfigValue): SideChatPublicSnapshot {
    const record = this.store.get(sidechatId);
    if (!record) throw requestViolation('SESSION_NOT_FOUND', `Side Chat ${sidechatId} was not found`);
    const option = record.turnConfigOptions.find((entry) => entry.id === optionId && entry.binding === 'turn');
    if (!option) {
      throw requestViolation('CONFIG_VALUE_INVALID', `Side Chat config ${optionId} is not advertised.`);
    }
    if (!optionAccepts(option, value)) {
      throw requestViolation('CONFIG_VALUE_INVALID', `Side Chat config ${optionId} has an invalid value.`);
    }
    return this.publishTurnConfig(record, reconcileTurnConfig(
      record.turnConfigOptions,
      { ...record.turnConfig, [optionId]: value },
    ));
  }

  async interruptTurn(sidechatId: string): Promise<void> {
    await this.requireChildClient(sidechatId).interruptTurn();
  }

  async steerTurn(sidechatId: string, input: InputItem[]): Promise<void> {
    await this.requireChildClient(sidechatId).steerTurn({ sessionId: sidechatId, input });
  }

  handleNotification(sidechatId: string, notification: unknown): void {
    this.store.appendEvent(sidechatId, notification);
    let record = this.store.get(sidechatId);
    if (!record) return;
    const catalog = notificationTurnCatalog(notification);
    if (catalog) {
      const options = inheritTurnOptionRoles(catalog.options, record.turnConfigOptions);
      const nextConfig = normalizeStoredTurnConfig(options, record.turnConfig);
      record = this.store.setTurnConfigCatalog(
        sidechatId,
        nextConfig,
        options,
        catalog.revision,
      ) ?? record;
    }
    const completedTurnId = turnCompletedId(notification);
    if (completedTurnId) record = this.ensureTitle(record, completedTurnId);
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

  private persistTurnConfigSnapshot(
    sidechatId: string,
    turnConfig: Record<string, ConfigValue>,
  ): SidechatRecord {
    const record = this.store.get(sidechatId);
    if (!record) throw requestViolation('SESSION_NOT_FOUND', `Side Chat ${sidechatId} was not found`);
    const next = reconcileTurnConfig(record.turnConfigOptions, turnConfig);
    this.publishTurnConfig(record, next);
    return this.store.get(sidechatId)!;
  }

  private publishTurnConfig(
    record: SidechatRecord,
    turnConfig: Record<string, ConfigValue>,
  ): SideChatPublicSnapshot {
    const updated = this.store.setTurnConfig(record.sidechatId, turnConfig);
    if (!updated) throw requestViolation('SESSION_NOT_FOUND', `Side Chat ${record.sidechatId} was not found`);
    const snapshot = toPublicSidechat(updated);
    this.broadcaster.broadcast({ type: 'sidechat:updated', sidechat: snapshot });
    return snapshot;
  }

  private unbindRoute(sidechatId: string): void {
    const binding = this.routeBindings.get(sidechatId);
    if (!binding) return;
    this.routeBindings.delete(sidechatId);
    binding.offNotification();
    binding.offFault();
  }

  private ensureTitle(record: SidechatRecord, completedTurnId = latestCompletedTurnId(record.events)): SidechatRecord {
    if (record.name !== null || !completedTurnId) return record;
    try {
      const title = deriveSidechatAgentTitle(record, completedTurnId);
      return title ? this.store.setNameIfUnset(record.sidechatId, title) ?? record : record;
    } catch (error) {
      // Title derivation is presentation metadata and must never break
      // conversation recovery, turn completion, or state sync.
      console.warn(`[sidechat-title] failed sidechat=${record.sidechatId}: ${String(error)}`);
      return record;
    }
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

function latestCompletedTurnId(events: unknown[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || typeof event !== 'object') continue;
    const notification = event as { method?: unknown; params?: { turnId?: unknown } };
    if (notification.method === 'turn.completed' && typeof notification.params?.turnId === 'string') {
      return notification.params.turnId;
    }
  }
  return null;
}

function turnCompletedId(notification: unknown): string | null {
  if (!notification || typeof notification !== 'object') return null;
  const event = notification as { method?: unknown; params?: { turnId?: unknown } };
  return event.method === 'turn.completed' && typeof event.params?.turnId === 'string'
    ? event.params.turnId
    : null;
}

export function newSidechatId(): string {
  return mintSidechatId();
}

export function newForkSessionId(): string {
  return randomUUID();
}
