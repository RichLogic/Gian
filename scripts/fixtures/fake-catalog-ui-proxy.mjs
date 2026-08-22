import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const pluginId = process.env.GIAN_PLUGIN_ID ?? 'grok';
const plugins = {
  claude: { name: 'Claude Code Mock', version: '0.2.0', scope: 'session' },
  codex: { name: 'Codex Mock', version: '0.2.0', scope: 'shared' },
  kimi: { name: 'Kimi Code Mock', version: '0.2.0', scope: 'shared' },
  grok: { name: 'Grok Mock', version: '0.3.0', scope: 'session' },
};
const plugin = plugins[pluginId] ?? {
  name: `${pluginId} Mock`,
  version: '0.2.0',
  scope: 'session',
};

const dataDir = process.env.GIAN_PLUGIN_DATA_DIR ?? join(tmpdir(), `gian-mock-${process.pid}`);
mkdirSync(dataDir, { recursive: true });
const requestLog = join(dataDir, 'received.ndjson');
const sessions = new Map();
let catalogRevision = 1;
let processEventSequence = 0;
let streamSequence = 0;

const model = {
  id: 'model',
  displayName: 'Mock Model',
  binding: 'turn',
  role: 'model',
  control: 'select',
  required: true,
  defaultValue: 'mock-sonnet',
  choices: [
    { value: 'mock-sonnet', displayName: 'Mock Sonnet' },
    { value: 'mock-haiku', displayName: 'Mock Haiku' },
    { value: 'mock-vision', displayName: 'Mock Vision' },
  ],
};

const effort = {
  id: 'effort',
  displayName: 'Mock Effort',
  binding: 'turn',
  role: 'effort',
  control: 'select',
  required: false,
  defaultValue: 'medium',
  choices: [
    { value: 'low', displayName: 'Low' },
    { value: 'medium', displayName: 'Medium' },
    { value: 'high', displayName: 'High' },
  ],
};

const fast = {
  id: 'fast',
  displayName: 'Mock Fast',
  binding: 'turn',
  role: 'fast',
  control: 'boolean',
  required: false,
  defaultValue: false,
};

const approval = {
  id: 'permission_mode',
  displayName: 'Mock Approval',
  binding: 'turn',
  role: 'approval_mode',
  control: 'select',
  required: false,
  defaultValue: 'ask',
  choices: [
    { value: 'ask', displayName: 'Ask' },
    { value: 'default', displayName: 'Default' },
    { value: 'yolo', displayName: 'YOLO' },
  ],
};

const execution = {
  id: 'execution_mode',
  displayName: 'Mock Execution',
  binding: 'turn',
  role: 'execution_mode',
  control: 'select',
  required: false,
  defaultValue: 'agent',
  choices: [
    { value: 'agent', displayName: 'Mock Agent' },
    { value: 'plan', displayName: 'Mock Plan' },
    { value: 'broken', displayName: 'Broken resolve' },
  ],
};

const workspaceMode = {
  id: 'workspace_mode',
  displayName: 'Workspace Mock',
  binding: 'session',
  control: 'select',
  required: false,
  defaultValue: 'default',
  choices: [
    { value: 'default', displayName: 'Default workspace' },
    { value: 'strict', displayName: 'Strict workspace' },
  ],
};

const verbosity = {
  id: 'verbosity',
  displayName: 'Mock Verbosity',
  binding: 'turn',
  control: 'select',
  required: false,
  defaultValue: 'quiet',
  choices: [
    { value: 'quiet', displayName: 'Quiet' },
    { value: 'loud', displayName: 'Loud' },
  ],
};

const mockTrace = {
  id: 'mock_trace',
  displayName: 'Mock Trace',
  binding: 'turn',
  role: 'custom_trace',
  control: 'boolean',
  required: false,
  defaultValue: false,
  visibleWhen: [{ optionId: 'model', oneOf: ['mock-vision'] }],
};

function processCatalog() {
  return {
    catalogRevision: `ui-mock-${pluginId}-${catalogRevision}`,
    input: [
      { type: 'text' },
      { type: 'localFile' },
      { type: 'localImage' },
      { type: 'skill' },
    ],
    configOptions: [
      workspaceMode,
      model,
      effort,
      fast,
      approval,
      execution,
      verbosity,
      mockTrace,
    ],
    slashCommands: [{
      name: '/mock:review',
      description: 'Mock catalog slash command',
      source: 'builtin',
      argHints: [{ kind: 'free', placeholder: 'path' }],
    }],
  };
}

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function result(id, value) {
  write({ jsonrpc: '2.0', id, result: value });
}

