import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Executor, Session } from '@gian/shared';

import { Composer } from '../src/components/Composer.js';
import { LocaleProvider } from '../src/i18n/index.js';

vi.mock('../src/api.js', () => ({
  loadProxyModels: vi.fn().mockRejectedValue(new Error('host unavailable')),
  loadSlashCommands: vi.fn().mockRejectedValue(new Error('host unavailable')),
  loadSessionSlashCommands: vi.fn().mockRejectedValue(new Error('host unavailable')),
  loadNativeConfig: vi.fn().mockRejectedValue(new Error('host unavailable')),
}));

function makeSession(executor: Executor): Session {
  return {
    id: `failure-${executor}`,
    name: executor,
    type: 'coding',
    workspace_id: 'workspace-1',
    executor,
    model: executor === 'codex' ? 'gpt-5.6-sol' : executor === 'claude' ? 'sonnet' : null,
    approval_mode: executor === 'kimi' ? null : 'ask',
    thinking_effort: executor === 'kimi' ? null : 'high',
    turns: 1,
    active_channel: 'web',
    status: 'idle',
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
  } as Session;
}

function renderComposer(executor: Executor) {
  const session = makeSession(executor);
  render(
    <LocaleProvider locale="en">
      <Composer
        session={session}
        executor={executor}
        workspaceId={session.workspace_id}
        disabled={false}
        running={false}
        onSend={vi.fn()}
        onSendSkill={vi.fn()}
        onStop={vi.fn()}
        onQueueAdd={vi.fn()}
        onSetMode={vi.fn()}
        onSetModel={vi.fn()}
        onSetEffort={vi.fn()}
        onSetNativeConfig={vi.fn()}
        onSetServiceTier={vi.fn()}
      />
    </LocaleProvider>,
  );
}

describe('Composer capability failures', () => {
  it.each(['claude', 'codex', 'kimi'] as const)(
    'keeps a %s session usable when capability/config discovery fails',
    async executor => {
      renderComposer(executor);

      expect(screen.getByRole('textbox')).toBeTruthy();
      await waitFor(() => {
        expect(screen.getByRole('textbox')).toBeEnabled();
      });
    },
  );
});
