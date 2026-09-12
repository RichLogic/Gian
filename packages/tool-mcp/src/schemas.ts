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
    openWorldHint: boolean;
  };
}

const id = (description: string): Record<string, unknown> => ({
  type: 'string',
  minLength: 1,
  description,
});
const pluginId = (description: string): Record<string, unknown> => ({
  type: 'string',
  minLength: 1,
  maxLength: 128,
  pattern: '^(?:claude|codex|kimi|grok|[a-z0-9]+(?:[.-][a-z0-9]+)+)$',
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
const triggerParam: Record<string, unknown> = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'at'],
      properties: {
        kind: { const: 'once' },
        at: { type: 'string', description: 'RFC 3339 instant with Z or explicit offset.' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'expression'],
      properties: {
        kind: { const: 'cron' },
        expression: { type: 'string', description: 'Standard 5-field cron: minute hour day-of-month month day-of-week.' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'every_ms', 'anchor_at'],
      properties: {
        kind: { const: 'interval' },
        every_ms: { type: 'integer', minimum: 300000, maximum: 31536000000, description: 'Interval in ms (>= 5 minutes).' },
        anchor_at: { type: 'string', description: 'RFC 3339 instant anchoring the interval grid.' },
      },
    },
  ],
  description: 'Trigger definition: once {at} | cron {expression} | interval {every_ms, anchor_at}. Minimum pace is 5 minutes.',
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
  openWorldHint = false,
): GianMcpToolDefinition {
  return {
    name,
    description,
    inputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint,
    },
  };
}

function write(
  name: GianToolMethod,
  description: string,
  inputSchema: GianMcpInputSchema,
  destructiveHint = false,
  openWorldHint = false,
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
      openWorldHint,
    },
  };
}

