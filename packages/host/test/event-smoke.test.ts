import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { ApprovalRequestedData, ProxyNotification, ServerToClientMessage } from '@gian/shared';
import { ApprovalManager } from '../src/approval/index.js';
import { normalizeCcNotification } from '../src/event/normalize-cc.js';
import { normalizeCodexNotification } from '../src/event/normalize-codex.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';

class CapturingBroadcaster {
  messages: ServerToClientMessage[] = [];
  add() {}
  remove() {}
  send() {}
  broadcast(msg: ServerToClientMessage): void {
    this.messages.push(msg);
  }
  get size() {
    return 0;
  }
}

function cc(raw: ProxyNotification): ReturnType<typeof normalizeCcNotification> {
  return normalizeCcNotification(raw, 'session-claude', 1);
}

function codex(raw: ProxyNotification): ReturnType<typeof normalizeCodexNotification> {
  return normalizeCodexNotification(raw, 'session-codex', 1);
}

function tick() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

test('event smoke · Claude -p maps text, tools, approvals, auto notices, and lifecycle', () => {
  const questionInput = JSON.stringify({
    questions: [{
      question: 'Pick a branch',
      header: 'Branch',
      options: [{ label: 'main' }, { label: 'feature' }],
    }],
  });
  const planInput = JSON.stringify({ plan: '1. Inspect\n2. Edit' });

  const events = [
    ...cc({ method: 'output.text', params: { sessionId: 'proxy', data: { itemId: 'msg-1', text: 'hello' } } }),
    ...cc({ method: 'tool.use', params: { sessionId: 'proxy', data: { callId: 'bash-1', toolName: 'Bash', input: { command: 'npm test', cwd: '/repo' } } } }),
    ...cc({ method: 'tool.use', params: { sessionId: 'proxy', data: { callId: 'read-1', toolName: 'Read', input: { file_path: '/repo/src/app.ts', offset: 3, limit: 2 } } } }),
    ...cc({ method: 'tool.use', params: { sessionId: 'proxy', data: { callId: 'grep-1', toolName: 'Grep', input: { pattern: 'approval' } } } }),
    ...cc({ method: 'tool.use', params: { sessionId: 'proxy', data: { callId: 'web-1', toolName: 'WebSearch', input: { query: 'codex docs' } } } }),
    ...cc({ method: 'tool.use', params: { sessionId: 'proxy', data: { callId: 'agent-1', toolName: 'Agent', input: { description: 'inspect tests' } } } }),
    ...cc({ method: 'approval.requested', params: { sessionId: 'proxy', data: { approvalId: 'appr-bash', toolName: 'Bash', inputPreview: JSON.stringify({ command: 'npm install', description: 'install deps' }) } } }),
    ...cc({ method: 'approval.requested', params: { sessionId: 'proxy', data: { approvalId: 'appr-question', toolName: 'AskUserQuestion', inputPreview: questionInput } } }),
    ...cc({ method: 'approval.requested', params: { sessionId: 'proxy', data: { approvalId: 'appr-plan', toolName: 'ExitPlanMode', category: 'exit_plan_mode', inputPreview: planInput } } }),
    ...cc({ method: 'approval.resolved', params: { sessionId: 'proxy', data: { approvalId: 'appr-bash', behavior: 'allow' } } }),
    ...cc({ method: 'auto.classifier_denied', params: { sessionId: 'proxy', data: { callId: 'auto-1', action: 'Bash', reason: 'blocked', consecutive: 1, total: 2 } } }),
    ...cc({ method: 'auto.circuit_breaker', params: { sessionId: 'proxy', data: { callId: 'auto-2', trigger: 'consecutive', consecutive: 3, total: 3 } } }),
    ...cc({ method: 'turn.completed', params: { sessionId: 'proxy', turnId: 'turn-1', data: { result: 'done' } } }),
    ...cc({ method: 'turn.failed', params: { sessionId: 'proxy', data: { error: 'process exit' } } }),
  ];

  assert.deepEqual(events.map(e => e.type), [
    'assistant_text',
    'command_execution',
    'file_read',
    'file_search',
    'web_search',
    'agent_spawn',
    'approval_requested',
    'approval_requested',
    'approval_requested',
    'approval_resolved',
    'auto_classifier_denied',
    'auto_circuit_breaker',
    'turn_completed',
    'session_error',
  ]);

  const question = events.find(e => e.call_id === 'appr-question');
  assert.equal(question?.type, 'approval_requested');
  const questionData = question?.data as ApprovalRequestedData | undefined;
  assert.equal(questionData?.category, 'question');
  assert.equal(questionData?.questions?.[0]?.question, 'Pick a branch');

  const plan = events.find(e => e.call_id === 'appr-plan');
  assert.equal(plan?.type, 'approval_requested');
  const planData = plan?.data as ApprovalRequestedData | undefined;
  assert.equal(planData?.category, 'exit_plan_mode');
  assert.deepEqual(planData?.planActions, ['accept_with_auto', 'accept_with_ask', 'keep_planning']);
  assert.equal(planData?.subject, '1. Inspect\n2. Edit');
});

