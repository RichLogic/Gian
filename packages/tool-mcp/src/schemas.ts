import { GIAN_TOOL_METHODS, type GianToolMethod } from '@gian/shared';

export type GianMcpToolName = GianToolMethod | 'gian_call';

export interface GianMcpInputSchema {
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties: false;
  anyOf?: Array<{ required: string[] }>;
}

export interface GianMcpToolDefinition {
  name: GianMcpToolName;
  description: string;
  inputSchema: GianMcpInputSchema;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: false;
  };
}

const id = (description: string): Record<string, unknown> => ({
  type: 'string',
  minLength: 1,
  description,
});
const nullableString = (description: string): Record<string, unknown> => ({
  type: ['string', 'null'],
  description,
});
const enumValue = (values: string[], description: string): Record<string, unknown> => ({
  type: 'string',
  enum: values,
  description,
});
const enumArray = (values: string[], description: string): Record<string, unknown> => ({
  type: 'array',
  minItems: 1,
  items: { type: 'string', enum: values },
  description,
});
const scalarValues: Record<string, unknown> = {
  type: 'object',
  additionalProperties: { type: ['string', 'number', 'boolean', 'null'] },
};
const config: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    model: nullableString('Provider model ID; null restores the Agent default.'),
    thinking_effort: nullableString('Provider thinking/reasoning option; null restores the default.'),
    approval_mode: {
      anyOf: [
        { type: 'string', enum: ['plan', 'ask', 'auto', 'custom', 'full-access'] },
        { type: 'null' },
      ],
    },
    service_tier: {
      anyOf: [{ const: 'fast' }, { type: 'null' }],
      description: 'Use fast or null. Legacy flex is read-only.',
    },
    session: scalarValues,
    turn: scalarValues,
  },
};
const idempotency: Record<string, unknown> = {
  type: 'string',
  minLength: 1,
  maxLength: 256,
  description: 'Stable unique key for this intended write. Reuse it only to retry the exact same call.',
};

function input(
  properties: Record<string, Record<string, unknown>>,
  required: string[] = [],
  anyOf?: Array<{ required: string[] }>,
): GianMcpInputSchema {
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
    ...(anyOf ? { anyOf } : {}),
  };
}

function read(
  name: GianToolMethod,
  description: string,
  inputSchema: GianMcpInputSchema,
): GianMcpToolDefinition {
  return {
    name,
    description,
    inputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  };
}

function write(
  name: GianToolMethod,
  description: string,
  inputSchema: GianMcpInputSchema,
  destructiveHint = false,
): GianMcpToolDefinition {
  inputSchema.properties.idempotency_key = idempotency;
  inputSchema.required = [...(inputSchema.required ?? []), 'idempotency_key'];
  return {
    name,
    description,
    inputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint,
      idempotentHint: true,
      openWorldHint: false,
    },
  };
}

