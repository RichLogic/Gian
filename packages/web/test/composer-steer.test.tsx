// Coverage for traceability rows:
//   QUEUE-004 — Codex busy composer: ⌘/Ctrl+Enter steers the draft into the
//               active turn; other executors keep queue semantics.
//
// The host-side steer/drain plumbing is pinned by
// `packages/host/test/queue-and-busy.test.ts` (QUEUE-004). This file pins the
// composer keyboard semantics.

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Executor, Session } from '@gian/shared';

import { Composer } from '../src/components/Composer.js';
import { LocaleProvider } from '../src/i18n/index.js';

vi.mock('../src/api.js', () => ({
  loadProxyModels: vi.fn(async () => [{
    id: 'gpt-5.6-sol',
    model: 'gpt-5.6-sol',
    displayName: 'GPT-5.6-Sol',
    description: '',
    hidden: false,
    isDefault: true,
    defaultThinking: 'medium',
    supportedThinking: ['medium'],
  }]),
  loadSlashCommands: vi.fn().mockResolvedValue([]),
  loadSessionSlashCommands: vi.fn().mockResolvedValue([]),
  loadNativeConfig: vi.fn().mockResolvedValue(null),
}));

function makeSession(executor: Executor, overrides: Partial<Session> = {}): Session {
  return {
    id: `session-${executor}`,
    name: executor,
    type: 'coding',
    workspace_id: 'workspace-1',
    executor,
    model: 'gpt-5.6-sol',
    approval_mode: 'ask',
    thinking_effort: 'medium',
    turns: 1,
    active_channel: 'web',
    status: 'running',
    archived: 0,
    worktree_path: null,
    branch: null,
    base_branch: null,
    worktree_outcome: null,
    native_session_id: `native-${executor}`,
    runtime_mode: 'structured',
    service_tier: null,
    executor_config: { schemaVersion: 1, values: {} },
    native_config_options: [],
    created_at: '2026-07-29T00:00:00.000Z',
    updated_at: '2026-07-29T00:00:00.000Z',
    ...overrides,
  } as Session;
}

function renderComposer(
  session: Session,
  extras: Partial<React.ComponentProps<typeof Composer>> = {},
) {
  const callbacks = {
    onSend: vi.fn(),
    onSendSkill: vi.fn(),
    onStop: vi.fn(),
    onQueueAdd: vi.fn(),
    onSteer: vi.fn(),
    onSetMode: vi.fn(),
    onSetModel: vi.fn(),
    onSetEffort: vi.fn(),
    onSetNativeConfig: vi.fn(),
    onSetServiceTier: vi.fn(),
  };
  render(
    <LocaleProvider locale="en">
      <Composer
        session={session}
        executor={session.executor}
        workspaceId={session.workspace_id}
        disabled
        running
        {...callbacks}
        {...extras}
      />
    </LocaleProvider>,
  );
  return callbacks;
}

describe('QUEUE-004: composer ⌘/Ctrl+Enter steer semantics', () => {
  it('codex busy + draft + Ctrl+Enter steers the draft (no queue)', async () => {
    const user = userEvent.setup();
    const callbacks = renderComposer(makeSession('codex'));

    await user.type(screen.getByRole('textbox'), 'focus on tests first');
    await user.keyboard('{Control>}{Enter}{/Control}');

    expect(callbacks.onSteer).toHaveBeenCalledWith('focus on tests first', undefined);
    expect(callbacks.onQueueAdd).not.toHaveBeenCalled();
    expect(callbacks.onSend).not.toHaveBeenCalled();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
  });

  it('codex busy + NO draft + Ctrl+Enter does not steer or queue (bubbles to queue drain)', async () => {
    const user = userEvent.setup();
    const callbacks = renderComposer(makeSession('codex'));

    screen.getByRole('textbox').focus();
    await user.keyboard('{Control>}{Enter}{/Control}');

    expect(callbacks.onSteer).not.toHaveBeenCalled();
    expect(callbacks.onQueueAdd).not.toHaveBeenCalled();
    expect(callbacks.onSend).not.toHaveBeenCalled();
  });

  it('claude busy + draft + Ctrl+Enter still queues (no steer primitive)', async () => {
    const user = userEvent.setup();
    const callbacks = renderComposer(makeSession('claude'));

    await user.type(screen.getByRole('textbox'), 'queue me');
    await user.keyboard('{Control>}{Enter}{/Control}');

    expect(callbacks.onQueueAdd).toHaveBeenCalledWith('queue me', []);
    expect(callbacks.onSteer).not.toHaveBeenCalled();
  });

  it('codex idle + draft + Ctrl+Enter sends normally', async () => {
    const user = userEvent.setup();
    const callbacks = renderComposer(makeSession('codex'), { disabled: false, running: false });

    await user.type(screen.getByRole('textbox'), 'send me');
    await user.keyboard('{Control>}{Enter}{/Control}');

    expect(callbacks.onSend).toHaveBeenCalledWith('send me', undefined);
    expect(callbacks.onSteer).not.toHaveBeenCalled();
  });
});
