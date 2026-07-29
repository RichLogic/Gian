import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Session } from '@gian/shared';

import { ContextUsageIndicator } from '../src/components/Composer.js';
import { LocaleProvider } from '../src/i18n/index.js';

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-usage',
    name: 'Usage',
    type: 'coding',
    task_id: null,
    workspace_id: 'workspace-1',
    executor: 'codex',
    model: 'gpt-5.6-sol',
    approval_mode: 'ask',
    executor_config: { schemaVersion: 1, values: {} },
    native_config_options: [],
    thinking_effort: 'high',
    service_tier: null,
    turns: 1,
    active_channel: 'web',
    status: 'done',
    archived: 0,
    unread: 0,
    worktree_path: null,
    branch: null,
    base_branch: null,
    worktree_outcome: null,
    native_session_id: 'native-usage',
    runtime_mode: 'structured',
    summary: null,
    completed_at: null,
    created_at: '2026-07-29T00:00:00.000Z',
    updated_at: '2026-07-29T00:00:00.000Z',
    ...overrides,
  };
}

function renderIndicator(value: Session) {
  render(
    <LocaleProvider locale="en">
      <ContextUsageIndicator session={value} />
    </LocaleProvider>,
  );
}

describe('ContextUsageIndicator', () => {
  it('shows only a ring until hover, then current context and complete totals', () => {
    renderIndicator(session({
      context_tokens_used: 64_500,
      context_window_tokens: 258_000,
      context_usage_updated_at: '2026-07-29T01:00:00.000Z',
      conversation_input_tokens: 1_100_000,
      conversation_output_tokens: 29_236,
      conversation_cached_input_tokens: 900_000,
      conversation_total_tokens: 1_129_236,
      conversation_usage_complete: 1,
    }));

    expect(screen.queryByText('Context window')).toBeNull();
    const ring = screen.getByRole('img', { name: /25% used/i });
    fireEvent.mouseEnter(ring);

    expect(screen.getByText('Context window')).toBeTruthy();
    expect(screen.getByText('25% used (75% left)')).toBeTruthy();
    expect(screen.getByText('65k / 258k tokens used')).toBeTruthy();
    expect(screen.getByText('Conversation total')).toBeTruthy();
    expect(screen.getByText(/1,129,236 tokens/)).toBeTruthy();
  });

  it('omits partial adopted-session totals and marks compact invalidation', () => {
    renderIndicator(session({
      context_tokens_used: null,
      context_window_tokens: 258_000,
      context_usage_updated_at: '2026-07-29T01:00:00.000Z',
      conversation_total_tokens: 99_000,
      conversation_usage_complete: 0,
    }));

    const ring = screen.getByRole('img', { name: /Recalculating after compaction/i });
    fireEvent.focus(ring);
    expect(screen.getByText('Recalculating after compaction…')).toBeTruthy();
    expect(screen.queryByText('Conversation total')).toBeNull();
  });
});
