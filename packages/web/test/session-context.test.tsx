import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { EventEnvelope } from '@gian/shared';
import { PlanChip } from '../src/components/PlanChip.js';
import { projectSessionContext } from '../src/presentation/session-context.js';
import type { ApprovalItem, AgentSpawnItem, TranscriptItem } from '../src/types.js';
import { applyEnvelope } from '../src/transcript/apply.js';

function agent(overrides: Partial<AgentSpawnItem> = {}): AgentSpawnItem {
  return {
    kind: 'agent-spawn',
    id: 'agent-1',
    provider: 'claude',
    description: 'Inspect the event pipeline',
    status: 'running',
    startedAt: 100,
    updatedAt: 100,
    ts: 100,
    turn: 1,
    ...overrides,
  };
}

describe('session persistent context projection', () => {
  it('keeps a live checklist plan out of the transcript and reports progress', () => {
    const projected = projectSessionContext({
      items: [],
      planText: '- [x] inspect\n- [ ] edit\n- [ ] test',
      sessionId: 'session-1',
    });

    expect(projected.plan).toMatchObject({
      status: 'active',
      completedSteps: 1,
      totalSteps: 3,
    });
  });

  it('prefers the latest native plan approval over a streamed plan snapshot', () => {
    const approval: ApprovalItem = {
      kind: 'approval',
      id: 'approval-row',
      approvalId: 'approval-plan',
      title: 'Review plan',
      reason: '',
      cmd: 'Native plan',
      risk: 'low',
      status: 'pending',
      category: 'exit_plan_mode',
      ts: 1,
      turn: 1,
    };
    const projected = projectSessionContext({
      items: [approval],
      planText: 'older stream',
      sessionId: 'session-1',
    });

    expect(projected.plan).toMatchObject({
      id: 'approval-plan',
      markdown: 'Native plan',
      status: 'awaiting-review',
    });
  });

  it('removes a completed streamed plan shortcut while preserving history projection', () => {
    const current = projectSessionContext({
      items: [],
      planText: '- [x] inspect\n- [x] test',
      planCompleted: true,
      sessionId: 'session-1',
    });
    expect(current.plan).toBeNull();

    const history = projectSessionContext({
      items: [],
      planText: '- [x] inspect\n- [x] test',
      planCompleted: true,
      sessionId: 'session-1',
      includePlanHistory: true,
    });
    expect(history.plan?.totalSteps).toBe(2);
  });

  it('removes an accepted Claude plan after its successful turn ends', () => {
    const approval: ApprovalItem = {
      kind: 'approval',
      id: 'approval-row',
      approvalId: 'approval-plan',
      title: 'Review plan',
      reason: '',
      cmd: 'Native plan',
      risk: 'low',
      status: 'approved-once',
      category: 'exit_plan_mode',
      resolvedAt: 120,
      ts: 100,
      turn: 1,
    };
    const turnEnd: TranscriptItem = {
      kind: 'turn-end',
      id: 'turn-end-1',
      text: 'Turn 1 · complete',
      ts: 200,
      turn: 1,
    };

    expect(projectSessionContext({
      items: [approval, turnEnd],
      sessionId: 'session-1',
    }).plan).toBeNull();
    expect(projectSessionContext({
      items: [approval, turnEnd],
      sessionId: 'session-1',
      includePlanHistory: true,
    }).plan?.status).toBe('accepted');
  });

  it('upserts agent lifecycle events instead of adding duplicate transcript rows', () => {
    const running: EventEnvelope = {
      session_id: 'session-1',
      turn: 2,
      call_id: 'tool-agent-1',
      event: 'agent_spawn',
      ts: 100,
      data: {
        agentId: 'native-agent-1',
        taskId: 'task-1',
        description: 'Inspect tests',
        status: 'running',
        agentType: 'Explore',
        background: true,
        input: { prompt: 'Inspect every reducer test.' },
      },
    };
    const done: EventEnvelope = {
      ...running,
      ts: 200,
      data: {
        agentId: 'native-agent-1',
        description: '',
        status: 'done',
        output: 'No failures found.',
      },
    };

    let items: TranscriptItem[] = applyEnvelope([], running, 'claude');
    items = applyEnvelope(items, done, 'claude');

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'agent-spawn',
      id: 'tool-agent-1',
      provider: 'claude',
      agentId: 'native-agent-1',
      taskId: 'task-1',
      description: 'Inspect tests',
      status: 'done',
      output: 'No failures found.',
      background: true,
      input: { prompt: 'Inspect every reducer test.' },
      completedAt: 200,
    });
  });

  it('removes terminal agents when their turn ends but keeps running agents', () => {
    const completed = agent({ status: 'done', turn: 1, updatedAt: 150 });
    const stillRunning = agent({
      id: 'agent-running',
      status: 'running',
      turn: 1,
      updatedAt: 160,
    });
    const turnEnd: TranscriptItem = {
      kind: 'turn-end',
      id: 'turn-end-1',
      text: 'Turn 1 · complete',
      ts: 200,
      turn: 1,
    };

    const sameTurn = projectSessionContext({
      items: [completed, stillRunning],
      sessionId: 'session-1',
    });
    expect(sameTurn.agents.map(item => item.id)).toEqual([
      'agent-running',
      'agent-1',
    ]);

    const nextTurnWithoutCompletion: TranscriptItem = {
      kind: 'user',
      id: 'user-turn-2',
      text: 'Retry after an interrupted turn',
      ts: 180,
      turn: 2,
    };
    expect(projectSessionContext({
      items: [completed, stillRunning, nextTurnWithoutCompletion],
      sessionId: 'session-1',
    }).agents.map(item => item.id)).toEqual([
      'agent-running',
      'agent-1',
    ]);

    const afterTurn = projectSessionContext({
      items: [completed, stillRunning, turnEnd],
      sessionId: 'session-1',
    });
    expect(afterTurn.agents.map(item => item.id)).toEqual(['agent-running']);

    const history = projectSessionContext({
      items: [completed, stillRunning, turnEnd],
      sessionId: 'session-1',
      includeAgentHistory: true,
    });
    expect(history.agents).toHaveLength(2);
  });
});

