import { describe, expect, it } from 'vitest';
import { projectSessionContext } from '../src/presentation/session-context.js';
import type { AgentSpawnItem, TranscriptItem } from '../src/types.js';

function spawn(overrides: Partial<AgentSpawnItem> = {}): AgentSpawnItem {
  return {
    kind: 'agent-spawn',
    id: 'spawn-unit',
    provider: 'kimi',
    description: '',
    status: 'running',
    startedAt: 5,
    updatedAt: 5,
    ts: 5,
    turn: 2,
    ...overrides,
  };
}

describe('projectSessionContext', () => {
  it('returns empty counts when there is no plan or agent', () => {
    const projected = projectSessionContext({ items: [], sessionId: 'ctx-1' });
    expect(projected.plan).toBeNull();
    expect(projected.agents).toEqual([]);
    expect(projected.runningAgents).toBe(0);
    expect(projected.completedAgents).toBe(0);
    expect(projected.failedAgents).toBe(0);
    expect(projected.interruptedAgents).toBe(0);
  });

  it('counts checklist progress from [X] and [x] markers', () => {
    const projected = projectSessionContext({
      items: [],
      sessionId: 'ctx-1',
      planText: '- [X] one\n- [ ] two\n- [x] three',
    });
    expect(projected.plan).toMatchObject({
      id: 'codex-plan-ctx-1',
      status: 'active',
      completedSteps: 2,
      totalSteps: 3,
    });
  });

  it('fills an empty agent description from input.prompt', () => {
    const items: TranscriptItem[] = [
      spawn({ input: { prompt: '  scan the lockfile  ' } }),
    ];
    const projected = projectSessionContext({
      items,
      sessionId: 'ctx-1',
      includeAgentHistory: true,
    });
    expect(projected.agents[0]?.description).toBe('scan the lockfile');
    expect(projected.runningAgents).toBe(1);
  });

  it('hides a completed plan that has no lifecycle turn', () => {
    const projected = projectSessionContext({
      items: [],
      sessionId: 'ctx-1',
      planText: 'ship it',
      planCompleted: true,
    });
    expect(projected.plan).toBeNull();
  });
});