function fail(id, domainCode, message, retryable = false) {
  write({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32000,
      message,
      data: { domainCode, retryable, details: {} },
    },
  });
}

function timestamp(sequence) {
  return new Date(Date.UTC(2026, 7, 18, 0, 0, sequence)).toISOString();
}

function sessionResult(session) {
  return {
    id: session.id,
    nativeSession: { id: session.nativeSessionId },
    streamId: session.streamId,
    state: session.state,
    sessionConfig: session.sessionConfig,
    lastError: session.lastError,
    turnConfigOptions: [model, effort, fast, approval, execution, verbosity, mockTrace],
    turnConfigRevision: `ui-mock-turn-${pluginId}-${catalogRevision}`,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function eventId(session, method) {
  return `evt-${session.streamId}-${session.sequence}-${method.replaceAll('.', '-')}`;
}

function emitSession(session, method, data) {
  session.sequence += 1;
  write({
    jsonrpc: '2.0',
    method,
    params: {
      eventId: eventId(session, method),
      streamId: session.streamId,
      sequence: session.sequence,
      sessionId: session.id,
      emittedAt: timestamp(session.sequence),
      data,
    },
  });
}

function emitTurn(session, method, data) {
  const turn = session.activeTurn;
  if (!turn) throw new Error(`Mock session ${session.id} has no active turn.`);
  session.sequence += 1;
  write({
    jsonrpc: '2.0',
    method,
    params: {
      eventId: eventId(session, method),
      streamId: session.streamId,
      sequence: session.sequence,
      sessionId: session.id,
      turnId: turn.turnId,
      sourceTurnId: turn.sourceTurnId,
      emittedAt: timestamp(session.sequence),
      data,
    },
  });
}

function emitProcess(method, data) {
  processEventSequence += 1;
  write({
    jsonrpc: '2.0',
    method,
    params: {
      eventId: `process-${processEventSequence}-${method.replaceAll('.', '-')}`,
      emittedAt: timestamp(processEventSequence),
      data,
    },
  });
}

function finishTurn(session, stopReason = 'completed') {
  emitTurn(session, 'turn.completed', { stopReason });
  session.activeTurn = null;
  session.state = 'idle';
  session.updatedAt = timestamp(session.sequence + 1);
  emitSession(session, 'session.updated', {
    state: 'idle',
    updatedAt: session.updatedAt,
  });
}

function failTurn(session, message = 'Mock turn failed') {
  emitTurn(session, 'turn.failed', {
    error: {
      domainCode: 'RUNTIME_ERROR',
      message,
      retryable: true,
      details: { source: 'mock' },
    },
  });
  session.activeTurn = null;
  session.state = 'error';
  session.lastError = message;
}

function emitText(session, contentId, text) {
  emitTurn(session, 'content.delta', {
    contentId,
    kind: 'text',
    format: 'markdown',
    delta: text,
  });
  emitTurn(session, 'content.completed', {
    contentId,
    kind: 'text',
    format: 'markdown',
    content: text,
  });
}

function emitActivity(session, activityId, type, title, presentationData, status = 'succeeded') {
  emitTurn(session, 'activity.updated', {
    activityId,
    kind: type,
    title,
    status,
    presentation: {
      type,
      data: presentationData,
    },
  });
}

function runGallery(session) {
  emitText(session, 'gallery-text', 'Mock **text** content');
  emitTurn(session, 'content.delta', {
    contentId: 'gallery-reasoning',
    kind: 'reasoning',
    delta: 'Mock reasoning',
  });
  emitTurn(session, 'content.completed', {
    contentId: 'gallery-reasoning',
    kind: 'reasoning',
    content: 'Mock reasoning',
  });
  emitTurn(session, 'content.completed', {
    contentId: 'gallery-status',
    kind: 'status',
    content: 'Mock status update',
  });
  emitActivity(session, 'command-1', 'command', 'Run mock tests', { command: 'pnpm mock:test' }, 'running');
  emitActivity(session, 'command-1', 'command', 'Run mock tests', { command: 'pnpm mock:test' });
  emitActivity(session, 'file-read-1', 'file', 'Read fixture', { path: 'README.md', operation: 'read' });
  emitActivity(session, 'file-write-1', 'file', 'Write fixture', { path: 'mock-output.txt', operation: 'write' });
  emitActivity(session, 'file-delete-1', 'file', 'Delete fixture', { path: 'old-output.txt', operation: 'delete' });
  emitActivity(session, 'search-1', 'search', 'Search docs', { query: 'gian.proxy/2.0' });
  emitActivity(session, 'agent-1', 'agent', 'Mock subagent', {
    agentId: 'mock-agent',
    state: 'completed',
    displayName: 'Mock Worker',
    output: 'done',
  });
  emitActivity(session, 'notice-1', 'notice', 'Mock notice', { message: 'Mock warning', code: 'MOCK_NOTICE' });
  emitActivity(session, 'tool-1', 'tool', 'Mock tool', { name: 'mock_tool', input: { value: 1 }, output: { ok: true } });
  emitActivity(session, 'custom-1', 'custom.widget', 'Unknown activity', { value: 'preserved' });
  emitTurn(session, 'plan.updated', {
    planId: 'plan-1',
    title: 'Mock plan',
    steps: [
      { id: 'step-1', text: 'Inspect', status: 'completed' },
      { id: 'step-2', text: 'Verify', status: 'in_progress' },
    ],
  });
  emitTurn(session, 'diff.updated', {
    diffId: 'diff-1',
    diff: '--- a/mock.txt\n+++ b/mock.txt\n@@ -1 +1 @@\n-old\n+new\n',
    truncated: false,
    files: [{ path: 'mock.txt', status: 'modified' }],
  });
  emitTurn(session, 'usage.updated', {
    context: { used: 1200, window: 8192 },
    conversation: {
      mode: 'delta',
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 140,
    },
  });
  finishTurn(session);
}

function runStepRequest(session) {
  const stepId = `${session.activeTurn.sourceTurnId}:0`;
  emitTurn(session, 'step.updated', {
    stepId,
    index: 0,
    status: 'running',
  });
  emitTurn(session, 'request.updated', {
    requestId: `${session.activeTurn.sourceTurnId}:request:initial`,
    reason: 'initial',
    stepId,
    model: {
      provider: 'mock',
      id: 'mock-sonnet',
      displayName: 'Mock Sonnet',
    },
    parameters: { effort: 'medium', temperature: 0.2 },
    systemPrompt: {
      text: 'You are the deterministic Gian Mock Proxy.',
      truncated: false,
    },
    tools: [{ name: 'mock_tool', description: 'Run one deterministic mock tool.' }],
    context: { window: 8192 },
    truncated: false,
  });
  emitTurn(session, 'content.delta', {
    contentId: 'step-request-text',
    kind: 'text',
    format: 'markdown',
    stepId,
    delta: 'Step-linked mock response',
  });
  emitTurn(session, 'content.completed', {
    contentId: 'step-request-text',
    kind: 'text',
    format: 'markdown',
    stepId,
    content: 'Step-linked mock response',
  });
  emitTurn(session, 'activity.updated', {
    activityId: 'step-request-tool',
    kind: 'tool',
    title: 'Run mock tool',
    status: 'running',
    stepId,
    presentation: { type: 'tool', data: { name: 'mock_tool' } },
  });
  emitTurn(session, 'activity.updated', {
    activityId: 'step-request-tool',
    kind: 'tool',
    title: 'Run mock tool',
    status: 'succeeded',
    stepId,
    presentation: { type: 'tool', data: { name: 'mock_tool' } },
  });
  emitTurn(session, 'usage.updated', {
    stepId,
    conversation: {
      mode: 'delta',
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
    },
  });
  emitTurn(session, 'step.updated', {
    stepId,
    index: 0,
    status: 'completed',
  });
  finishTurn(session);
}

function requestInteraction(session, definition) {
  session.interactionSequence += 1;
  const interactionId = `mock-interaction-${session.interactionSequence}`;
  session.state = 'waiting_interaction';
  session.pendingInteraction = {
    id: interactionId,
    turnId: session.activeTurn.turnId,
  };
  emitTurn(session, 'interaction.requested', {
    interactionId,
    ...definition,
  });
}

function runPermissionInteraction(session) {
  requestInteraction(session, {
    title: 'Allow file edit?',
    description: 'Mock Proxy wants to update src/mock.ts.',
    presentation: { kind: 'permission', tone: 'warning' },
    inputs: [],
    actions: [
      { id: 'allow-once', label: 'Allow once', style: 'primary' },
      { id: 'allow-session', label: 'Allow for this session', style: 'secondary' },
      { id: 'reject-permission', label: 'Deny', style: 'danger' },
    ],
    context: { subject: 'src/mock.ts', operation: 'write' },
  });
}

function runQuestionInteraction(session) {
  requestInteraction(session, {
    title: 'What should the mock change?',
    description: 'Give the Agent one concise instruction.',
    presentation: { kind: 'question', tone: 'neutral' },
    inputs: [{
      id: 'answer',
      type: 'multiline_text',
      label: 'Answer',
      required: true,
      placeholder: 'Describe the desired change',
    }],
    actions: [
      { id: 'submit-answer', label: 'Submit answer', style: 'primary' },
      { id: 'cancelled', label: 'Cancel', style: 'secondary' },
    ],
    context: { topic: 'implementation' },
  });
}

function runChoiceInteraction(session) {
  requestInteraction(session, {
    title: 'Choose a validation target',
    description: 'Select where the Mock Proxy should run validation.',
    presentation: { kind: 'choice', tone: 'info' },
    inputs: [{
      id: 'environment',
      type: 'single_select',
      label: 'Environment',
      required: true,
      choices: [
        { value: 'local', displayName: 'Local' },
        { value: 'ci', displayName: 'CI' },
        { value: 'packaged', displayName: 'Packaged app' },
      ],
    }],
    actions: [
      { id: 'submit-choice', label: 'Continue', style: 'primary' },
      { id: 'cancelled', label: 'Cancel', style: 'secondary' },
    ],
    context: { purpose: 'validation' },
  });
}

function runConfirmationInteraction(session) {
  requestInteraction(session, {
    title: 'Delete generated mock artifacts?',
    description: 'This removes only files created by the Mock Proxy.',
    presentation: { kind: 'confirmation', tone: 'danger' },
    inputs: [],
    actions: [
      { id: 'confirm', label: 'Delete artifacts', style: 'danger' },
      { id: 'cancelled', label: 'Keep artifacts', style: 'secondary' },
    ],
    context: { subject: 'output/mock-artifacts' },
  });
}

function runFormInteraction(session) {
  requestInteraction(session, {
    title: 'Mock form interaction',
    description: 'System-only coverage for every protocol input control.',
    presentation: { kind: 'form', tone: 'neutral' },
    inputs: [
      { id: 'reason', type: 'text', label: 'Reason', required: true },
      { id: 'details', type: 'multiline_text', label: 'Details', required: false },
      {
        id: 'choice',
        type: 'single_select',
        label: 'Choice',
        required: true,
        choices: [
          { value: 'alpha', displayName: 'Alpha' },
          { value: 'beta', displayName: 'Beta' },
        ],
      },
      {
        id: 'tags',
        type: 'multi_select',
        label: 'Tags',
        required: true,
        choices: [
          { value: 'one', displayName: 'One' },
          { value: 'two', displayName: 'Two' },
        ],
      },
      { id: 'confirmed', type: 'boolean', label: 'Confirmed', required: true },
    ],
    actions: [
      { id: 'mock-submit', label: 'Submit mock response', style: 'primary' },
      { id: 'mock-secondary', label: 'Secondary action', style: 'secondary' },
      { id: 'mock-cancel', label: 'Cancel mock response', style: 'danger' },
    ],
    context: { scenario: 'interaction-form' },
  });
}

function replayEvents(sessionId, replayStreamId) {
  const base = {
    sessionId,
    replayStreamId,
    sourceTurnId: 'native-turn-1',
  };
  return [
    { method: 'turn.started', eventId: 'replay-turn-started-1', sequence: 1, emittedAt: timestamp(1), data: {}, ...base },
    {
      method: 'input.recorded',
      eventId: 'replay-input-1',
      sequence: 2,
      emittedAt: timestamp(2),
      data: { input: [{ type: 'text', text: 'Historical mock question' }] },
      ...base,
    },
    {
      method: 'content.completed',
      eventId: 'replay-content-1',
      sequence: 3,
      emittedAt: timestamp(3),
      data: { contentId: 'history-text-1', kind: 'text', content: 'Historical mock answer' },
      ...base,
    },
    {
      method: 'turn.completed',
      eventId: 'replay-turn-completed-1',
      sequence: 4,
      emittedAt: timestamp(4),
      data: { stopReason: 'completed' },
      ...base,
    },
  ];
}

function scenarioName(request) {
  const text = (request.params?.input ?? [])
    .filter((item) => item?.type === 'text')
    .map((item) => item.text)
    .join('\n');
  return /\/mock(?:\s+|:)([a-z-]+)/i.exec(text)?.[1]?.toLowerCase() ?? 'echo';
}

function runScenario(session, name) {
  switch (name) {
    case 'gallery':
      runGallery(session);
      return;
    case 'step-request':
      runStepRequest(session);
      return;
    case 'interaction-permission':
      runPermissionInteraction(session);
      return;
    case 'interaction-question':
      runQuestionInteraction(session);
      return;
    case 'interaction-choice':
      runChoiceInteraction(session);
      return;
    case 'interaction-confirmation':
      runConfirmationInteraction(session);
      return;
    case 'interaction-form':
    case 'interaction':
      runFormInteraction(session);
      return;
    case 'running':
      emitTurn(session, 'content.completed', {
        contentId: 'running-status',
        kind: 'status',
        content: 'Mock turn is waiting for steer or stop',
      });
      return;
    case 'catalog-change':
      catalogRevision += 1;
      emitProcess('catalog.changed', {
        reason: 'Mock catalog revision changed',
        revision: `ui-mock-${pluginId}-${catalogRevision}`,
      });
      emitText(session, 'catalog-change-text', `Catalog revision ${catalogRevision}`);
      finishTurn(session);
      return;
    case 'history-change':
      session.replayRevision += 1;
      emitSession(session, 'history.changed', {
        reason: 'Mock history changed',
        revision: String(session.replayRevision),
      });
      emitText(session, 'history-change-text', 'History refresh requested');
      finishTurn(session);
      return;
    case 'runtime-error':
      emitSession(session, 'runtime.error', {
        domainCode: 'RUNTIME_UNAVAILABLE',
        message: 'Mock runtime unavailable',
        retryable: true,
        details: { scope: 'session' },
      });
      failTurn(session, 'Mock runtime unavailable');
      return;
    case 'fault': {
      const turn = session.activeTurn;
      write({
        jsonrpc: '2.0',
        method: 'content.completed',
        params: {
          eventId: `fault-gap-${session.id}`,
          streamId: session.streamId,
          sequence: session.sequence + 2,
          sessionId: session.id,
          turnId: turn.turnId,
          sourceTurnId: turn.sourceTurnId,
          emittedAt: timestamp(session.sequence + 2),
          data: { contentId: 'fault', kind: 'text', content: 'sequence gap' },
        },
      });
      return;
    }
    default:
      emitText(session, 'echo-text', `Mock Proxy received: ${name}`);
      finishTurn(session);
  }
}

function handleControl(command) {
  const session = command.sessionId
    ? sessions.get(command.sessionId)
    : [...sessions.values()][0];
  switch (command.action) {
    case 'catalog.changed':
      catalogRevision += 1;
      emitProcess('catalog.changed', {
        reason: command.reason ?? 'External mock catalog change',
        revision: `ui-mock-${pluginId}-${catalogRevision}`,
      });
      return { ok: true, catalogRevision };
    case 'runtime.error':
      if (command.scope === 'process') {
        emitProcess('runtime.error', {
          domainCode: 'RUNTIME_UNAVAILABLE',
          message: command.message ?? 'External process error',
          retryable: true,
          details: {},
        });
      } else if (session) {
        emitSession(session, 'runtime.error', {
          domainCode: 'RUNTIME_UNAVAILABLE',
          message: command.message ?? 'External session error',
          retryable: true,
          details: {},
        });
      }
      return { ok: true };
    case 'history.changed':
      if (!session) throw new Error('No attached session.');
      session.replayRevision += 1;
      emitSession(session, 'history.changed', {
        reason: command.reason ?? 'External mock history change',
        revision: String(session.replayRevision),
      });
      return { ok: true, replayRevision: session.replayRevision };
    case 'scenario':
      if (!session?.activeTurn) throw new Error('No active turn.');
      runScenario(session, command.name ?? 'gallery');
      return { ok: true };
    case 'exit':
      setImmediate(() => process.exit(Number(command.code ?? 0)));
      return { ok: true };
    default:
      throw new Error(`Unknown mock control action: ${String(command.action)}`);
  }
}

const controlFile = join(dataDir, 'mock-control.ndjson');
const responseFile = join(dataDir, 'mock-responses.ndjson');
writeFileSync(controlFile, '');
writeFileSync(responseFile, '');
writeFileSync(
  join(dataDir, 'mock-control.json'),
  `${JSON.stringify({ controlFile, responseFile, requestLog, pid: process.pid }, null, 2)}\n`,
);
let controlOffset = 0;
const controlTimer = setInterval(() => {
  let content;
  try {
    content = readFileSync(controlFile);
  } catch {
    return;
  }
  if (content.length <= controlOffset) return;
  const chunk = content.subarray(controlOffset).toString('utf8');
  controlOffset = content.length;
  for (const line of chunk.split('\n').filter(Boolean)) {
    let command;
    try {
      command = JSON.parse(line);
      const response = handleControl(command);
      appendFileSync(responseFile, `${JSON.stringify({ requestId: command.requestId, ...response })}\n`);
    } catch (error) {
      appendFileSync(responseFile, `${JSON.stringify({
        requestId: command?.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })}\n`);
    }
  }
}, 25);

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let request;
  try {
    request = JSON.parse(trimmed);
  } catch {
    continue;
  }
  appendFileSync(requestLog, `${JSON.stringify(request)}\n`);

  switch (request.method) {
    case 'initialize':
      result(request.id, {
        protocol: { name: 'gian.proxy', version: '2.0' },
        plugin: { id: pluginId, name: plugin.name, version: plugin.version },
        process: { scope: plugin.scope },
        capabilities: {
          'input.localFile': 1,
          'input.localImage': 1,
          'input.skill': 1,
          'catalog.resolve': 1,
          'session.rename': 1,
          'session.native.list': 1,
          'session.native.delete': 1,
          'session.replay': 1,
          'turn.steer': 1,
          interaction: 1,
          'event.reasoning': 1,
          'event.plan': 1,
          'event.diff': 1,
          'event.usage': 1,
          'event.step': 1,
          'event.request': 1,
        },
      });
      break;
    case 'catalog.list':
      result(request.id, processCatalog());
      break;
    case 'catalog.resolve': {
      const turnConfig = request.params?.turnConfig ?? {};
      if (turnConfig.execution_mode === 'broken') {
        fail(request.id, 'CONFIG_VALUE_INVALID', 'broken resolve is not a legal execution mode');
        break;
      }
      result(request.id, {
        ...processCatalog(),
        resolvedDefaults: {
          sessionConfig: {},
          turnConfig: turnConfig.model === 'mock-vision' && turnConfig.mock_trace === undefined
            ? { mock_trace: true }
            : {},
        },
      });
      break;
    }
    case 'session.create': {
      const now = timestamp(0);
      const session = {
        id: request.params.sessionId,
        nativeSessionId: request.params.nativeSession?.id ?? `native-${pluginId}-${request.params.sessionId}`,
        streamId: `stream-${pluginId}-${++streamSequence}`,
        state: 'idle',
        sessionConfig: request.params.config ?? {},
        lastError: null,
        createdAt: now,
        updatedAt: now,
        sequence: 0,
        activeTurn: null,
        pendingInteraction: null,
        interactionSequence: 0,
        replayRevision: 1,
        name: null,
      };
      sessions.set(session.id, session);
      result(request.id, { session: sessionResult(session) });
      break;
    }
    case 'session.get': {
      const session = sessions.get(request.params.sessionId);
      if (!session) fail(request.id, 'SESSION_NOT_FOUND', 'Mock session not found');
      else result(request.id, { session: sessionResult(session) });
      break;
    }
    case 'turn.start': {
      const session = sessions.get(request.params.sessionId);
      if (!session) {
        fail(request.id, 'SESSION_NOT_FOUND', 'Mock session not found');
        break;
      }
      if (session.activeTurn) {
        fail(request.id, 'SESSION_BUSY', 'Mock turn already active', true);
        break;
      }
      session.activeTurn = {
        turnId: request.params.turnId,
        sourceTurnId: `source-${request.params.turnId}`,
      };
      session.state = 'running';
      result(request.id, { accepted: true, turnId: request.params.turnId });
      emitTurn(session, 'turn.started', {});
      runScenario(session, scenarioName(request));
      break;
    }
    case 'turn.steer': {
      const session = sessions.get(request.params.sessionId);
      if (!session?.activeTurn || session.activeTurn.turnId !== request.params.turnId) {
        fail(request.id, 'TURN_NOT_FOUND', 'Mock active turn not found');
        break;
      }
      result(request.id, { accepted: true, turnId: request.params.turnId });
      const text = (request.params.input ?? [])
        .filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join('\n');
      emitText(session, `steer-${session.sequence}`, `Mock steer received: ${text}`);
      break;
    }
    case 'turn.interrupt': {
      const session = sessions.get(request.params.sessionId);
      if (!session?.activeTurn || session.activeTurn.turnId !== request.params.turnId) {
        fail(request.id, 'TURN_NOT_FOUND', 'Mock active turn not found');
        break;
      }
      result(request.id, { accepted: true, turnId: request.params.turnId });
      setTimeout(() => {
        if (session.pendingInteraction) {
          emitTurn(session, 'interaction.resolved', {
            interactionId: session.pendingInteraction.id,
            outcome: 'turn_ended',
          });
          session.pendingInteraction = null;
        }
        finishTurn(session, 'interrupted');
      }, 100);
      break;
    }
    case 'interaction.respond': {
      const session = sessions.get(request.params.sessionId);
      const pending = session?.pendingInteraction;
      if (!session || !pending || pending.id !== request.params.interactionId) {
        fail(request.id, 'INTERACTION_NOT_FOUND', 'Mock interaction not found');
        break;
      }
      result(request.id, {
        accepted: true,
        interactionId: request.params.interactionId,
        responseId: request.params.responseId,
      });
      setTimeout(() => {
        emitTurn(session, 'interaction.resolved', {
          interactionId: pending.id,
          outcome: request.params.actionId === 'mock-cancel' ? 'cancelled' : 'submitted',
          ...(request.params.actionId === 'mock-cancel' ? {} : { actionId: request.params.actionId }),
          displaySummary: `Mock values: ${JSON.stringify(request.params.values)}`,
        });
        session.pendingInteraction = null;
        session.state = 'running';
        emitText(session, 'interaction-result', `Mock action received: ${request.params.actionId}`);
        finishTurn(session);
      }, 100);
      break;
    }
    case 'session.rename': {
      const session = sessions.get(request.params.sessionId);
      if (!session) fail(request.id, 'SESSION_NOT_FOUND', 'Mock session not found');
      else {
        session.name = request.params.name;
        result(request.id, { ok: true });
      }
      break;
    }
    case 'session.native.list':
      result(request.id, {
        sessions: [{
          id: `native-${pluginId}-existing`,
          displayName: 'Existing mock native session',
          cwd: request.params.cwd,
          updatedAt: timestamp(0),
        }],
        nextCursor: null,
      });
      break;
    case 'session.native.delete':
      result(request.id, { ok: true });
      break;
    case 'session.replay': {
      const session = sessions.get(request.params.sessionId);
      if (!session) {
        fail(request.id, 'SESSION_NOT_FOUND', 'Mock session not found');
        break;
      }
      const replayStreamId = `replay-${session.nativeSessionId}-${session.replayRevision}`;
      const events = replayEvents(session.id, replayStreamId);
      const offset = Number(request.params.cursor ?? 0);
      const page = events.slice(offset, offset + request.params.limit);
      const nextOffset = offset + page.length;
      result(request.id, {
        replayStreamId,
        events: page,
        nextCursor: nextOffset < events.length ? String(nextOffset) : null,
      });
      break;
    }
    case 'session.close':
      sessions.delete(request.params.sessionId);
      result(request.id, { ok: true });
      break;
    case 'shutdown':
      result(request.id, { ok: true });
      clearInterval(controlTimer);
      process.exit(0);
      break;
    default:
      fail(request.id, 'CAPABILITY_NOT_SUPPORTED', `Unsupported mock method ${request.method}`);
  }
}
clearInterval(controlTimer);