describe('PlanChip persistent Agent runs panel', () => {
  it('shows provider-native agent metadata in a single expandable panel', async () => {
    const user = userEvent.setup();
    render(
      <PlanChip
        sessionId="session-1"
        items={[
          agent(),
          agent({
            id: 'agent-2',
            provider: 'codex',
            description: 'Review reducer behavior',
            status: 'done',
            output: 'Reducer is stable.',
            updatedAt: 200,
          }),
        ]}
      />,
    );

    const trigger = screen.getByRole('button', { name: /Agent/i });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('region', { name: 'Agent runs' })).toBeInTheDocument();
    expect(screen.getByText('Claude')).toBeInTheDocument();
    expect(screen.getByText('Codex')).toBeInTheDocument();
    expect(screen.getByText('Reducer is stable.')).toBeInTheDocument();
  });

  it('keeps the inline Plan and Agent panels mutually exclusive', async () => {
    const user = userEvent.setup();
    render(
      <PlanChip
        sessionId="session-1"
        planText={'## Plan\n- [ ] inspect'}
        items={[agent()]}
      />,
    );

    const planTrigger = screen.getByRole('button', { name: /Plan/i });
    const agentTrigger = screen.getByRole('button', { name: /Agent/i });
    await user.click(planTrigger);
    expect(screen.getByRole('region', { name: 'Plan' })).toBeInTheDocument();

    await user.click(agentTrigger);
    expect(screen.queryByRole('region', { name: 'Plan' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Agent runs' })).toBeInTheDocument();
    expect(planTrigger).toHaveAttribute('aria-expanded', 'false');
    expect(agentTrigger).toHaveAttribute('aria-expanded', 'true');
  });
});
