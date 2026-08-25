/**
 * Synthetic trace fixtures (Trace frontend MVP, 2026-08-15).
 *
 * Cover the six scenarios the MVP contract requires; every item is stamped
 * `evidence: 'synthetic'` so a fixture can never masquerade as a real trace.
 * Timestamps are fixed ISO strings — tests must stay deterministic.
 *
 *   1. traceFixtureMultiTurn          normal session, several turns & tools
 *   2. traceFixturePartialCapability  no reasoning/plan/agent kinds at all
 *   3. traceFixtureStreaming          tool still streaming, partial = true
 *   4. traceFixtureFailure            failed tool + interrupted turn
 *   5. traceFixtureUpsertUpdates      repeated updates for ONE tool call
 *   6. traceFixtureStepRequest        step-linked request/tool/assistant/usage
 *   7. traceFixtureMultiStep          one turn, two steps, each with children
 *   8. traceFixtureOrphanParent       parentId pointing at a missing step
 *   9. traceFixtureTruncatedRequest   truncated request payload + artifact
 *
 * Scenarios 1–5 double as the old-data-without-steps coverage: they carry no
 * `kind: 'step'`/`'request'` items and no `parentId`, so they pin the
 * pre-step rendering contract.
 */

import type { TraceItem, TraceSnapshot } from './types.js';

const SYNTHETIC = 'synthetic' as const;
const SESSION = 'sess-fixture';
const GENERATED_AT = '2026-08-15T10:20:00.000Z';

function at(minute: number, second = 0, ms = 0): string {
  return `2026-08-15T10:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.${String(ms).padStart(3, '0')}Z`;
}

function item(partial: Partial<TraceItem> & Pick<TraceItem, 'id' | 'turnId' | 'kind' | 'title' | 'at'>): TraceItem {
  const pointKinds = new Set<TraceItem['kind']>(['input', 'request', 'notice']);
  return {
    evidence: SYNTHETIC,
    shape: pointKinds.has(partial.kind) ? 'event' : 'span',
    sourceEventIds: [`evt-${partial.id}`],
    ...partial,
  };
}

function turn(n: number, startMin: number, endMin?: number, status?: TraceItem['status']): TraceItem {
  const start = at(startMin);
  const end = endMin !== undefined ? at(endMin) : undefined;
  return item({
    id: `turn-${n}`,
    turnId: `turn-${n}`,
    kind: 'turn',
    title: `Turn ${n}`,
    status,
    at: start,
    endAt: end,
    durationMs: end !== undefined ? Date.parse(end) - Date.parse(start) : undefined,
  });
}

/* 1 ── Normal multi-turn, multi-tool session ─────────────────────────── */

export const traceFixtureMultiTurn: TraceSnapshot = {
  sessionId: SESSION,
  generatedAt: GENERATED_AT,
  partial: false,
  items: [
    turn(1, 0, 2, 'succeeded'),
    item({
      id: 't1-input', turnId: 'turn-1', kind: 'input', at: at(0, 0),
      title: 'Add a greeting endpoint to the server',
      detail: { text: 'Add a greeting endpoint to the server' },
    }),
    item({
      id: 't1-reasoning', turnId: 'turn-1', kind: 'reasoning', at: at(0, 3),
      title: 'I will look at the router first, then add the handler.',
      detail: { text: 'I will look at the router first, then add the handler.' },
    }),
    item({
      id: 't1-tool-read', turnId: 'turn-1', kind: 'tool', title: 'Read', at: at(0, 5), endAt: at(0, 6),
      summary: '{"file_path":"/src/server.ts"}',
      status: 'succeeded', correlationId: 'call-read-1',
      detail: { output: 'export function createServer() { … }' },
    }),
    item({
      id: 't1-tool-edit', turnId: 'turn-1', kind: 'tool', title: 'Edit', at: at(0, 10), endAt: at(0, 12),
      summary: '{"file_path":"/src/server.ts"}',
      status: 'succeeded', correlationId: 'call-edit-1',
      detail: { output: 'The file /src/server.ts has been updated.' },
    }),
    item({
      id: 't1-assistant', turnId: 'turn-1', kind: 'assistant', at: at(1, 30),
      title: 'Added the greeting endpoint and wired it into the router.',
      detail: { text: 'Added the greeting endpoint and wired it into the router.' },
    }),
    turn(2, 3, 5, 'succeeded'),
    item({
      id: 't2-input', turnId: 'turn-2', kind: 'input', at: at(3, 0),
      title: 'Now add a test for it',
    }),
    item({
      id: 't2-plan', turnId: 'turn-2', kind: 'plan', at: at(3, 4),
      title: '1. Read existing tests 2. Add greeting test 3. Run suite',
      detail: { steps: ['Read existing tests', 'Add greeting test', 'Run suite'] },
    }),
    item({
      id: 't2-tool-write', turnId: 'turn-2', kind: 'tool', title: 'Write', at: at(3, 8), endAt: at(3, 9),
      summary: '{"file_path":"/test/greeting.test.ts"}',
      status: 'succeeded', correlationId: 'call-write-1',
    }),
    item({
      id: 't2-tool-bash', turnId: 'turn-2', kind: 'tool', title: 'Bash', at: at(3, 20), endAt: at(4, 50),
      summary: '{"command":"pnpm test"}',
      status: 'succeeded', correlationId: 'call-bash-1',
      detail: { output: 'Tests: 12 passed, 12 total' },
    }),
    item({
      id: 't2-agent', turnId: 'turn-2', kind: 'agent', title: 'Explore test conventions', at: at(3, 5), endAt: at(3, 18),
      status: 'succeeded', correlationId: 'call-agent-1',
      detail: { agentType: 'Explore' },
    }),
    item({
      id: 't2-assistant', turnId: 'turn-2', kind: 'assistant', at: at(4, 55),
      title: 'Test added; the full suite passes.',
    }),
  ],
};