test('event smoke · Codex maps live events and preserves approval reason/category metadata', () => {
  const events = [
    ...codex({ method: 'output.text.delta', params: { sessionId: 'proxy', data: { itemId: 'msg-1', delta: 'hello' } } }),
    ...codex({ method: 'output.command.delta', params: { sessionId: 'proxy', data: { itemId: 'cmd-1', delta: 'ok\n' } } }),
    ...codex({ method: 'diff.updated', params: { sessionId: 'proxy', data: { params: { diff: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n' } } } }),
    ...codex({ method: 'approval.requested', params: { sessionId: 'proxy', data: {
      approvalId: 'codex-cmd',
      method: 'item/commandExecution/requestApproval',
      title: 'Approve command execution',
      reason: 'Run tests',
      severity: 'medium',
      payload: { command: 'npm test' },
      scopeOptions: ['once', 'session'],
    } } }),
    ...codex({ method: 'approval.requested', params: { sessionId: 'proxy', data: {
      approvalId: 'codex-net',
      method: 'item/permissions/requestApproval',
      title: 'Grant extra permissions',
      reason: 'Need docs',
      severity: 'low',
      permissionsKind: 'network',
      payload: { permissions: { network: true } },
      scopeOptions: ['once', 'session'],
    } } }),
    ...codex({ method: 'approval.resolved', params: { sessionId: 'proxy', data: { approvalId: 'codex-cmd', decision: 'accept', scope: 'session' } } }),
    ...codex({ method: 'turn.completed', params: { sessionId: 'proxy', turnId: 'turn-1', data: { summary: { assistantText: 'done' } } } }),
    ...codex({ method: 'runtime.error', params: { sessionId: 'proxy', data: { message: 'runtime failed', code: 'E_RUNTIME' } } }),
  ];

  assert.deepEqual(events.map(e => e.type), [
    'assistant_text',
    'command_execution',
    'file_change',
    'approval_requested',
    'approval_requested',
    'approval_resolved',
    'turn_completed',
    'session_error',
  ]);

  const commandApproval = events.find(e => e.call_id === 'codex-cmd');
  assert.equal(commandApproval?.type, 'approval_requested');
  const commandApprovalData = commandApproval?.data as ApprovalRequestedData | undefined;
  assert.equal(commandApprovalData?.category, 'command');
  assert.equal(commandApprovalData?.risk, 'medium');
  assert.equal(commandApprovalData?.description, 'Run tests');
  assert.equal(commandApprovalData?.subject, 'npm test');

  const networkApproval = events.find(e => e.call_id === 'codex-net');
  assert.equal(networkApproval?.type, 'approval_requested');
  const networkApprovalData = networkApproval?.data as ApprovalRequestedData | undefined;
  assert.equal(networkApprovalData?.category, 'network');
  assert.equal(networkApprovalData?.risk, 'low');
  assert.equal(networkApprovalData?.description, 'Need docs');
});

test('event smoke · interaction approvals never auto-approve without a user choice', async () => {
  const broadcaster = new CapturingBroadcaster();
  const approvals = new ApprovalManager(broadcaster as unknown as WsBroadcaster);
  const responded: Array<{ sessionId: string; approvalId: string; decision: string }> = [];
  approvals.setGetModeFn(() => 'auto');
  approvals.setRespondFn(async (sessionId, approvalId, decision) => {
    responded.push({ sessionId, approvalId, decision });
  });

  const question = approvals.request({
    sessionId: 'session-claude',
    turnId: 'turn-1',
    category: 'question',
    risk: 'low',
    description: 'Pick one',
    payload: { approvalId: 'appr-question' },
  });
  await tick();
  assert.equal(approvals.getPending('appr-question')?.category, 'question');
  assert.equal(responded.length, 0);
  approvals.resolve('appr-question', 'allow_once', 'web');
  assert.equal(await question, 'allow_once');

  const plan = approvals.request({
    sessionId: 'session-claude',
    turnId: 'turn-1',
    category: 'exit_plan_mode',
    risk: 'low',
    description: 'Review plan',
    payload: { approvalId: 'appr-plan' },
  });
  await tick();
  assert.equal(approvals.getPending('appr-plan')?.category, 'exit_plan_mode');
  assert.equal(responded.length, 0);
  approvals.resolve('appr-plan', 'keep_planning', 'web');
  assert.equal(await plan, 'keep_planning');

  await approvals.request({
    sessionId: 'session-claude',
    turnId: 'turn-1',
    category: 'network',
    risk: 'low',
    description: 'Fetch docs',
    payload: { approvalId: 'appr-network' },
  });
  assert.deepEqual(responded, [{
    sessionId: 'session-claude',
    approvalId: 'appr-network',
    decision: 'allow_once',
  }]);
});
