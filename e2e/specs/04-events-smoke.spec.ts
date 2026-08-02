import { expect, test, type Page } from '@playwright/test';
import type { EventMessage } from '@gian/shared';
import { emitWsMessage, installMockApp, mockSession, mockWorkspace, sentWsMessages } from '../fixtures/mock-app.js';
import { openSessions } from '../fixtures/navigation.js';

const ts = () => Date.now();

function event(
  sessionId: string,
  callId: string,
  eventName: string,
  data: Record<string, unknown>,
): EventMessage {
  return {
    type: 'event',
    session_id: sessionId,
    turn: 1,
    call_id: callId,
    event: eventName,
    ts: ts(),
    data,
  };
}

async function openSession(page: Page, sessionId: string) {
  await openSessions(page);
  const row = page.getByTestId(`session-row-${sessionId}`);
  await expect(row).toBeVisible();
  const historyLoaded = page.waitForResponse(response =>
    response.url().includes(`/api/sessions/${sessionId}/events`),
  );
  await row.click();
  await historyLoaded;
}

test.describe('04 · Event smoke', () => {
  test('Claude -p renders text/tools/question/plan/auto notices and sends structured answers', async ({ page }) => {
    // Claude -p smoke set:
    // assistant_text, command_execution, file_read, file_search, web_search,
    // agent_spawn, question approval, exit_plan_mode approval, auto notices.
    const ws = mockWorkspace({ id: 'ws-claude-events', name: 'claude-events' });
    const session = mockSession({
      id: 'session-claude-events',
      name: 'Claude event smoke',
      workspace_id: ws.id,
      executor: 'claude',
      status: 'running',
      approval_mode: 'ask',
    });
    await installMockApp(page, { workspaces: [ws], sessions: [session] });
    await openSession(page, session.id);

    await emitWsMessage(page, event(session.id, 'msg-1', 'assistant_text', {
      itemId: 'msg-1',
      text: 'Claude saw the repo.',
      delta: false,
    }));
    await emitWsMessage(page, event(session.id, 'cmd-1', 'command_execution', {
      itemId: 'cmd-1',
      command: 'npm test',
      cwd: ws.path,
      status: 'running',
      stdout: '',
    }));
    await emitWsMessage(page, event(session.id, 'read-1', 'file_read', {
      path: `${ws.path}/src/App.tsx`,
      startLine: 4,
      endLine: 8,
    }));
    await emitWsMessage(page, event(session.id, 'grep-1', 'file_search', {
      pattern: 'AskUserQuestion',
      kind: 'grep',
      matchCount: 2,
    }));
    await emitWsMessage(page, event(session.id, 'web-1', 'web_search', {
      query: 'codex app-server events',
      resultCount: 3,
    }));
    await emitWsMessage(page, event(session.id, 'agent-1', 'agent_spawn', {
      description: 'inspect event tests',
      status: 'running',
    }));
    await emitWsMessage(page, event(session.id, 'auto-1', 'auto_classifier_denied', {
      action: 'Bash',
      reason: 'blocked by auto classifier',
      consecutive: 1,
      total: 1,
    }));

    await expect(page.getByText('Claude saw the repo.')).toBeVisible();
    await expect(page.getByText('npm test').first()).toBeVisible();
    await expect(page.getByText('src/App.tsx').first()).toBeVisible();
    await expect(page.getByText('AskUserQuestion').first()).toBeVisible();
    await expect(page.getByText('codex app-server events').first()).toBeVisible();
    await expect(page.getByText('inspect event tests').first()).toBeVisible();
    await expect(page.getByText('blocked by auto classifier').first()).toBeVisible();

    await emitWsMessage(page, event(session.id, 'appr-question', 'approval_requested', {
      approvalId: 'appr-question',
      category: 'question',
      risk: 'low',
      title: 'Pick a branch',
      description: '',
      scopeOptions: ['once'],
      questions: [{
        question: 'Pick a branch',
        header: 'Branch',
        multiSelect: false,
        options: [
          { label: 'main', description: 'Stable branch' },
          { label: 'feature', description: 'Current work' },
        ],
      }],
    }));
    await expect(page.getByText('Question from agent')).toBeVisible();
    await page.getByLabel('feature').check();
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect
      .poll(async () => sentWsMessages(page), { timeout: 3_000 })
      .toContainEqual(expect.objectContaining({
        type: 'approval:resolve',
        session_id: session.id,
        approval_id: 'appr-question',
        decision: 'allow_once',
        answers: { 'Pick a branch': 'feature' },
      }));

    await emitWsMessage(page, event(session.id, 'appr-plan', 'approval_requested', {
      approvalId: 'appr-plan',
      category: 'exit_plan_mode',
      risk: 'medium',
      title: 'Plan ready for review',
      description: 'Claude has finished planning. Choose how to proceed.',
      subject: '1. Inspect event parsing\n2. Add smoke tests',
      scopeOptions: ['once'],
      planActions: ['accept_with_auto', 'accept_with_ask', 'keep_planning'],
    }));
    await expect(page.getByText('Plan ready for review')).toBeVisible();
    await expect(page.getByText('Inspect event parsing')).toBeVisible();
    await page.getByRole('button', { name: 'No, keep planning' }).click();
    await expect
      .poll(async () => sentWsMessages(page), { timeout: 3_000 })
      .toContainEqual(expect.objectContaining({
        type: 'approval:resolve',
        session_id: session.id,
        approval_id: 'appr-plan',
        decision: 'keep_planning',
      }));

    await emitWsMessage(page, event(session.id, 'auto-2', 'auto_circuit_breaker', {
      trigger: 'consecutive',
      consecutive: 3,
      total: 3,
    }));
    await expect(page.getByText('Auto-mode circuit breaker tripped')).toBeVisible();
  });

  test('Codex renders text/command/diff/approval lifecycle without Claude-only interaction cards', async ({ page }) => {
    // Codex smoke set:
    // assistant_text delta accumulation, command_execution stream, file_change,
    // command approval, network permission approval, approval_resolved.
    const ws = mockWorkspace({ id: 'ws-codex-events', name: 'codex-events' });
    const session = mockSession({
      id: 'session-codex-events',
      name: 'Codex event smoke',
      workspace_id: ws.id,
      executor: 'codex',
      status: 'running',
      approval_mode: 'ask',
    });
    await installMockApp(page, { workspaces: [ws], sessions: [session] });
    await openSession(page, session.id);

    await emitWsMessage(page, event(session.id, 'msg-1', 'assistant_text', {
      itemId: 'msg-1',
      text: 'Codex is checking.',
      delta: true,
    }));
    await emitWsMessage(page, event(session.id, 'cmd-1', 'command_execution', {
      itemId: 'cmd-1',
      command: 'npm test',
      cwd: ws.path,
      status: 'running',
      stdoutDelta: 'ok\n',
    }));
    await emitWsMessage(page, event(session.id, 'diff-1', 'file_change', {
      files: [{ path: `${ws.path}/src/App.tsx`, kind: 'update', added: 1, removed: 1 }],
      diff: `diff --git a/src/App.tsx b/src/App.tsx
--- a/src/App.tsx
+++ b/src/App.tsx
@@ -1 +1 @@
-old
+new
`,
    }));

    await expect(page.getByText('Codex is checking.')).toBeVisible();
    await expect(page.getByText('npm test').first()).toBeVisible();
    await expect(page.getByText('src/App.tsx').first()).toBeVisible();

    await emitWsMessage(page, event(session.id, 'appr-cmd', 'approval_requested', {
      approvalId: 'appr-cmd',
      category: 'command',
      risk: 'medium',
      title: 'Approve command execution',
      description: 'Run tests',
      subject: 'npm test',
      scopeOptions: ['once', 'session'],
    }));
    await emitWsMessage(page, event(session.id, 'appr-net', 'approval_requested', {
      approvalId: 'appr-net',
      category: 'network',
      risk: 'low',
      title: 'Grant extra permissions',
      description: 'Need docs',
      scopeOptions: ['once', 'session'],
    }));

    await expect(page.getByText('Approve command execution')).toBeVisible();
    await expect(page.getByText('Run tests')).toBeVisible();
    await expect(page.getByText('Grant extra permissions')).toBeVisible();
    await expect(page.getByText('Need docs')).toBeVisible();
    await expect(page.getByText('Question from agent')).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'No, keep planning' })).not.toBeVisible();

    await page.locator('.approval', { hasText: 'Approve command execution' })
      .getByRole('button', { name: 'Allow session' })
      .click();
    await expect
      .poll(async () => sentWsMessages(page), { timeout: 3_000 })
      .toContainEqual(expect.objectContaining({
        type: 'approval:resolve',
        session_id: session.id,
        approval_id: 'appr-cmd',
        decision: 'allow_session',
      }));

    await emitWsMessage(page, event(session.id, 'appr-cmd', 'approval_resolved', {
      approvalId: 'appr-cmd',
      decision: 'allow_session',
      auto: false,
    }));
    await expect(page.locator('.approval', { hasText: 'Approve command execution' })).toContainText('Allowed for session');
  });
});
