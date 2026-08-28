// Coverage for traceability rows:
//   QUEUE-004 — Busy composer with `turn.steer`: ⌘/Ctrl+Enter steers the
//               draft into the active turn; composers without steer keep
//               queue semantics.
//
// The host-side steer/drain plumbing is pinned by
// `packages/host/test/queue-and-busy.test.ts` (QUEUE-004). This file pins the
// composer keyboard semantics.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Executor, Session } from '@gian/shared';

import { Composer } from '../src/components/Composer.js';
import { clearComposerCapabilityCaches } from '../src/components/composer/capabilities.js';
import { LocaleProvider } from '../src/i18n/index.js';
import { loadProxyCapabilities } from '../src/api.js';
import { typeInlineComposer } from './inline-composer-test-utils.js';

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
  loadProxyCapabilities: vi.fn(async () => ({})),
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
    active_channel: 'web',
    status: 'running',
    archived: 0,
    worktree_path: null,
    branch: null,
    base_branch: null,
    worktree_outcome: null,
    native_session_id: `native-${executor}`,
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
  beforeEach(() => {
    clearComposerCapabilityCaches();
    vi.mocked(loadProxyCapabilities).mockReset().mockResolvedValue({});
  });

  it('codex busy + draft + Ctrl+Enter steers the draft (no queue)', async () => {
    const user = userEvent.setup();
    const callbacks = renderComposer(makeSession('codex'));

    typeInlineComposer(screen.getByRole('textbox'), 'focus on tests first');
    await user.keyboard('{Control>}{Enter}{/Control}');

    expect(callbacks.onSteer).toHaveBeenCalledWith('focus on tests first', undefined);
    expect(callbacks.onQueueAdd).not.toHaveBeenCalled();
    expect(callbacks.onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox')).toHaveTextContent('');
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
    const callbacks = renderComposer(makeSession('claude'), { canSteer: false });

    typeInlineComposer(screen.getByRole('textbox'), 'queue me');
    await user.keyboard('{Control>}{Enter}{/Control}');

    expect(callbacks.onQueueAdd).toHaveBeenCalledWith('queue me', [], undefined, undefined);
    expect(callbacks.onSteer).not.toHaveBeenCalled();
  });

  it('advertised turn.steer lets grok steer without an explicit canSteer prop', async () => {
    const user = userEvent.setup();
    vi.mocked(loadProxyCapabilities).mockResolvedValue({
      capabilities: { 'turn.steer': 1 },
    });
    const callbacks = renderComposer(makeSession('grok'));

    await waitFor(() => {
      expect(vi.mocked(loadProxyCapabilities)).toHaveBeenCalled();
    });
    typeInlineComposer(screen.getByRole('textbox'), 'steer from catalog');
    await user.keyboard('{Control>}{Enter}{/Control}');

    expect(callbacks.onSteer).toHaveBeenCalledWith('steer from catalog', undefined);
    expect(callbacks.onQueueAdd).not.toHaveBeenCalled();
  });

  it('any executor with canSteer + busy + draft + Ctrl+Enter steers', async () => {
    const user = userEvent.setup();
    const callbacks = renderComposer(makeSession('grok'), { canSteer: true });

    typeInlineComposer(screen.getByRole('textbox'), 'steer from capability');
    await user.keyboard('{Control>}{Enter}{/Control}');

    expect(callbacks.onSteer).toHaveBeenCalledWith('steer from capability', undefined);
    expect(callbacks.onQueueAdd).not.toHaveBeenCalled();
  });

  it('codex idle + draft + Ctrl+Enter sends normally', async () => {
    const user = userEvent.setup();
    const callbacks = renderComposer(makeSession('codex'), { disabled: false, running: false });

    typeInlineComposer(screen.getByRole('textbox'), 'send me');
    await user.keyboard('{Control>}{Enter}{/Control}');

    expect(callbacks.onSend).toHaveBeenCalledWith('send me', undefined);
    expect(callbacks.onSteer).not.toHaveBeenCalled();
  });
});
