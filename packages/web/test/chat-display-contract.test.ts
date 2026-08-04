import { describe, expect, it } from 'vitest';
import type { ChatDisplay, EventEnvelope, Executor } from '@gian/shared';
import {
  applyEnvelope,
  applyPlanLifecycle,
  nextPendingFromEnvelope,
} from '../src/transcript/apply.js';

function nativeEnvelope(
  provider: Executor,
  event: string,
  display: ChatDisplay,
): EventEnvelope {
  return {
    session_id: 'session-1',
    turn: 1,
    call_id: 'call-1',
    event,
    provider,
    ts: 1,
    // Intentionally unrelated: renderers must use display.data, not raw data.
    data: { nativeShape: true },
    display,
  };
}

describe('provider-native event → page display contract', () => {
  it('renders Message from a Claude-native event name', () => {
    const env = nativeEnvelope('claude', 'output.text', {
      type: 'message',
      data: { text: 'hello', delta: false, itemId: 'message-1' },
    });
    expect(applyEnvelope([], env, 'claude')).toMatchObject([
      { kind: 'assistant', id: 'message-1', text: 'hello' },
    ]);
  });

  it('renders Activity from a Kimi ACP event without renaming the event', () => {
    const env = nativeEnvelope('kimi', 'acp.sessionUpdate', {
      type: 'activity.command',
      data: { command: 'pnpm test', status: 'running', itemId: 'tool-1' },
    });
    expect(env.event).toBe('acp.sessionUpdate');
    expect(applyEnvelope([], env, 'kimi')).toMatchObject([
      { kind: 'command', id: 'tool-1', command: 'pnpm test' },
    ]);
  });

  it('routes Plan to page state rather than the transcript', () => {
    const env = nativeEnvelope('codex', 'output.plan.final', {
      type: 'plan',
      data: { text: '- [ ] inspect', delta: false },
    });
    expect(applyEnvelope([], env, 'codex')).toEqual([]);
    expect(applyPlanLifecycle({ completed: false }, env)).toEqual({
      text: '- [ ] inspect',
      completed: false,
    });
  });

  it('renders Agent as a persistent agent row', () => {
    const env = nativeEnvelope('codex', 'codex.agent', {
      type: 'agent',
      data: { agentId: 'child-1', description: 'Inspect tests', status: 'running' },
    });
    expect(applyEnvelope([], env, 'codex')).toMatchObject([
      { kind: 'agent-spawn', agentId: 'child-1', description: 'Inspect tests' },
    ]);
  });

  it('renders Interaction/Question with the question card data', () => {
    const env = nativeEnvelope('claude', 'approval.requested', {
      type: 'interaction.question',
      data: {
        approvalId: 'question-1',
        category: 'question',
        risk: 'low',
        title: 'Pick one',
        description: '',
        scopeOptions: ['once'],
        questions: [{ question: 'Pick one', multiSelect: false, options: [{ label: 'A' }] }],
      },
    });
    expect(applyEnvelope([], env, 'claude')).toMatchObject([
      { kind: 'approval', category: 'question', approvalId: 'question-1' },
    ]);
  });

  it('uses State projections for pending lifecycle', () => {
    const started = nativeEnvelope('kimi', 'turn.started', {
      type: 'state.turn-started',
      data: { turnId: 'turn-1' },
    });
    const done = nativeEnvelope('kimi', 'turn.completed', {
      type: 'state.turn-completed',
      data: { turnId: 'turn-1' },
    });
    expect(nextPendingFromEnvelope(started)).toBe(true);
    expect(nextPendingFromEnvelope(done)).toBe(false);
  });

  it('ignores native events without a display projection', () => {
    const env = nativeEnvelope('codex', 'future.cli.event', {
      type: 'activity.tool',
      data: { itemId: 'future', title: 'Future', status: 'running' },
    });
    delete env.display;
    expect(applyEnvelope([], env, 'codex')).toEqual([]);
  });
});