/* 2 ── Partial capability: no reasoning / plan / agent kinds ─────────── */

export const traceFixturePartialCapability: TraceSnapshot = {
  sessionId: SESSION,
  generatedAt: GENERATED_AT,
  partial: false,
  items: [
    turn(1, 0, 1, 'succeeded'),
    item({
      id: 'pc-input', turnId: 'turn-1', kind: 'input', at: at(0, 0),
      title: 'What does main() do?',
    }),
    item({
      id: 'pc-tool', turnId: 'turn-1', kind: 'tool', title: 'Read', at: at(0, 2), endAt: at(0, 3),
      status: 'succeeded', correlationId: 'call-pc-1',
    }),
    item({
      id: 'pc-assistant', turnId: 'turn-1', kind: 'assistant', at: at(0, 30),
      title: 'It parses args and starts the server.',
    }),
  ],
};

/* 3 ── Still streaming: running tool, partial snapshot ───────────────── */

export const traceFixtureStreaming: TraceSnapshot = {
  sessionId: SESSION,
  generatedAt: GENERATED_AT,
  partial: true,
  items: [
    turn(1, 0, undefined, 'running'),
    item({
      id: 'st-input', turnId: 'turn-1', kind: 'input', at: at(0, 0),
      title: 'Run the migration',
    }),
    item({
      id: 'st-tool', turnId: 'turn-1', kind: 'tool', title: 'Bash', at: at(0, 2),
      summary: '{"command":"pnpm db:migrate"}',
      status: 'running', correlationId: 'call-st-1',
      detail: { output: 'Migrating 3 of 7…' },
    }),
  ],
};

/* 4 ── Failed tool + interrupted turn ────────────────────────────────── */

export const traceFixtureFailure: TraceSnapshot = {
  sessionId: SESSION,
  generatedAt: GENERATED_AT,
  partial: false,
  items: [
    turn(1, 0, 2, 'succeeded'),
    item({
      id: 'f1-input', turnId: 'turn-1', kind: 'input', at: at(0, 0),
      title: 'Try the flaky deploy',
    }),
    item({
      id: 'f1-tool', turnId: 'turn-1', kind: 'tool', title: 'Bash', at: at(0, 5), endAt: at(1, 5),
      summary: '{"command":"./deploy.sh"}',
      status: 'failed', correlationId: 'call-f1-1',
      detail: { output: 'ssh: connect to host prod port 22: Connection refused' },
    }),
    turn(2, 3, 4, 'interrupted'),
    item({
      id: 'f2-input', turnId: 'turn-2', kind: 'input', at: at(3, 0),
      title: 'Retry but stop if it hangs',
    }),
    item({
      id: 'f2-tool', turnId: 'turn-2', kind: 'tool', title: 'Bash', at: at(3, 5), endAt: at(3, 55),
      summary: '{"command":"./deploy.sh --watch"}',
      status: 'interrupted', correlationId: 'call-f2-1',
    }),
    item({
      id: 'f2-notice', turnId: 'turn-2', kind: 'notice', at: at(3, 56),
      title: 'Turn interrupted by user',
      status: 'interrupted',
    }),
  ],
};

/* 5 ── Repeated updates for ONE tool call (upsert must keep one row) ─── */

