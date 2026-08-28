import type {
  ApprovalDecision,
  ConfigOption,
  GianToolCall,
  GianToolCatalogAgent,
  GianToolDelivery,
  GianToolInteraction,
  GianToolMethod,
  GianToolMethodData,
  GianToolMethodParams,
  GianToolResult,
  InteractionInput,
  Session,
  UserAgent,
  Workspace,
} from '@gian/shared';
import {
  isApprovalMode,
  isGianToolMutation,
  usesNativeExecutorConfig,
  validateGianToolCall,
} from '@gian/shared';
import type { ApprovalManager, ApprovalRecord } from '../approval/index.js';
import type { AgentManager } from '../agents/manager.js';
import type { Db } from '../storage/db.js';
import type { TaskManager } from '../task/manager.js';
import type { SessionManager } from '../session/manager.js';
import type { WsBroadcaster } from '../web/ws-broadcast.js';
import { fail, toolError } from './errors.js';
import {
  GianToolLedger,
  toolInputHash,
  type ToolDeliveryRow,
  type ToolRequestRow,
} from './ledger.js';
import type { GianToolActor } from './credentials.js';
import {
  configOptionsByRole,
  projectInteraction,
  projectMessages,
  projectTurnInteractions,
  resolvedConfig,
  validateConfigValue,
} from './projections.js';
import { createAndBindWorktree } from './worktree.js';

interface TurnRow {
  id: string;
  session_id: string;
  turn_number: number;
  status: 'running' | 'completed' | 'error' | 'stopped';
  config_json: string | null;
  created_at: string;
  completed_at: string | null;
}

interface ServiceDependencies {
  db: Db;
  tasks: TaskManager;
  sessions: SessionManager;
  approvals: ApprovalManager;
  broadcaster: WsBroadcaster;
  agents?: AgentManager;
}

type AnyData = GianToolMethodData[GianToolMethod];

const TERMINAL_STATES = new Set(['completed', 'error', 'stopped']);

function configChoices(options: ConfigOption[], role: string): Array<{ id: string; label: string }> {
  const option = configOptionsByRole(options, role);
  return (option?.choices ?? []).map(choice => ({
    id: String(choice.value),
    label: choice.displayName,
  }));
}