export const GIAN_MCP_TOOL_DEFINITIONS: GianMcpToolDefinition[] = [
  read('catalog.get_create_options', 'List Gian Workspaces and ready Agents, models, modes, and config options.',
    input({ refresh: { type: 'boolean', description: 'Refresh Provider catalogs before returning.' } })),
  read('task.list', 'List canonical Gian Tasks.', input({
    statuses: enumArray(['open', 'done', 'archived'], 'Task statuses to include.'),
    include_sessions: { type: 'boolean', description: 'Include Sessions attached to each Task.' },
  })),
  read('task.get', 'Get one canonical Task and its Sessions.', input({ task_id: id('Task ID.') }, ['task_id'])),
  write('task.create', 'Create one Gian Task.', input({
    name: id('Task name.'),
    description: nullableString('Optional Task description.'),
  }, ['name'])),
  write('task.update', 'Update one Gian Task. Supply at least one changed field.', input({
    task_id: id('Task ID.'),
    name: id('New Task name.'),
    description: nullableString('New description; null clears it.'),
    status: enumValue(['open', 'done', 'archived'], 'New Task lifecycle state.'),
    pinned: { type: 'boolean', description: 'Whether the Task is pinned.' },
  }, ['task_id'], [
    { required: ['name'] },
    { required: ['description'] },
    { required: ['status'] },
    { required: ['pinned'] },
  ])),
  read('session.list', 'List canonical Gian Sessions with optional filters.', input({
    task_id: nullableString('Task ID filter; null selects unassigned Sessions.'),
    workspace_id: nullableString('Workspace ID filter.'),
    agent_id: nullableString('Agent ID filter.'),
    proxy: enumValue(['claude', 'codex', 'kimi', 'grok', 'dsh'], 'Underlying Proxy filter.'),
    status: enumArray(['new', 'running', 'pending', 'error', 'done'], 'Session statuses.'),
    archived: enumValue(['active', 'archived', 'all'], 'Archive filter.'),
    limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum rows.' },
  })),
  read('session.get', 'Get one Gian Session with resolved Agent/config state.',
    input({ session_id: id('Session ID.') }, ['session_id'])),
  read('session.read', 'Read recent Session messages or raw projected events.', input({
    session_id: id('Session ID.'),
    before_turn: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
    turns: { type: 'integer', minimum: 1, maximum: 10, description: 'Number of Turns.' },
    view: enumValue(['messages', 'events'], 'Projection to return.'),
  }, ['session_id'])),
  write('session.create', 'Create a Session from explicit Workspace and saved Agent IDs.', input({
    workspace_id: id('Workspace ID from catalog.get_create_options.'),
    task_id: id('Optional Task ID.'),
    agent_id: id('Saved Agent ID from catalog.get_create_options.'),
    name: id('Optional Session name.'),
    config,
  }, ['workspace_id', 'agent_id'])),
  write('session.update', 'Update Session metadata or config for its next Turn.', input({
    session_id: id('Session ID.'),
    name: id('New Session name.'),
    config,
  }, ['session_id'], [{ required: ['name'] }, { required: ['config'] }])),
  write('session.assign_task', 'Assign an existing Session to an open Task.', input({
    session_id: id('Session ID.'),
    task_id: id('Task ID.'),
  }, ['session_id', 'task_id'])),
  write('session.set_subtask_state', 'Mark a Task Session completed or reopen it.', input({
    session_id: id('Session ID.'),
    state: enumValue(['completed', 'open'], 'Desired Subtask state.'),
  }, ['session_id', 'state'])),
  write('session.archive', 'Explicitly archive or restore one Session.', input({
    session_id: id('Session ID.'),
    archived: { type: 'boolean', description: 'Desired archive flag.' },
  }, ['session_id', 'archived']), true),
  write('session.send', 'Deliver a user message to a Session. Busy Sessions queue by default.', input({
    session_id: id('Session ID.'),
    text: id('User message.'),
    busy: enumValue(['queue', 'fail', 'steer'], 'Behavior when a Turn is active.'),
  }, ['session_id', 'text'])),
  write('session.cancel_delivery', 'Cancel a queued delivery before its Turn starts.', input({
    delivery_id: id('Delivery ID returned by session.send.'),
  }, ['delivery_id']), true),
  read('session.wait', 'Wait for a Session interaction or terminal Turn/delivery state.', input({
    session_id: id('Session ID.'),
    delivery_id: id('Optional delivery ID to follow.'),
    until: enumArray(['interaction', 'turn_terminal'], 'Events that may end the wait.'),
    timeout_ms: { type: 'integer', minimum: 0, maximum: 45000, description: 'Wait limit in milliseconds.' },
  }, ['session_id'])),
  write('session.stop', 'Stop the active Turn; succeeds as a no-op when already idle.',
    input({ session_id: id('Session ID.') }, ['session_id']), true),
  read('interaction.list', 'List pending approvals, questions, and native choices.',
    input({ session_id: id('Optional Session ID filter.') })),
  write('interaction.respond', 'Resolve one pending interaction using only its advertised choices.', input({
    session_id: id('Session ID.'),
    interaction_id: id('Interaction ID.'),
    decision: enumValue([
      'allow_once',
      'allow_session',
      'decline',
      'accept_with_auto',
      'accept_with_ask',
      'keep_planning',
    ], 'Advertised standard decision.'),
    answers: {
      type: 'object',
      additionalProperties: {
        anyOf: [
          { type: 'string' },
          { type: 'boolean' },
          { type: 'array', items: { type: 'string' } },
        ],
      },
      description: 'Answers keyed by advertised question ID.',
    },
    native_option_id: id('Advertised native Provider option ID.'),
  }, ['session_id', 'interaction_id'], [
    { required: ['decision'] },
    { required: ['answers'] },
    { required: ['native_option_id'] },
  ])),
  {
    name: 'gian_call',
    description: 'Call any canonical Gian Tool method. Use this compatibility dispatcher when a method-specific MCP tool is deferred or not visible; it adds no domain behavior.',
    inputSchema: input({
      method: {
        type: 'string',
        enum: [...GIAN_TOOL_METHODS],
        description: 'Canonical Gian Tool method name.',
      },
      params: {
        type: 'object',
        additionalProperties: true,
        description: 'Exact params object for the selected canonical method. For kind=native_choice, pass one advertised native_options[].optionId as native_option_id and omit decision.',
      },
      idempotency_key: {
        ...idempotency,
        description: 'Required for the 11 write methods; omit for reads. Reuse only to retry the exact same call.',
      },
    }, ['method', 'params']),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];