export const traceFixtureUpsertUpdates: TraceItem[] = [
  item({
    id: 'up-tool-1', turnId: 'turn-1', kind: 'tool', title: 'Bash', at: at(0, 2),
    summary: '{"command":"pnpm build"}',
    status: 'running', correlationId: 'call-up-1',
  }),
  item({
    id: 'up-tool-1', turnId: 'turn-1', kind: 'tool', title: 'Bash', at: at(0, 2),
    summary: '{"command":"pnpm build"}',
    status: 'running', correlationId: 'call-up-1',
    detail: { output: 'Compiling…' },
  }),
  item({
    id: 'up-tool-1', turnId: 'turn-1', kind: 'tool', title: 'Bash', at: at(0, 2), endAt: at(0, 40),
    summary: '{"command":"pnpm build"}',
    status: 'succeeded', correlationId: 'call-up-1',
    detail: { output: 'Build completed in 38s' },
  }),
];

/* 6 ── Step/request hierarchy with a folded system prompt ────────────── */

const STEP_ID = 'step:turn-1:native-turn-1:0';

export const traceFixtureStepRequest: TraceSnapshot = {
  sessionId: SESSION,
  generatedAt: GENERATED_AT,
  partial: false,
  items: [
    turn(1, 0, 1, 'succeeded'),
    item({
      id: STEP_ID,
      turnId: 'turn-1',
      kind: 'step',
      title: 'Step 1',
      summary: 'native-turn-1:0',
      status: 'succeeded',
      at: at(0, 1),
      endAt: at(0, 50),
      durationMs: 49_000,
      correlationId: 'native-turn-1:0',
    }),
    item({
      id: 'request-1',
      turnId: 'turn-1',
      parentId: STEP_ID,
      kind: 'request',
      title: 'DeepSeek Chat',
      summary: 'initial',
      at: at(0, 2),
      correlationId: 'request-1',
      detail: {
        requestId: 'request-1',
        reason: 'initial',
        stepId: 'native-turn-1:0',
        model: { provider: 'deepseek', id: 'deepseek-chat', displayName: 'DeepSeek Chat' },
        parameters: { effort: 'high', temperature: 0.2 },
        systemPrompt: { text: 'You are a careful coding agent.', truncated: false },
        tools: [{ name: 'read_file', description: 'Read one workspace file.' }],
        context: { window: 128_000 },
        truncated: false,
      },
    }),
    item({
      id: 'step-tool-1',
      turnId: 'turn-1',
      parentId: STEP_ID,
      kind: 'tool',
      title: 'read_file',
      status: 'succeeded',
      at: at(0, 4),
      endAt: at(0, 6),
      correlationId: 'tool-1',
    }),
    item({
      id: 'step-assistant-1',
      turnId: 'turn-1',
      parentId: STEP_ID,
      kind: 'assistant',
      title: 'The file is ready.',
      status: 'succeeded',
      at: at(0, 40),
      correlationId: 'assistant-1',
    }),
    item({
      id: 'step-usage-1',
      turnId: 'turn-1',
      parentId: STEP_ID,
      kind: 'notice',
      title: 'Usage',
      summary: '50 input, 10 output',
      at: at(0, 45),
      detail: { conversation: { mode: 'delta', inputTokens: 50, outputTokens: 10 } },
    }),
  ],
};

/* 7 ── Multi-step tree: two steps in one turn, each with children ────── */

const MULTI_STEP_1 = 'step:turn-1:native-turn-1:0';
const MULTI_STEP_2 = 'step:turn-1:native-turn-1:1';