function action(
  name: GianToolMethod,
  description: string,
  inputSchema: GianMcpInputSchema,
  openWorldHint = false,
): GianMcpToolDefinition {
  return {
    name,
    description,
    inputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint,
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
    proxy: pluginId('Underlying Proxy pluginId filter.'),
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
    expected_session_revision: id('Optional Session revision for compare-and-write.'),
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
    items: {
      type: 'array',
      description: 'Optional structured input items. Host ownership checks still apply.',
    },
    context_items: {
      type: 'array',
      description: 'Optional message context items.',
    },
    composer_document: {
      type: 'object',
      description: 'Optional composer document compiled with the message text.',
    },
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
    input({
      session_id: id('Session ID.'),
      expected_session_revision: id('Optional Session revision for compare-and-write.'),
    }, ['session_id']), true),
  write('queue.update', 'Edit one queued message text without changing attachments or position.', input({
    session_id: id('Session ID.'),
    queue_id: id('Queue entry ID.'),
    text: id('Replacement text.'),
    expected_queue_revision: id('Optional Queue revision for compare-and-write.'),
  }, ['session_id', 'queue_id', 'text'])),
  write('queue.remove', 'Remove one Queue entry and cancel its Tool delivery if present.', input({
    session_id: id('Session ID.'),
    queue_id: id('Queue entry ID.'),
    expected_queue_revision: id('Optional Queue revision for compare-and-write.'),
  }, ['session_id', 'queue_id'])),
  write('queue.clear', 'Clear the Session Queue and cancel Tool-created queued deliveries.',
    input({
      session_id: id('Session ID.'),
      expected_queue_revision: id('Optional Queue revision for compare-and-write.'),
    }, ['session_id']), true),
  write('queue.send_now', 'Start the Queue head or steer the whole Queue into the active Turn.',
    input({
      session_id: id('Session ID.'),
      expected_queue_revision: id('Optional Queue revision for compare-and-write.'),
    }, ['session_id']), true),
  write(
    'worktree.create_and_bind',
    'Create a managed Git worktree for this authenticated Gian Session and open it in Gian views.',
    input({
      branch: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'New local branch name for the managed worktree.',
      },
      base_ref: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'Optional Git base revision. Defaults to HEAD in the Workspace repository.',
      },
    }, ['branch']),
  ),
  read('browser.tabs', 'List the tabs in Gian Browser, including page generation, lifecycle, URL, title, and control state.', input({}), true),
  write('browser.open', 'Open a URL in Gian Browser. Omit tab_id to create a visible panel2 tab; provide tab_id to navigate an existing tab.', input({
    url: { type: 'string', minLength: 1, maxLength: 8192, description: 'HTTP(S), gian-browser, or allowed about URL.' },
    tab_id: id('Existing Browser tab ID. Omit to create a tab.'),
    activate: { type: 'boolean', description: 'Present a newly created tab in panel2. Defaults to true.' },
  }, ['url']), false, true),
  read('browser.snapshot', 'Read the page accessibility tree. Interactive nodes receive @e refs that can be used only with this snapshot_id and page generation.', input({
    tab_id: id('Browser tab ID.'),
    max_nodes: { type: 'integer', minimum: 20, maximum: 1000, description: 'Maximum AX nodes to inspect; defaults to 500.' },
  }, ['tab_id']), true),
  write('browser.click', 'Click an element from the latest Browser accessibility snapshot using its @e ref.', input({
    tab_id: id('Browser tab ID.'),
    snapshot_id: id('Snapshot ID returned by browser.snapshot.'),
    ref: id('Interactive element ref such as @e3.'),
  }, ['tab_id', 'snapshot_id', 'ref']), false, true),
  write('browser.fill', 'Replace the value of an editable element from a Browser accessibility snapshot and dispatch input/change events.', input({
    tab_id: id('Browser tab ID.'),
    snapshot_id: id('Snapshot ID returned by browser.snapshot.'),
    ref: id('Editable element ref such as @e3.'),
    text: { type: 'string', maxLength: 100000, description: 'Replacement text.' },
  }, ['tab_id', 'snapshot_id', 'ref', 'text']), false, true),
  write('browser.press', 'Press a keyboard key or chord in the page. Supply snapshot_id and ref together to focus a snapshot element first.', input({
    tab_id: id('Browser tab ID.'),
    key: { type: 'string', minLength: 1, maxLength: 100, description: 'Key or chord, for example Enter, Tab, Escape, or Control+A.' },
    snapshot_id: id('Optional snapshot ID used with ref.'),
    ref: id('Optional element ref to focus before pressing.'),
  }, ['tab_id', 'key']), false, true),
  read('browser.wait', 'Wait until the page stops loading or visible body text appears.', input({
    tab_id: id('Browser tab ID.'),
    condition: enumValue(['load', 'text'], 'Condition; defaults to load.'),
    text: id('Required text when condition is text.'),
    timeout_ms: { type: 'integer', minimum: 100, maximum: 30000, description: 'Wait limit; defaults to 10000 ms.' },
  }, ['tab_id']), true),
  action('browser.evaluate', 'Evaluate JavaScript in the page main world as a non-idempotent escape hatch for complex operations. Prefer snapshot/click/fill/press first. Result must be serializable and at most 256 KiB and is never written to the Gian Tool ledger.', input({
    tab_id: id('Browser tab ID.'),
    expression: { type: 'string', minLength: 1, maxLength: 100000, description: 'JavaScript expression, optionally returning a Promise.' },
  }, ['tab_id', 'expression']), true),
  read('browser.screenshot', 'Capture the current Browser viewport as a PNG image.', input({
    tab_id: id('Browser tab ID.'),
    max_width: { type: 'integer', minimum: 320, maximum: 2000, description: 'Maximum image width; defaults to 1600.' },
  }, ['tab_id']), true),
  write('browser.go_back', 'Navigate one step back in a Gian Browser tab.', input({
    tab_id: id('Browser tab ID.'),
  }, ['tab_id']), false, true),
  write('browser.reload', 'Reload a Gian Browser tab and invalidate prior element refs.', input({
    tab_id: id('Browser tab ID.'),
    ignore_cache: { type: 'boolean', description: 'Reload without cached resources.' },
  }, ['tab_id']), false, true),
  write('browser.close', 'Close a Gian Browser tab.', input({
    tab_id: id('Browser tab ID.'),
  }, ['tab_id']), true, true),
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
    expected_interaction_revision: id('Optional Interaction revision for compare-and-write.'),
  }, ['session_id', 'interaction_id'], [
    { required: ['decision'] },
    { required: ['answers'] },
    { required: ['native_option_id'] },
  ])),
  read('schedule.preview', 'Preview future occurrences of a schedule trigger. Read-only.',
    input({
      trigger: triggerParam,
      timezone: id('IANA timezone name.'),
      after: id('RFC 3339 instant to preview after; defaults to now.'),
      limit: { type: 'integer', minimum: 3, maximum: 10, description: 'Occurrence count (3-10).' },
    }, ['trigger', 'timezone'])),
  write('schedule.create', 'Propose a schedule bound to this conversation. When the requested action and timing are known, call this tool to show the user a confirmation card. Results default to this conversation; destination and formatting are not required clarifications. Blocks until the user approves or rejects it in Gian; creation is host-enforced confirmation, never silent.', input({
    name: id('Schedule name.'),
    prompt: id('Durable prompt sent to the bound conversation on every occurrence.'),
    trigger: triggerParam,
    timezone: id('IANA timezone name.'),
    misfire_policy: enumValue(['skip', 'run_once'], 'Behavior for occurrences missed while the Host was down.'),
    confirmation_timeout_ms: {
      type: 'integer',
      minimum: 5000,
      maximum: 1800000,
      description: 'How long to wait for the user decision (5 minute default).',
    },
  }, ['name', 'prompt', 'trigger', 'timezone'])),
  read('schedule.list', 'List schedules bound to this conversation.', input({
    status: enumArray(['active', 'paused', 'completed', 'archived'], 'Schedule statuses to include.'),
    limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum rows.' },
    cursor: id('Opaque pagination cursor from a previous page.'),
  })),
  read('schedule.get', 'Get one schedule of this conversation with optional recent runs.', input({
    schedule_id: id('Schedule ID.'),
    include_runs: { type: 'boolean', description: 'Include the latest runs.' },
  }, ['schedule_id'])),
  write('schedule.update', 'Update a schedule of this conversation. Revision CAS required.', input({
    schedule_id: id('Schedule ID.'),
    expected_revision: { type: 'integer', minimum: 1, description: 'Current schedule revision.' },
    name: id('New name.'),
    prompt: id('New durable prompt.'),
    trigger: triggerParam,
    timezone: id('New IANA timezone.'),
    misfire_policy: enumValue(['skip', 'run_once'], 'New misfire policy.'),
  }, ['schedule_id', 'expected_revision'], [
    { required: ['name'] },
    { required: ['prompt'] },
    { required: ['trigger'] },
    { required: ['timezone'] },
    { required: ['misfire_policy'] },
  ])),
  write('schedule.pause', 'Pause a schedule of this conversation.', input({
    schedule_id: id('Schedule ID.'),
    expected_revision: { type: 'integer', minimum: 1, description: 'Optional revision CAS.' },
  }, ['schedule_id'])),
  write('schedule.resume', 'Resume a paused schedule of this conversation.', input({
    schedule_id: id('Schedule ID.'),
    expected_revision: { type: 'integer', minimum: 1, description: 'Optional revision CAS.' },
  }, ['schedule_id'])),
  write('schedule.run_now', 'Trigger one immediate run of a schedule of this conversation.', input({
    schedule_id: id('Schedule ID.'),
  }, ['schedule_id'])),
  write('schedule.archive', 'Irreversibly archive a schedule of this conversation.', input({
    schedule_id: id('Schedule ID.'),
    expected_revision: { type: 'integer', minimum: 1, description: 'Optional revision CAS.' },
  }, ['schedule_id']), true),
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
        description: 'Required for the write methods; omit for reads. Reuse only to retry the exact same call.',
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

/** Return a credential-scoped Tool catalog. The compatibility dispatcher is
 * retained for clients with delayed Tool discovery, but its method enum is
 * narrowed to the same grants instead of leaking or accepting hidden tools. */
export function gianMcpToolDefinitions(
  methods: readonly GianToolMethod[],
): GianMcpToolDefinition[] {
  const allowed = new Set(methods);
  const canonical = GIAN_MCP_TOOL_DEFINITIONS
    .slice(0, GIAN_TOOL_METHODS.length)
    .filter(tool => allowed.has(tool.name as GianToolMethod));
  const dispatcher = GIAN_MCP_TOOL_DEFINITIONS.at(-1);
  if (!dispatcher || dispatcher.name !== 'gian_call') return canonical;
  return [
    ...canonical,
    {
      ...dispatcher,
      inputSchema: {
        ...dispatcher.inputSchema,
        properties: {
          ...dispatcher.inputSchema.properties,
          method: {
            ...dispatcher.inputSchema.properties.method,
            enum: methods,
          },
        },
      },
    },
  ];
}
