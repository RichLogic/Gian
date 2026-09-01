import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session } from '@gian/shared';

import { Composer } from '../src/components/Composer.js';
import { clearComposerCapabilityCaches } from '../src/components/composer/capabilities.js';
import { LocaleProvider } from '../src/i18n/index.js';

interface DeferredResolve {
  params: {
    catalogRevision: string;
    turnConfig: Record<string, unknown>;
    sessionId?: string;
  };
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

const hoisted = vi.hoisted(() => {
  const resolveCalls: Array<{
    params: {
      catalogRevision: string;
      turnConfig: Record<string, unknown>;
      sessionId?: string;
    };
    resolve(value: unknown): void;
    reject(error: unknown): void;
  }> = [];
  const loadResolvedProxyCatalogMock = vi.fn((executor: unknown, params: {
    catalogRevision: string;
    turnConfig: Record<string, unknown>;
    sessionId?: string;
  }) => {
    void executor;
    return new Promise((resolve, reject) => {
      resolveCalls.push({
        params,
        resolve: value => resolve(value),
        reject: error => reject(error),
      });
    });
  });
  const CATALOG_PAYLOAD = {
    catalogRevision: 'rev-1',
    input: [{ type: 'text' }],
    slashCommands: [],
    capabilities: { 'catalog.resolve': 1 },
    specialCatalogs: { model: 'model', thinking: 'thinking' },
    configOptions: [
      {
        id: 'model',
        displayName: 'Model',
        binding: 'turn',
        role: 'model',
        control: 'select',
        required: false,
        defaultValue: 'model-a',
        choices: [
          { value: 'model-a', displayName: 'Model A' },
          { value: 'model-b', displayName: 'Model B' },
        ],
      },
      {
        id: 'thinking',
        displayName: 'Thinking',
        binding: 'turn',
        role: 'effort',
        control: 'select',
        required: false,
        defaultValue: 'stale-a',
        choices: [
          { value: 'stale-a', displayName: 'Stale A' },
          { value: 'slow-a', displayName: 'Slow A' },
        ],
      },
    ],
  };
  const resolvedCatalog = (effort: string) => ({
    catalogRevision: 'rev-1',
    input: [{ type: 'text' }],
    slashCommands: [],
    configOptions: [
      CATALOG_PAYLOAD.configOptions[0],
      {
        ...CATALOG_PAYLOAD.configOptions[1],
        defaultValue: effort,
        choices: [{ value: effort, displayName: effort }],
      },
    ],
    specialCatalogs: CATALOG_PAYLOAD.specialCatalogs,
    resolvedDefaults: { sessionConfig: {}, turnConfig: { thinking: effort } },
  });
  return { resolveCalls, loadResolvedProxyCatalogMock, CATALOG_PAYLOAD, resolvedCatalog };
});

const resolveCalls = hoisted.resolveCalls;
const loadResolvedProxyCatalogMock = hoisted.loadResolvedProxyCatalogMock;
const CATALOG_PAYLOAD = hoisted.CATALOG_PAYLOAD;
const resolvedCatalog = hoisted.resolvedCatalog;

vi.mock('../src/api.js', () => ({
  loadProxyModels: vi.fn().mockResolvedValue([]),
  loadProxyCapabilities: vi.fn().mockResolvedValue(hoisted.CATALOG_PAYLOAD),
  loadResolvedProxyCatalog: (...args: unknown[]) => hoisted.loadResolvedProxyCatalogMock(...args),
  loadSlashCommands: vi.fn().mockResolvedValue([]),
  loadSessionSlashCommands: vi.fn().mockResolvedValue([]),
  loadNativeConfig: vi.fn().mockResolvedValue(null),
}));

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    name: 'resolve-race',
    type: 'coding',
    task_id: null,
    workspace_id: 'workspace-1',
    executor: 'kimi',
    model: 'model-a',
    approval_mode: null,
    thinking_effort: 'stale-a',
    active_channel: 'web',
    status: 'idle',
    archived: 0,
    pinned_at: null,
    unread: 0,
    worktree_path: null,
    branch: null,
    base_branch: null,
    worktree_outcome: null,
    native_session_id: 'native-1',
    service_tier: null,
    executor_config: { schemaVersion: 1, values: {} },
    native_config_options: [],
    turn_config: { model: 'model-a', thinking: 'stale-a' },
    created_at: '2026-08-30T00:00:00.000Z',
    updated_at: '2026-08-30T00:00:00.000Z',
    ...overrides,
  } as unknown as Session;
}

function composerElement(session: Session) {
  return (
    <LocaleProvider locale="en">
      <Composer
        session={session}
        executor={session.executor}
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
        onSetTurnConfig={vi.fn()}
        onSetServiceTier={vi.fn()}
      />
    </LocaleProvider>
  );
}

async function thinkingChip(): Promise<HTMLElement> {
  return await screen.findByTestId('composer-thinking-chip');
}

async function openEffortMenu(): Promise<HTMLElement> {
  await userEvent.setup().click(screen.getByTestId('composer-thinking-chip'));
  return await screen.findByText('Reasoning effort', { selector: '.think-pop .mp-section-title' })
    .then(() => document.querySelector('.think-pop')!);
}

