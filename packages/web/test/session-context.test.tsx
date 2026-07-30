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

  it('upserts agent lifecycle events instead of adding duplicate transcript rows', () => {
    const running: EventEnvelope = {
      session_id: 'session-1',
      turn: 2,
      call_id: 'tool-agent-1',
      event: 'agent_spawn',
      ts: 100,
      data: {
        agentId: 'native-agent-1',
        description: 'Inspect tests',
        status: 'running',
        agentType: 'Explore',
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
      description: 'Inspect tests',
      status: 'done',
      output: 'No failures found.',
      completedAt: 200,
    });
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
});