function parseConfig(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function inputMap(record: ApprovalRecord): InteractionInput[] {
  const inputs = record.payload?.['inputs'];
  return Array.isArray(inputs) ? inputs as InteractionInput[] : [];
}

function questionMap(record: ApprovalRecord): Array<{
  question: string;
  multiSelect: boolean;
  options: Array<{ label: string }>;
}> {
  const questions = record.payload?.['questions'];
  return Array.isArray(questions) ? questions as ReturnType<typeof questionMap> : [];
}

function validateInteractionAnswers(
  record: ApprovalRecord,
  answers: Record<string, string | boolean | string[]> | undefined,
): void {
  for (const question of questionMap(record)) {
    const answer = answers?.[question.question];
    if (answer === undefined) fail('INVALID_INTERACTION_RESPONSE', `Missing answer: ${question.question}`);
    const selected = Array.isArray(answer) ? answer : [answer];
    if (selected.some(value => typeof value !== 'string')) {
      fail('INVALID_INTERACTION_RESPONSE', `Invalid answer type: ${question.question}`);
    }
    if (!question.multiSelect && selected.length !== 1) {
      fail('INVALID_INTERACTION_RESPONSE', `Choose one answer: ${question.question}`);
    }
    const allowed = new Set(question.options.map(option => option.label));
    if (selected.some(value => !allowed.has(value as string))) {
      fail('INVALID_INTERACTION_RESPONSE', `Answer is not an advertised option: ${question.question}`);
    }
  }
  for (const input of inputMap(record)) {
    const answer = answers?.[input.id];
    if (answer === undefined) {
      if (input.required) fail('INVALID_INTERACTION_RESPONSE', `Missing answer: ${input.label}`);
      continue;
    }
    if (input.type === 'boolean' && typeof answer !== 'boolean') {
      fail('INVALID_INTERACTION_RESPONSE', `${input.label} requires a boolean`);
    }
    if (input.type === 'multi_select' && (!Array.isArray(answer) || answer.some(value => typeof value !== 'string'))) {
      fail('INVALID_INTERACTION_RESPONSE', `${input.label} requires multiple choices`);
    }
    if (input.type !== 'multi_select' && input.type !== 'boolean' && typeof answer !== 'string') {
      fail('INVALID_INTERACTION_RESPONSE', `${input.label} requires one string value`);
    }
    if (input.choices && input.choices.length > 0) {
      const allowed = new Set(input.choices.map(choice => choice.value));
      const selected = Array.isArray(answer) ? answer : [answer];
      if (selected.some(value => typeof value !== 'string' || !allowed.has(value))) {
        fail('INVALID_INTERACTION_RESPONSE', `${input.label} must use an advertised choice`);
      }
    }
  }
}

export class GianToolService {
  private ledger: GianToolLedger;
  private inFlight = new Map<string, {
    method: GianToolMethod;
    inputHash: string;
    promise: Promise<GianToolResult<AnyData>>;
  }>();
  private closing = false;

  constructor(private deps: ServiceDependencies) {
    this.ledger = new GianToolLedger(deps.db);
  }

  async call(raw: unknown, context?: { actor: GianToolActor }): Promise<GianToolResult<AnyData>> {
    let call: GianToolCall;
    try {
      call = validateGianToolCall(raw);
    } catch (error) {
      const requestId = raw && typeof raw === 'object' && 'request_id' in raw
        && typeof (raw as { request_id?: unknown }).request_id === 'string'
        ? (raw as { request_id: string }).request_id
        : '';
      return { ok: false, request_id: requestId, error: { ...toolError(error), code: 'INVALID_ARGUMENT' } };
    }
    if (this.closing) {
      return { ok: false, request_id: call.request_id, error: toolError(new Error('service is shutting down')) };
    }
    if (!isGianToolMutation(call.method)) return this.executeRead(call, context);

    const key = `${call.caller_id}\0${call.idempotency_key}`;
    const inputHash = toolInputHash(call.method, call.params);
    const active = this.inFlight.get(key);
    if (active) {
      if (active.method !== call.method || active.inputHash !== inputHash) {
        return {
          ok: false,
          request_id: call.request_id,
          error: {
            code: 'IDEMPOTENCY_CONFLICT',
            message: 'idempotency_key is already in flight with different input',
            retryable: false,
          },
        };
      }
      const first = await active.promise;
      return { ...first, request_id: call.request_id };
    }
    const run = this.executeMutation(call, context);
    this.inFlight.set(key, { method: call.method, inputHash, promise: run });
    try {
      return await run;
    } finally {
      if (this.inFlight.get(key)?.promise === run) this.inFlight.delete(key);
    }
  }

  close(): void {
    this.closing = true;
  }

  private async executeRead(
    call: GianToolCall,
    context?: { actor: GianToolActor },
  ): Promise<GianToolResult<AnyData>> {
    try {
      return { ok: true, request_id: call.request_id, data: await this.dispatch(call, undefined, context) };
    } catch (error) {
      return { ok: false, request_id: call.request_id, error: toolError(error) };
    }
  }

  private async executeMutation(
    call: GianToolCall,
    context?: { actor: GianToolActor },
  ): Promise<GianToolResult<AnyData>> {
    let request: ToolRequestRow;
    try {
      request = this.ledger.claim(call);
    } catch (error) {
      return { ok: false, request_id: call.request_id, error: toolError(error) };
    }
    if (request.status === 'succeeded') {
      return { ok: true, request_id: call.request_id, data: request.result as AnyData };
    }
    if (request.status === 'failed') {
      return { ok: false, request_id: call.request_id, error: request.error ?? toolError(new Error()) };
    }
    try {
      const data = await this.dispatch(call, request, context);
      this.ledger.succeed(request.id, data);
      return { ok: true, request_id: call.request_id, data };
    } catch (error) {
      const normalized = toolError(error);
      this.ledger.fail(request.id, normalized);
      return { ok: false, request_id: call.request_id, error: normalized };
    }
  }

  private async dispatch(
    call: GianToolCall,
    request?: ToolRequestRow,
    context?: { actor: GianToolActor },
  ): Promise<AnyData> {
    const params = call.params as never;
    switch (call.method) {
      case 'catalog.get_create_options': return this.catalog(params);
      case 'task.list': return this.taskList(params);
      case 'task.get': return this.taskGet(params);
      case 'task.create': return this.taskCreate(params, request!);
      case 'task.update': return this.taskUpdate(params);
      case 'session.list': return this.sessionList(params);
      case 'session.get': return this.sessionGet(params);
      case 'session.read': return this.sessionRead(params);
      case 'session.create': return this.sessionCreate(params, request!, context?.actor);
      case 'session.update': return this.sessionUpdate(params);
      case 'session.assign_task': return this.sessionAssignTask(params);
      case 'session.set_subtask_state': return this.sessionSetSubtaskState(params);
      case 'session.archive': return this.sessionArchive(params);
      case 'session.send': return this.sessionSend(params, request!);
      case 'session.cancel_delivery': return this.cancelDelivery(
        params,
        call.caller_id,
        request!,
        context?.actor !== undefined,
      );
      case 'session.wait': return this.sessionWait(params);
      case 'session.stop': return this.sessionStop(params);
      case 'worktree.create_and_bind': return this.worktreeCreateAndBind(params, context?.actor);
      case 'interaction.list': return this.interactionList(params);
      case 'interaction.respond': return this.interactionRespond(params, request!);
    }
  }

  private async catalog(
    params: GianToolMethodParams['catalog.get_create_options'],
  ): Promise<GianToolMethodData['catalog.get_create_options']> {
    const workspaces = this.deps.db.prepare(
      'SELECT id, name, path FROM workspaces WHERE hidden = 0 ORDER BY sort_order, created_at',
    ).all() as Array<Pick<Workspace, 'id' | 'name' | 'path'>>;
    if (!this.deps.agents) return { workspaces, agents: [] };
    const agents: GianToolCatalogAgent[] = [];
    for (const agent of this.deps.agents.listAgents()) {
      const status = await this.deps.agents.agentStatus(agent.id, params.refresh === true);
      const cliPath = this.deps.agents.agentRuntimePath(agent.id).cliPath;
      let catalog = this.deps.sessions.getCapabilities(agent.proxy, cliPath);
      if (params.refresh && status.ready) catalog = await this.deps.sessions.warmCapabilities(agent.proxy, cliPath);
      const options = catalog?.configOptions ?? [];
      const efforts = configChoices(options, 'effort').map(choice => choice.id);
      agents.push({
        id: agent.id,
        name: agent.name,
        proxy: agent.proxy,
        ready: status.ready,
        defaults: {
          model: agent.defaults.model || null,
          thinking: agent.defaults.thinking || null,
          mode: agent.defaults.mode || null,
        },
        models: configChoices(options, 'model').map(choice => ({
          ...choice,
          is_default: choice.id === agent.defaults.model,
          supported_thinking: efforts,
        })),
        modes: configChoices(options, 'approval_mode').map(choice => ({
          ...choice,
          is_default: choice.id === agent.defaults.mode,
        })),
        config_kind: usesNativeExecutorConfig(agent.proxy) ? 'executor-native' : 'gian',
        session_config: options.filter(option => option.binding === 'session'),
        turn_config: options.filter(option => option.binding === 'turn'),
      });
    }
    return { workspaces, agents };
  }

  private taskList(params: GianToolMethodParams['task.list']): GianToolMethodData['task.list'] {
    const statuses = new Set(params.statuses ?? ['open', 'done', 'archived']);
    const tasks = this.deps.tasks.listTasks().filter(task => statuses.has(task.status));
    return {
      tasks: tasks.map(task => params.include_sessions
        ? { ...task, sessions: this.sessionsForTask(task.id) }
        : task),
    };
  }

  private taskGet(params: GianToolMethodParams['task.get']): GianToolMethodData['task.get'] {
    const task = this.deps.tasks.getTask(params.task_id);
    if (!task) fail('NOT_FOUND', `task not found: ${params.task_id}`);
    return { task, sessions: this.sessionsForTask(task.id) };
  }

  private taskCreate(
    params: GianToolMethodParams['task.create'],
    request: ToolRequestRow,
  ): GianToolMethodData['task.create'] {
    const recovered = request.domainId ? this.deps.tasks.getTask(request.domainId) : undefined;
    if (recovered) return { task: recovered };
    const task = this.deps.tasks.createTask(params, request.domainId ?? undefined);
    this.deps.broadcaster.broadcast({ type: 'task:created', task });
    return { task };
  }

  private taskUpdate(params: GianToolMethodParams['task.update']): GianToolMethodData['task.update'] {
    const patch = {
      ...(params.name !== undefined ? { name: params.name } : {}),
      ...(params.description !== undefined ? { description: params.description } : {}),
      ...(params.status !== undefined ? { status: params.status } : {}),
    };
    let task = Object.keys(patch).length > 0
      ? this.deps.tasks.updateTask(params.task_id, patch)
      : this.deps.tasks.getTask(params.task_id);
    if (!task) fail('NOT_FOUND', `task not found: ${params.task_id}`);
    if (params.pinned !== undefined) task = this.deps.tasks.setTaskPinned(params.task_id, params.pinned);
    this.deps.broadcaster.broadcast({ type: 'task:updated', task });
    if (params.status !== undefined) this.deps.sessions.notifyTaskSessionsUpdated(params.task_id);
    return { task, sessions: this.sessionsForTask(task.id) };
  }

  private sessionList(params: GianToolMethodParams['session.list']): GianToolMethodData['session.list'] {
    const sessions = this.deps.sessions.listSessions({
      includeArchived: params.archived === 'all',
      archivedOnly: params.archived === 'archived',
    }).filter(session => (
      (params.task_id === undefined || session.task_id === params.task_id)
      && (params.workspace_id === undefined || session.workspace_id === params.workspace_id)
      && (params.agent_id === undefined || (session.agent_id ?? null) === params.agent_id)
      && (params.proxy === undefined || session.executor === params.proxy)
      && (params.status === undefined || params.status.includes(session.status))
    )).slice(0, params.limit ?? 50);
    return { sessions };
  }

  private sessionGet(params: GianToolMethodParams['session.get']): GianToolMethodData['session.get'] {
    const latest = this.ledger.latestDelivery(params.session_id);
    const delivery = latest ? this.reconcileDelivery(latest) : null;
    const session = this.deps.sessions.getSession(params.session_id);
    return {
      session,
      resolved_config: resolvedConfig(session),
      active_turn: this.deps.sessions.getActiveTurn(session.id),
      queue: this.deps.sessions.getQueue(session.id),
      interactions: this.pendingInteractions(session.id),
      latest_delivery: this.deliveryProjection(delivery),
    };
  }

  private sessionRead(params: GianToolMethodParams['session.read']): GianToolMethodData['session.read'] {
    this.deps.sessions.getSession(params.session_id);
    const page = this.deps.sessions.listEventPage(
      params.session_id,
      params.before_turn ?? null,
      params.turns ?? 3,
    );
    if ((params.view ?? 'messages') === 'events') {
      return { turns: this.turnRows(params.session_id, page.events.map(event => event.turn)), events: page.events, next_cursor: page.nextCursor, has_more: page.hasMore };
    }
    const messages = projectMessages(page.events);
    const interactions = projectTurnInteractions(page.events);
    return {
      turns: this.turnRows(params.session_id, page.events.map(event => event.turn)).map(turn => ({
        ...turn,
        config_snapshot: parseConfig(turn.config_json),
        messages: messages.get(turn.turn_number) ?? [],
        interactions: interactions.get(turn.turn_number) ?? [],
      })),
      next_cursor: page.nextCursor,
      has_more: page.hasMore,
    };
  }

  private async sessionCreate(
    params: GianToolMethodParams['session.create'],
    request: ToolRequestRow,
    actor?: GianToolActor,
  ): Promise<GianToolMethodData['session.create']> {
    const recovered = request.domainId ? this.findSession(request.domainId) : null;
    if (recovered) {
      const agent = await this.agentForSession(recovered);
      if (!agent) fail('AGENT_DELETED', `Agent was deleted: ${recovered.agent_name ?? recovered.agent_id ?? 'unknown'}`);
      return {
        session: recovered,
        agent: this.agentSnapshot(agent),
        resolved_config: resolvedConfig(recovered),
      };
    }
    const agent = await this.readyAgent(params.agent_id);
    const config = params.config;
    if (config) this.validateToolConfig(agent.proxy, config, await this.agentOptions(agent));
    const defaults = agent.defaults;
    const approvalMode = config?.approval_mode === null
      ? isApprovalMode(defaults.mode) ? defaults.mode : undefined
      : config?.approval_mode;
    const session = await this.deps.sessions.createSession({
      id: request.domainId ?? undefined,
      workspace_id: params.workspace_id,
      agent_id: agent.id,
      type: params.task_id ? 'subtask' : 'coding',
      task_id: params.task_id ?? null,
      ...(actor ? {
        created_by_actor_kind: actor.kind,
        created_by_actor_id: actor.kind === 'internal_session' ? actor.sessionId : actor.clientId,
        created_by_session_id: actor.kind === 'internal_session' ? actor.sessionId : null,
      } : {}),
      ...(params.name !== undefined ? { name: params.name } : {}),
      ...(config?.model !== undefined && config.model !== null ? { model: config.model } : {}),
      ...(config?.thinking_effort !== undefined && config.thinking_effort !== null
        ? { thinking_effort: config.thinking_effort } : {}),
      ...(approvalMode !== undefined ? { approval_mode: approvalMode } : {}),
      ...(config?.service_tier !== undefined ? { service_tier: config.service_tier } : {}),
      ...(config?.session ? { session_config: config.session } : {}),
      ...(config?.turn ? { turn_config: config.turn } : {}),
    });
    this.deps.broadcaster.broadcast({ type: 'session:created', session, origin: 'tool-create' });
    return {
      session,
      agent: this.agentSnapshot(agent),
      resolved_config: resolvedConfig(session),
    };
  }

  private async sessionUpdate(
    params: GianToolMethodParams['session.update'],
  ): Promise<GianToolMethodData['session.update']> {
    const before = this.deps.sessions.getSession(params.session_id);
    const active = this.deps.sessions.getActiveTurn(params.session_id);
    const config = params.config;
    const agent = config ? await this.agentForSession(before) : null;
    const options = config ? await this.sessionOptions(before) : [];
    if (config?.session && Object.keys(config.session).length > 0 && active) {
      fail('SESSION_BUSY', 'Session-bound config can only change while idle');
    }
    this.validateToolConfig(before.executor, config, options);

    if (params.name !== undefined) this.deps.sessions.renameSession(params.session_id, params.name);
    if (config?.session && Object.keys(config.session).length > 0) {
      for (const [id, value] of Object.entries(config.session)) {
        await this.deps.sessions.setNativeConfig(params.session_id, id, value);
      }
    }
    if (config?.turn) {
      for (const [id, value] of Object.entries(config.turn)) {
        this.deps.sessions.setTurnConfigValue(params.session_id, id, value);
      }
    }
    if (config?.model !== undefined) {
      this.deps.sessions.setModel(params.session_id, config.model ?? agent?.defaults.model ?? '');
    }
    if (config?.thinking_effort !== undefined) {
      this.deps.sessions.setEffort(
        params.session_id,
        config.thinking_effort ?? agent?.defaults.thinking ?? null,
      );
    }
    if (config?.approval_mode !== undefined) {
      const fallback = agent?.defaults.mode;
      const mode = config.approval_mode ?? (isApprovalMode(fallback) ? fallback : 'ask');
      this.deps.sessions.setApprovalMode(params.session_id, mode);
    }
    if (config?.service_tier !== undefined) {
      this.deps.sessions.setServiceTier(params.session_id, config.service_tier);
    }
    const session = this.deps.sessions.getSession(params.session_id);
    const configChanged = config !== undefined && Object.keys(config).length > 0;
    return {
      session,
      effective_from: configChanged ? 'next_turn' : 'immediate',
      active_turn_unchanged: active !== null && configChanged,
      resolved_config: resolvedConfig(session),
    };
  }

  private sessionAssignTask(params: GianToolMethodParams['session.assign_task']): GianToolMethodData['session.assign_task'] {
    this.deps.sessions.assignTask(params.session_id, params.task_id);
    return { session: this.deps.sessions.getSession(params.session_id) };
  }

  private sessionSetSubtaskState(
    params: GianToolMethodParams['session.set_subtask_state'],
  ): GianToolMethodData['session.set_subtask_state'] {
    const before = this.deps.sessions.getSession(params.session_id);
    if (before.type !== 'subtask') fail('CONFLICT', `session is not a subtask: ${params.session_id}`);
    if (params.state === 'completed' && before.completed_at === null) {
      this.deps.sessions.completeSubtask(params.session_id);
    } else if (params.state === 'open' && before.completed_at !== null) {
      this.deps.sessions.reopenSubtask(params.session_id);
    }
    return { session: this.deps.sessions.getSession(params.session_id) };
  }

  private async sessionArchive(
    params: GianToolMethodParams['session.archive'],
  ): Promise<GianToolMethodData['session.archive']> {
    const before = this.deps.sessions.getSession(params.session_id);
    if ((before.archived === 1) !== params.archived) {
      await this.deps.sessions.archiveSession(params.session_id, params.archived);
    }
    return { session: this.deps.sessions.getSession(params.session_id) };
  }

  private async sessionSend(
    params: GianToolMethodParams['session.send'],
    request: ToolRequestRow,
  ): Promise<GianToolMethodData['session.send']> {
    this.deps.sessions.getSession(params.session_id);
    let delivery = this.ledger.createDelivery(request, params.session_id);
    const reconciled = this.reconcileDelivery(delivery);
    if (reconciled.state !== 'pending') return this.deliveryProjection(reconciled)!;
    try {
      const active = this.deps.sessions.getActiveTurn(params.session_id);
      if (active) {
        if ((params.busy ?? 'queue') === 'fail') fail('SESSION_BUSY', 'Session already has an active Turn');
        if (params.busy === 'steer') {
          await this.deps.sessions.steerMessage(params.session_id, params.text);
          delivery = this.ledger.updateDelivery(delivery.id, { state: 'steered', turnId: active.id });
          return this.deliveryProjection(delivery)!;
        }
        const entry = this.deps.sessions.enqueueMessage(params.session_id, params.text, undefined, request.id);
        delivery = this.ledger.updateDelivery(delivery.id, { state: 'queued', queueEntryId: entry.id });
        return this.deliveryProjection(delivery)!;
      }
      const receipt = await this.deps.sessions.sendMessage(params.session_id, params.text, undefined, undefined, request.id);
      if (!receipt) fail('NOT_FOUND', `session not found: ${params.session_id}`);
      delivery = this.ledger.updateDelivery(delivery.id, { state: 'started', turnId: receipt.turnId, queueEntryId: null });
      return { ...this.deliveryProjection(delivery)!, turn_number: receipt.turnNumber, config_snapshot: receipt.configSnapshot as never };
    } catch (error) {
      this.ledger.removeDelivery(delivery.id);
      throw error;
    }
  }

  private async worktreeCreateAndBind(
    params: GianToolMethodParams['worktree.create_and_bind'],
    actor: GianToolActor | undefined,
  ): Promise<GianToolMethodData['worktree.create_and_bind']> {
    if (!actor || actor.kind !== 'internal_session') {
      fail('PERMISSION_DENIED', 'worktree.create_and_bind requires an internal Gian Session');
    }
    return createAndBindWorktree({ db: this.deps.db, sessions: this.deps.sessions }, actor, params);
  }

  private cancelDelivery(
    params: GianToolMethodParams['session.cancel_delivery'],
    callerId: string,
    request: ToolRequestRow,
    actorAuthorized = false,
  ): GianToolMethodData['session.cancel_delivery'] {
    const delivery = this.ledger.delivery(params.delivery_id);
    if (!delivery) fail('NOT_FOUND', `delivery not found: ${params.delivery_id}`);
    if (!actorAuthorized && delivery.callerId !== callerId) {
      fail('DELIVERY_NOT_CANCELABLE', 'Only the creating caller can cancel this delivery');
    }
    const current = this.reconcileDelivery(delivery);
    if (request.recovered && current.state === 'cancelled') return this.deliveryProjection(current)!;
    if (current.state !== 'queued' || !current.queueEntryId) {
      fail('DELIVERY_NOT_CANCELABLE', `Delivery is ${current.state}, not queued`);
    }
    if (!this.deps.sessions.getQueue(current.sessionId).some(entry => entry.id === current.queueEntryId)) {
      fail('DELIVERY_NOT_CANCELABLE', 'Delivery has already left the queue');
    }
    this.deps.sessions.removeFromQueue(current.sessionId, current.queueEntryId);
    return this.deliveryProjection(this.ledger.updateDelivery(current.id, {
      state: 'cancelled', queueEntryId: null,
    }))!;
  }

  private async sessionWait(params: GianToolMethodParams['session.wait']): Promise<GianToolMethodData['session.wait']> {
    this.deps.sessions.getSession(params.session_id);
    const until = new Set(params.until ?? ['interaction', 'turn_terminal']);
    const delivery = params.delivery_id ? this.ledger.delivery(params.delivery_id) : null;
    if (params.delivery_id && !delivery) fail('NOT_FOUND', `delivery not found: ${params.delivery_id}`);
    if (delivery && delivery.sessionId !== params.session_id) fail('INVALID_ARGUMENT', 'delivery does not belong to session');
    const capturedTurnId = delivery?.turnId ?? this.deps.sessions.getActiveTurn(params.session_id)?.id ?? null;
    if (!delivery && !capturedTurnId) return { outcome: 'idle' };
    const deadline = Date.now() + (params.timeout_ms ?? 30_000);
    for (;;) {
      if (until.has('interaction')) {
        const interactions = this.pendingInteractions(params.session_id);
        if (interactions.length > 0) {
          return { outcome: 'needs_interaction', ...(delivery ? { delivery_id: delivery.id } : {}), interactions };
        }
      }
      const current = delivery ? this.reconcileDelivery(this.ledger.delivery(delivery.id) ?? delivery) : null;
      if (current?.state === 'queued') return { outcome: 'queued', delivery_id: current.id };
      const turnId = current?.turnId ?? capturedTurnId;
      if (until.has('turn_terminal') && turnId) {
        const turn = this.turnById(turnId);
        if (turn && TERMINAL_STATES.has(turn.status)) {
          const read = this.sessionRead({ session_id: params.session_id, before_turn: turn.turn_number + 1, turns: 1, view: 'messages' });
          return {
            outcome: turn.status,
            ...(current ? { delivery_id: current.id } : {}),
            turn: (read.turns as unknown[])[0],
            messages: ((read.turns as Array<{ messages?: unknown[] }>)[0]?.messages ?? []),
          };
        }
      }
      if (Date.now() >= deadline || this.closing) {
        return { outcome: 'timeout', ...(delivery ? { delivery_id: delivery.id } : {}) };
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(25, deadline - Date.now())));
    }
  }

  private async sessionStop(params: GianToolMethodParams['session.stop']): Promise<GianToolMethodData['session.stop']> {
    this.deps.sessions.getSession(params.session_id);
    const alreadyIdle = this.deps.sessions.getActiveTurn(params.session_id) === null;
    if (!alreadyIdle) await this.deps.sessions.stopTurn(params.session_id);
    return { already_idle: alreadyIdle };
  }

  private interactionList(params: GianToolMethodParams['interaction.list']): GianToolMethodData['interaction.list'] {
    if (params.session_id) this.deps.sessions.getSession(params.session_id);
    return { interactions: this.pendingInteractions(params.session_id) };
  }

  private async interactionRespond(
    params: GianToolMethodParams['interaction.respond'],
    request: ToolRequestRow,
  ): Promise<GianToolMethodData['interaction.respond']> {
    this.deps.sessions.getSession(params.session_id);
    const persisted = this.deps.db.prepare(
      'SELECT 1 FROM proxy_interactions WHERE session_id = ? AND interaction_id = ?',
    ).get(params.session_id, params.interaction_id);
    if (persisted && !request.recovered) {
      fail('INTERACTION_ALREADY_RESOLVED', `interaction already has a response: ${params.interaction_id}`);
    }
    const record = this.deps.approvals.getPending(params.interaction_id);
    if (!record && persisted && request.recovered) {
      // The Host may have stopped after persisting the response identity but
      // before recording the Tool result. Re-submit the same response id;
      // gian.proxy/2 requires response-id idempotency.
      await this.deps.sessions.respondApproval(
        params.session_id,
        params.interaction_id,
        params.decision ?? 'allow_once',
        params.answers,
        params.native_option_id,
        'tool',
      );
      return { interaction_id: params.interaction_id, resolved: true };
    }
    if (!record) fail('INTERACTION_ALREADY_RESOLVED', `interaction is not pending: ${params.interaction_id}`);
    if (record.sessionId !== params.session_id) fail('INVALID_ARGUMENT', 'interaction does not belong to session');
    validateInteractionAnswers(record, params.answers);
    let decision = params.decision as ApprovalDecision | undefined;
    if ((record.nativeOptions?.length ?? 0) > 0) {
      if (decision !== undefined) {
        fail('INVALID_INTERACTION_RESPONSE', 'Use native_option_id without a generic decision');
      }
      if (!params.native_option_id || !record.nativeOptions!.some(option => option.optionId === params.native_option_id)) {
        fail('INVALID_INTERACTION_RESPONSE', 'Use one of the interaction native option ids');
      }
      decision ??= 'allow_once';
    } else if (record.category === 'question') {
      if (decision !== undefined) {
        fail('INVALID_INTERACTION_RESPONSE', 'Questions are answered with answers, not a decision');
      }
      decision ??= 'allow_once';
    } else if (!decision) {
      fail('INVALID_INTERACTION_RESPONSE', 'decision is required');
    } else if (!projectInteraction(record).allowed_decisions.includes(decision)) {
      fail('INVALID_INTERACTION_RESPONSE', 'Use one of the interaction allowed_decisions');
    }
    await this.deps.sessions.respondApproval(
      params.session_id,
      params.interaction_id,
      decision,
      params.answers,
      params.native_option_id,
      'tool',
    );
    return { interaction_id: params.interaction_id, resolved: true };
  }

  private pendingInteractions(sessionId?: string): GianToolInteraction[] {
    return this.deps.approvals.listPending()
      .filter(record => sessionId === undefined || record.sessionId === sessionId)
      .map(projectInteraction);
  }

  private sessionsForTask(taskId: string): Session[] {
    return this.deps.sessions.listSessions({ includeArchived: true }).filter(session => session.task_id === taskId);
  }

  private findSession(id: string): Session | null {
    try { return this.deps.sessions.getSession(id); } catch { return null; }
  }

  private async readyAgent(agentId: string): Promise<UserAgent> {
    if (!this.deps.agents) fail('AGENT_NOT_READY', 'Agent catalog is unavailable');
    let agent: UserAgent;
    try { agent = this.deps.agents.getAgent(agentId); } catch { fail('NOT_FOUND', `agent not found: ${agentId}`); }
    const status = await this.deps.agents.agentStatus(agentId);
    if (!status.ready) fail('AGENT_NOT_READY', `Agent is not ready: ${agent.name}`);
    return agent;
  }

  private agentSnapshot(agent: UserAgent): GianToolMethodData['session.create']['agent'] {
    return {
      id: agent.id,
      name: agent.name,
      proxy: agent.proxy,
      defaults: { ...agent.defaults },
    };
  }

  private async agentOptions(agent: UserAgent): Promise<ConfigOption[]> {
    if (!this.deps.agents) fail('AGENT_NOT_READY', 'Agent catalog is unavailable');
    const path = this.deps.agents.agentRuntimePath(agent.id).cliPath;
    const cached = this.deps.sessions.getCapabilities(agent.proxy, path);
    return (cached ?? await this.deps.sessions.warmCapabilities(agent.proxy, path)).configOptions;
  }

  private validateToolConfig(
    executor: Session['executor'],
    config: GianToolMethodParams['session.create']['config'],
    options: ConfigOption[],
  ): void {
    if (!config) return;
    if (usesNativeExecutorConfig(executor)) {
      const standard = [
        ['model', config.model],
        ['thinking_effort', config.thinking_effort],
        ['approval_mode', config.approval_mode],
        ['service_tier', config.service_tier],
      ].find(([, value]) => value !== undefined);
      if (standard) {
        fail('INVALID_ARGUMENT', `${executor} uses Executor-native config; use config.session/config.turn instead of ${standard[0]}`);
      }
    } else {
      const standard: Array<[string, unknown, string]> = [
        ['model', config.model, 'model'],
        ['thinking_effort', config.thinking_effort, 'effort'],
        ['approval_mode', config.approval_mode, 'approval_mode'],
      ];
      for (const [field, value, role] of standard) {
        if (value === undefined || value === null) continue;
        const option = configOptionsByRole(options, role);
        if (!option) fail('CAPABILITY_NOT_SUPPORTED', `${field} is not advertised by ${executor}`);
        try { validateConfigValue(option, value); } catch (error) {
          fail('INVALID_ARGUMENT', error instanceof Error ? error.message : `Invalid ${field}`);
        }
      }
      if (config.service_tier !== undefined && executor !== 'codex') {
        fail('INVALID_ARGUMENT', 'service_tier is codex-only');
      }
    }
    for (const [binding, values] of [
      ['session', config.session],
      ['turn', config.turn],
    ] as const) {
      for (const [id, value] of Object.entries(values ?? {})) {
        const option = options.find(entry => entry.binding === binding && entry.id === id);
        if (!option) fail('INVALID_ARGUMENT', `Unknown ${binding} config option: ${id}`);
        try { validateConfigValue(option, value); } catch (error) {
          fail('INVALID_ARGUMENT', error instanceof Error ? error.message : `Invalid config option: ${id}`);
        }
      }
    }
  }

  private async agentForSession(session: Session): Promise<UserAgent | null> {
    if (!session.agent_id || !this.deps.agents) return null;
    try { return this.deps.agents.getAgent(session.agent_id); } catch { fail('AGENT_DELETED', `Agent was deleted: ${session.agent_name ?? session.agent_id}`); }
  }

  private async sessionOptions(session: Session): Promise<ConfigOption[]> {
    const path = session.agent_id && this.deps.agents
      ? this.deps.agents.agentRuntimePath(session.agent_id).cliPath
      : undefined;
    const catalog = this.deps.sessions.getCapabilities(session.executor, path)
      ?? await this.deps.sessions.warmCapabilities(session.executor, path);
    const byId = new Map(catalog.configOptions.map(option => [option.id, option]));
    for (const option of session.turn_config_options ?? []) byId.set(option.id, option);
    return [...byId.values()];
  }

  private turnRows(sessionId: string, numbers: number[]): TurnRow[] {
    const unique = [...new Set(numbers)];
    if (unique.length === 0) return [];
    const placeholders = unique.map(() => '?').join(',');
    return (this.deps.db.prepare(
      `SELECT id, session_id, turn_number, status, config_json, created_at, completed_at
         FROM turns WHERE session_id = ? AND turn_number IN (${placeholders})
         ORDER BY turn_number`,
    ).all(sessionId, ...unique) as TurnRow[]);
  }

  private turnById(id: string): TurnRow | null {
    return this.deps.db.prepare(
      `SELECT id, session_id, turn_number, status, config_json, created_at, completed_at
         FROM turns WHERE id = ?`,
    ).get(id) as TurnRow | undefined ?? null;
  }

  private reconcileDelivery(delivery: ToolDeliveryRow): ToolDeliveryRow {
    if (delivery.state === 'pending' || delivery.state === 'queued') {
      const queued = this.deps.sessions.getQueue(delivery.sessionId)
        .find(entry => entry.toolRequestId === delivery.requestId);
      if (queued) {
        if (queued.id !== delivery.queueEntryId || delivery.state !== 'queued') {
          return this.ledger.updateDelivery(delivery.id, { queueEntryId: queued.id, state: 'queued' });
        }
        return delivery;
      }
    }
    let turn = delivery.turnId ? this.turnById(delivery.turnId) : this.deps.db.prepare(
      `SELECT id, session_id, turn_number, status, config_json, created_at, completed_at
         FROM turns WHERE tool_request_id = ?`,
    ).get(delivery.requestId) as TurnRow | undefined;
    if (turn?.status === 'running' && this.deps.sessions.getActiveTurn(delivery.sessionId) === null) {
      this.deps.sessions.settleLostRuntimeTurn(delivery.sessionId, turn.id);
      turn = this.turnById(turn.id) ?? undefined;
    }
    if (turn) {
      const state = TERMINAL_STATES.has(turn.status)
        ? turn.status as 'completed' | 'error' | 'stopped'
        : delivery.state === 'steered' ? 'steered' : 'started';
      if (delivery.turnId !== turn.id || delivery.state !== state || delivery.queueEntryId !== null) {
        return this.ledger.updateDelivery(delivery.id, { turnId: turn.id, queueEntryId: null, state });
      }
    }
    return delivery;
  }

  private deliveryProjection(delivery: ToolDeliveryRow | null): GianToolDelivery | null {
    if (!delivery) return null;
    const turn = delivery.turnId ? this.turnById(delivery.turnId) : null;
    return {
      delivery_id: delivery.id,
      state: delivery.state === 'pending' ? 'queued' : delivery.state,
      session_id: delivery.sessionId,
      ...(delivery.turnId ? { turn_id: delivery.turnId } : {}),
      ...(turn ? { turn_number: turn.turn_number } : {}),
      ...(delivery.queueEntryId ? { queue_id: delivery.queueEntryId } : {}),
      ...(turn?.config_json ? { config_snapshot: parseConfig(turn.config_json) as never } : {}),
    };
  }
}