async function openModelMenuAndPick(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByTestId('composer-model-chip'));
  const row = await screen.findByText(label, { selector: '.model-pop .mp-row-title' });
  await user.click(row.closest('button')!);
}

beforeEach(() => {
  clearComposerCapabilityCaches();
  resolveCalls.length = 0;
  loadResolvedProxyCatalogMock.mockClear();
});

describe('Composer model resolve fencing (Finding: missing web evidence)', () => {
  it('sends the model change without the previous model effort', async () => {
    const user = userEvent.setup();
    render(composerElement(makeSession()));
    await waitFor(() => expect(screen.getByTestId('composer-model-chip')).toBeEnabled());
    await openModelMenuAndPick(user, 'Model B');
    await waitFor(() => expect(resolveCalls.length).toBe(1));
    // The stale effort of model-a must not ride along with the model change.
    expect(resolveCalls[0]!.params.turnConfig).toEqual({ model: 'model-b' });
  });

  it('an older resolve response arriving late cannot override the newer menu', async () => {
    const user = userEvent.setup();
    render(composerElement(makeSession()));
    await waitFor(() => expect(screen.getByTestId('composer-model-chip')).toBeEnabled());
    await openModelMenuAndPick(user, 'Model A'); // gen 1 → Slow A overlay pending
    await openModelMenuAndPick(user, 'Model B'); // gen 2 → Fast B overlay pending
    await waitFor(() => expect(resolveCalls.length).toBe(2));
    // Out-of-order completion: the NEWER selection settles first, then the
    // OLDER response arrives and must be dropped.
    resolveCalls[1]!.resolve(resolvedCatalog('fast-b'));
    resolveCalls[0]!.resolve(resolvedCatalog('slow-a'));
    // The newer overlay wins: the effort menu offers the B-model choices and
    // the stale A response's choices never appear.
    const menu = await openEffortMenu();
    await waitFor(() => {
      expect(menu.textContent).toContain('Fast B');
    });
    expect(menu.textContent).not.toContain('Slow A');
    expect(menu.textContent).not.toContain('Stale A');
  });

  it('the latest failed resolve shows its error and keeps the previous menu', async () => {
    const user = userEvent.setup();
    render(composerElement(makeSession()));
    await waitFor(() => expect(screen.getByTestId('composer-model-chip')).toBeEnabled());
    expect(await thinkingChip()).toHaveTextContent('Stale A');
    await openModelMenuAndPick(user, 'Model A'); // gen 1
    await openModelMenuAndPick(user, 'Model B'); // gen 2
    await waitFor(() => expect(resolveCalls.length).toBe(2));
    resolveCalls[1]!.reject(new Error('resolve exploded'));
    await waitFor(() => expect(screen.getByText(/resolve exploded/)).toBeTruthy());
    expect(await thinkingChip()).toHaveTextContent('Stale A');
    // The stale older response settles successfully afterwards and must not
    // overwrite either the error or the previous menu.
    resolveCalls[0]!.resolve(resolvedCatalog('slow-a'));
    await waitFor(async () => {
      expect(await thinkingChip()).toHaveTextContent('Stale A');
    });
    expect(screen.getByText(/resolve exploded/)).toBeTruthy();
    expect(screen.queryByText(/Slow A/)).toBeNull();
  });

  it('an older failure does not clobber a newer successful resolve', async () => {
    const user = userEvent.setup();
    render(composerElement(makeSession()));
    await waitFor(() => expect(screen.getByTestId('composer-model-chip')).toBeEnabled());
    await openModelMenuAndPick(user, 'Model A'); // gen 1
    await openModelMenuAndPick(user, 'Model B'); // gen 2
    await waitFor(() => expect(resolveCalls.length).toBe(2));
    resolveCalls[0]!.reject(new Error('older failure'));
    resolveCalls[1]!.resolve(resolvedCatalog('fast-b'));
    const menu = await openEffortMenu();
    await waitFor(() => {
      expect(menu.textContent).toContain('Fast B');
    });
    expect(screen.queryByText(/older failure/)).toBeNull();
  });

  it('a stale resolve from a previous session never writes the new overlay', async () => {
    const user = userEvent.setup();
    const view = render(composerElement(makeSession()));
    await waitFor(() => expect(screen.getByTestId('composer-model-chip')).toBeEnabled());
    await openModelMenuAndPick(user, 'Model A'); // gen 1, still in flight
    await waitFor(() => expect(resolveCalls.length).toBe(1));
    expect(resolveCalls[0]!.params.sessionId).toBe('session-1');

    view.rerender(composerElement(makeSession({ id: 'session-2', native_session_id: 'native-2' })));
    resolveCalls[0]!.resolve(resolvedCatalog('slow-a'));
    await waitFor(async () => {
      expect(await thinkingChip()).toHaveTextContent('Stale A');
    });
    // The old session's response must not leak into the new session's chip.
    expect(screen.queryByText(/Slow A/)).toBeNull();
  });
});