export const traceFixtureMultiStep: TraceSnapshot = {
  sessionId: SESSION,
  generatedAt: GENERATED_AT,
  partial: false,
  items: [
    turn(1, 0, 2, 'succeeded'),
    item({
      id: MULTI_STEP_1,
      turnId: 'turn-1',
      kind: 'step',
      title: 'Step 1',
      summary: 'native-turn-1:0',
      status: 'succeeded',
      at: at(0, 1),
      durationMs: 20_000,
      correlationId: 'native-turn-1:0',
    }),
    item({
      id: 'ms-request-1',
      turnId: 'turn-1',
      parentId: MULTI_STEP_1,
      kind: 'request',
      title: 'Mock Sonnet',
      summary: 'initial',
      at: at(0, 2),
      detail: {
        requestId: 'ms-request-1',
        reason: 'initial',
        stepId: 'native-turn-1:0',
        model: { provider: 'mock', id: 'mock-sonnet', displayName: 'Mock Sonnet' },
        parameters: { effort: 'medium' },
        context: { window: 8192 },
        truncated: false,
      },
    }),
    item({
      id: 'ms-tool-1',
      turnId: 'turn-1',
      parentId: MULTI_STEP_1,
      kind: 'tool',
      title: 'mock_tool',
      status: 'succeeded',
      at: at(0, 4),
      endAt: at(0, 6),
      correlationId: 'ms-call-1',
    }),
    item({
      id: MULTI_STEP_2,
      turnId: 'turn-1',
      kind: 'step',
      title: 'Step 2',
      summary: 'native-turn-1:1',
      status: 'succeeded',
      at: at(0, 30),
      durationMs: 25_000,
      correlationId: 'native-turn-1:1',
    }),
    item({
      id: 'ms-request-2',
      turnId: 'turn-1',
      parentId: MULTI_STEP_2,
      kind: 'request',
      title: 'Mock Sonnet',
      summary: 'resume',
      at: at(0, 31),
      detail: {
        requestId: 'ms-request-2',
        reason: 'resume',
        stepId: 'native-turn-1:1',
        model: { provider: 'mock', id: 'mock-sonnet', displayName: 'Mock Sonnet' },
        truncated: false,
      },
    }),
    item({
      id: 'ms-assistant-2',
      turnId: 'turn-1',
      parentId: MULTI_STEP_2,
      kind: 'assistant',
      title: 'Both steps are done.',
      status: 'succeeded',
      at: at(0, 55),
      correlationId: 'ms-assistant-2',
    }),
  ],
};

/* 8 ── Orphan parentId: points at a step that never arrived ──────────── */

const ORPHAN_STEP = 'step:turn-1:native-turn-1:0';

export const traceFixtureOrphanParent: TraceSnapshot = {
  sessionId: SESSION,
  generatedAt: GENERATED_AT,
  partial: false,
  items: [
    turn(1, 0, 1, 'succeeded'),
    item({
      id: ORPHAN_STEP,
      turnId: 'turn-1',
      kind: 'step',
      title: 'Step 1',
      summary: 'native-turn-1:0',
      status: 'succeeded',
      at: at(0, 1),
      durationMs: 10_000,
      correlationId: 'native-turn-1:0',
    }),
    item({
      id: 'orphan-child',
      turnId: 'turn-1',
      parentId: ORPHAN_STEP,
      kind: 'tool',
      title: 'mock_tool',
      status: 'succeeded',
      at: at(0, 3),
      correlationId: 'orphan-call-1',
    }),
    // Orphan: the referenced step is not in the snapshot, so this row must
    // stay a top-level entry — never dropped, never attached elsewhere.
    item({
      id: 'orphan-row',
      turnId: 'turn-1',
      parentId: 'step:turn-1:native-turn-1:missing',
      kind: 'assistant',
      title: 'This answer lost its step.',
      status: 'succeeded',
      at: at(0, 40),
      correlationId: 'orphan-assistant',
    }),
  ],
};

/* 9 ── Truncated request payload with an artifact path ───────────────── */

const TRUNC_STEP = 'step:turn-1:native-turn-1:0';

export const traceFixtureTruncatedRequest: TraceSnapshot = {
  sessionId: SESSION,
  generatedAt: GENERATED_AT,
  partial: false,
  items: [
    turn(1, 0, 1, 'succeeded'),
    item({
      id: TRUNC_STEP,
      turnId: 'turn-1',
      kind: 'step',
      title: 'Step 1',
      summary: 'native-turn-1:0',
      status: 'succeeded',
      at: at(0, 1),
      durationMs: 12_000,
      correlationId: 'native-turn-1:0',
    }),
    item({
      id: 'trunc-request-1',
      turnId: 'turn-1',
      parentId: TRUNC_STEP,
      kind: 'request',
      title: 'deepseek-reasoner',
      summary: 'change',
      at: at(0, 2),
      detail: {
        requestId: 'trunc-request-1',
        reason: 'change',
        stepId: 'native-turn-1:0',
        model: { provider: 'deepseek', id: 'deepseek-reasoner' },
        parameters: { effort: 'high', temperature: 0.2, stream: true, maxTokens: 4096 },
        systemPrompt: {
          text: 'You are a careful coding agent. [truncated]',
          truncated: true,
        },
        tools: [
          { name: 'read_file', description: 'Read one workspace file.' },
          { name: 'write_file' },
        ],
        context: { window: 64_000 },
        truncated: true,
        artifact: {
          type: 'localFile',
          path: '/tmp/gian/traces/request-1.json',
          name: 'request-1.json',
        },
      },
    }),
  ],
};
