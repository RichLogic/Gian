/**
 * Phase 3b Settings/Agent/Git/Native/Files/Terminal operations on the real
 * product definitions (`src/operations/{settings,agents,git,native,files,
 *terminal}.ts`), proving the proposal §8 contract per migrated class:
 *
 * - settings.save: optimistic overlay committed BEFORE the REST promise
 *   settles, absorption + canonical sink on success, owned rollback + a
 *   visible toast on failure;
 * - agent install: pending busy → confirmed with the entity as run.result;
 * - git stage/unstage/fetch: pending lifecycle; stage/unstage failures toast
 *   (no inline surface), fetch failures do not (the pane renders inline);
 * - native adopt/delete: pending lifecycle, adopted session as run.result;
 * - files.openExternal: launch failure surfaced via toast;
 * - term.spawn/term.close: pending lifecycle over a fake WS transport with
 *   request_id correlation and the duplicate pending guard.
 */
import { waitFor } from '@testing-library/react';
import type { Session, SystemConfig } from '@gian/shared';
import { DEFAULT_TERMINAL_PREFERENCES } from '@gian/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../src/api.js';
import { __resetFeedback, getSnapshot } from '../src/feedback.js';
import { agentEntityKey } from '../src/operations/agents.js';
import { gitIndexEntityKey } from '../src/operations/git.js';
import { SETTINGS_ENTITY_KEY, wireSettingsSink } from '../src/operations/settings.js';
import { createOperationDispatcher, type OperationDispatcher } from '../src/operations/dispatcher.js';
import { createOperationStore, entityFieldKey, type OperationStore } from '../src/operations/store.js';
import { FakeOperationTransport } from './operation-test-utils.js';

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    saveSettings: vi.fn(),
    installAgentCli: vi.fn(),
    installAgentProxy: vi.fn(),
    fetchRemotes: vi.fn(),
    stageFile: vi.fn(),
    unstageFile: vi.fn(),
    adoptNativeSession: vi.fn(),
    deleteNativeSession: vi.fn(),
    openFileWith: vi.fn(),
  };
});

function config(overrides: Partial<SystemConfig> = {}): SystemConfig {
  return {
    host: '127.0.0.1', port: 8991, workspace_root: '~/Coding',
    theme: 'warm', accent: 'ember', density: 'cozy', locale: 'en',
    font_scale_chrome: 'md', font_scale_chat: 'md', font_scale_code: 'md',
    chat_font_size: 14, chat_font_family: 'system',
    terminal: { ...DEFAULT_TERMINAL_PREFERENCES },
    default_claude_model: '', default_claude_effort: '',
    default_codex_model: '', default_codex_effort: '',
    auth_username: '', external_editors: [],
    ...overrides,
  };
}

function agentStatus(id: string) {
  return {
    id,
    name: id,
    ready: true,
    cli: { state: 'ready', path: `/bin/${id}`, version: '1.0.0', source: 'path' },
    proxy: { state: 'ready', path: `/proxy/${id}`, version: '0.1.0', source: 'github-release', defaults: { model: '', thinking: '', mode: '' } },
    officialInstallUrl: 'https://example.invalid',
  } as Awaited<ReturnType<typeof api.loadAgents>>[number];
}

function adoptedSession(id: string): Session {
  return { id, name: 'adopted' } as unknown as Session;
}

/** Deferred promise handle for controlling settle timing in a test. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('Phase 3b settings/files operations', () => {
  let store: OperationStore;
  let transport: FakeOperationTransport;
  let dispatcher: OperationDispatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    store = createOperationStore();
    transport = new FakeOperationTransport();
    dispatcher = createOperationDispatcher({
      store,
      transport,
      readCanonicalField: (entityKey, field) =>
        entityKey === SETTINGS_ENTITY_KEY ? config()[field as keyof SystemConfig] : undefined,
    });
  });

  afterEach(() => {
    dispatcher.dispose();
    wireSettingsSink(null);
    __resetFeedback();
  });

  it('settings.save writes the overlay synchronously, absorbs on success, and patches canonical state', async () => {
    const saved: SystemConfig[] = [];
    wireSettingsSink({ saved: cfg => saved.push(cfg) });
    const pending = deferred<SystemConfig>();
    vi.mocked(api.saveSettings).mockImplementation(() => pending.promise);

    const run = dispatcher.dispatch('settings.save', { patch: { theme: 'dark' } });

    // Local feedback BEFORE the transport promise resolves (proposal §2/§8):
    // the overlay is committed in the dispatch task with the recorded prior
    // canonical value.
    expect(run.phase).toBe('optimistic');
    expect(api.saveSettings).toHaveBeenCalledWith({ theme: 'dark' });
    const overlay = store.getOverlay(entityFieldKey(SETTINGS_ENTITY_KEY, 'theme'));
    expect(overlay?.value).toBe('dark');
    expect(overlay?.previous).toBe('warm');

    pending.resolve(config({ theme: 'dark' }));
    await waitFor(() => expect(store.getRun(run.id)?.phase).toBe('confirmed'));
    // Success absorbs the overlay and the sink receives the canonical config.
    expect(store.getOverlay(entityFieldKey(SETTINGS_ENTITY_KEY, 'theme'))).toBeUndefined();
    expect(saved).toHaveLength(1);
    expect(saved[0]!.theme).toBe('dark');
  });

  it('settings.save rolls back only the failed run\'s overlay and surfaces a visible failure', async () => {
    const first = deferred<SystemConfig>();
    const second = deferred<SystemConfig>();
    vi.mocked(api.saveSettings)
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    // Two rapid writes to different fields; only the second one fails.
    const okRun = dispatcher.dispatch('settings.save', { patch: { theme: 'dark' } });
    const failedRun = dispatcher.dispatch('settings.save', { patch: { density: 'compact' } });
    first.resolve(config({ theme: 'dark' }));
    await waitFor(() => expect(store.getRun(okRun.id)?.phase).toBe('confirmed'));
    second.reject(new Error('Settings save failed'));
    await waitFor(() => expect(store.getRun(failedRun.id)?.phase).toBe('failed'));

    // The failed run's overlay is gone (the canonical value beneath — 'cozy'
    // here — is what rendering falls back to); the confirmed run's field was
    // already absorbed and is untouched by the other run's failure.
    expect(store.getOverlay(entityFieldKey(SETTINGS_ENTITY_KEY, 'density'))).toBeUndefined();
    expect(store.getOverlay(entityFieldKey(SETTINGS_ENTITY_KEY, 'theme'))).toBeUndefined();
    // Visible failure: an error toast carries the message.
    expect(getSnapshot().toasts.some(t => t.kind === 'error' && t.message === 'Settings save failed')).toBe(true);
  });

  it('settings.save rollback restores the prior value beneath the overlay', async () => {
    const pending = deferred<SystemConfig>();
    vi.mocked(api.saveSettings).mockImplementation(() => pending.promise);
    const run = dispatcher.dispatch('settings.save', { patch: { accent: 'ink' } });
    expect(store.getOverlay(entityFieldKey(SETTINGS_ENTITY_KEY, 'accent'))?.value).toBe('ink');
    pending.reject(new Error('Settings save failed'));
    await waitFor(() => expect(store.getRun(run.id)?.phase).toBe('failed'));
    // Overlay removed → rendering falls back to the recorded previous
    // ('ember'), i.e. the user sees their pre-click value again.
    expect(store.getOverlay(entityFieldKey(SETTINGS_ENTITY_KEY, 'accent'))).toBeUndefined();
  });

  it('agent.installCli is pending-busy until the REST settles, then confirmed with the agent entity', async () => {
    const pending = deferred<{ agent: ReturnType<typeof agentStatus> }>();
    vi.mocked(api.installAgentCli).mockImplementation(() => pending.promise);

    const run = dispatcher.dispatch('agent.installCli', { executor: 'claude' });
    // Busy state: an in-flight run on the agent entity, before the settle.
    expect(run.phase).toBe('pending');
    expect(
      store.getPendingRuns(agentEntityKey('claude')).some(r => r.name === 'agent.installCli'),
    ).toBe(true);

    pending.resolve({ agent: agentStatus('claude') });
    await waitFor(() => expect(store.getRun(run.id)?.phase).toBe('confirmed'));
    expect(store.getPendingRuns(agentEntityKey('claude'))).toHaveLength(0);
    expect(store.getRun(run.id)?.result).toEqual(agentStatus('claude'));
  });

  it('git.stage is pending until the index write settles; a failure toasts', async () => {
    const pending = deferred<boolean>();
    vi.mocked(api.stageFile).mockImplementation(() => pending.promise);

    const run = dispatcher.dispatch('git.stage', { workingTreeId: 'ws:w1', path: 'src/a.ts' });
    expect(run.phase).toBe('pending');
    expect(
      store.getPendingRuns(gitIndexEntityKey('ws:w1', 'src/a.ts')).some(r => r.name === 'git.stage'),
    ).toBe(true);
    pending.resolve(true);
    await waitFor(() => expect(store.getRun(run.id)?.phase).toBe('confirmed'));

    // Failure path: the host said no → run failed + visible toast (the
    // Changes inspector has no inline error surface).
    vi.mocked(api.stageFile).mockResolvedValue(false);
    const failed = dispatcher.dispatch('git.stage', { workingTreeId: 'ws:w1', path: 'src/b.ts' });
    await waitFor(() => expect(store.getRun(failed.id)?.phase).toBe('failed'));
    expect(getSnapshot().toasts.some(t => t.kind === 'error' && t.message === 'Stage failed')).toBe(true);
  });

  it('git.unstage and git.fetch run pending to confirmed; fetch carries fetchedAt and never toasts', async () => {
    vi.mocked(api.unstageFile).mockResolvedValue(true);
    const unstage = dispatcher.dispatch('git.unstage', { workingTreeId: 'ws:w1', path: 'src/a.ts' });
    await waitFor(() => expect(store.getRun(unstage.id)?.phase).toBe('confirmed'));

    vi.mocked(api.fetchRemotes).mockResolvedValue({ ok: true, fetchedAt: '2026-08-06T00:00:00Z' });
    const fetchRun = dispatcher.dispatch('git.fetch', { workspaceId: 'w1' });
    expect(fetchRun.phase).toBe('pending');
    await waitFor(() => expect(store.getRun(fetchRun.id)?.phase).toBe('confirmed'));
    expect(store.getRun(fetchRun.id)?.result).toEqual({ fetchedAt: '2026-08-06T00:00:00Z' });

    // Fetch failure: the run fails for the pane's inline error — NO toast
    // (the definition deliberately leaves surfacing to the view).
    vi.mocked(api.fetchRemotes).mockResolvedValue({ ok: false, error: 'remote unreachable' });
    const failed = dispatcher.dispatch('git.fetch', { workspaceId: 'w2' });
    await waitFor(() => expect(store.getRun(failed.id)?.phase).toBe('failed'));
    expect(store.getRun(failed.id)?.error).toBe('remote unreachable');
    expect(getSnapshot().toasts).toHaveLength(0);
  });

  it('native.adopt resolves the adopted session; native.delete failure is surfaced on the run', async () => {
    vi.mocked(api.adoptNativeSession).mockResolvedValue({ session: adoptedSession('s1') });
    const adopt = dispatcher.dispatch('native.adopt', {
      workspaceId: 'w1',
      executor: 'claude',
      nativeId: 'n1',
      request: { executor: 'claude', native_session_id: 'n1', approval_mode: 'ask' },
    });
    expect(adopt.phase).toBe('pending');
    await waitFor(() => expect(store.getRun(adopt.id)?.phase).toBe('confirmed'));
    expect((store.getRun(adopt.id)?.result as Session).id).toBe('s1');

    vi.mocked(api.deleteNativeSession).mockResolvedValue({ ok: false, error: 'Delete failed' });
    const del = dispatcher.dispatch('native.delete', { workspaceId: 'w1', executor: 'claude', nativeId: 'n1' });
    await waitFor(() => expect(store.getRun(del.id)?.phase).toBe('failed'));
    expect(store.getRun(del.id)?.error).toBe('Delete failed');
  });

  it('files.openExternal confirms on success and toasts the host error on a launch failure', async () => {
    vi.mocked(api.openFileWith).mockResolvedValue({ ok: true });
    const open = dispatcher.dispatch('files.openExternal', {
      workingTreeId: 'ws:w1',
      path: 'src/a.ts',
      target: { kind: 'editor', editorId: 'e1' },
    });
    await waitFor(() => expect(store.getRun(open.id)?.phase).toBe('confirmed'));
    expect(api.openFileWith).toHaveBeenCalledWith('ws:w1', 'src/a.ts', 'e1');

    vi.mocked(api.openFileWith).mockResolvedValue({ error: 'No such editor' });
    const failed = dispatcher.dispatch('files.openExternal', {
      workingTreeId: 'ws:w1',
      path: 'src/b.ts',
      target: { kind: 'editor', editorId: 'e2' },
    });
    await waitFor(() => expect(store.getRun(failed.id)?.phase).toBe('failed'));
    expect(getSnapshot().toasts.some(t => t.kind === 'error' && t.message === 'No such editor')).toBe(true);
  });

  it('term.spawn correlates by request_id, blocks duplicates, and settles on operation:result', () => {
    const run = dispatcher.dispatch('term.spawn', { termId: 'tab-term-1', cols: 80, rows: 24, cwd: '/tmp/w1' });
    expect(run.phase).toBe('pending');
    expect(transport.sent).toHaveLength(1);
    const sent = transport.sent[0] as { request_id?: string };
    expect(sent).toMatchObject({
      type: 'term:spawn',
      term_id: 'tab-term-1',
      cols: 80,
      rows: 24,
      cwd: '/tmp/w1',
    });
    expect(sent.request_id).toBeTruthy();

    // Duplicate pending guard: a second spawn of the same term id is ignored.
    const duplicate = dispatcher.dispatch('term.spawn', { termId: 'tab-term-1', cols: 80, rows: 24 });
    expect(duplicate.id).toBe(run.id);
    expect(transport.sent).toHaveLength(1);

    transport.emit({
      type: 'operation:result',
      request_id: sent.request_id!,
      request_type: 'term:spawn',
      ok: true,
    });
    expect(store.getRun(run.id)?.phase).toBe('confirmed');
  });

  it('term.close settles failed with the host error surfaced on the run', () => {
    const run = dispatcher.dispatch('term.close', { termId: 'tab-term-9' });
    expect(run.phase).toBe('pending');
    const sent = transport.sent[0] as { request_id?: string };
    expect(sent).toMatchObject({ type: 'term:close', term_id: 'tab-term-9' });

    transport.emit({
      type: 'operation:result',
      request_id: sent.request_id!,
      request_type: 'term:close',
      ok: false,
      error: { code: 'NO_TERM', message: 'terminal not found' },
    });
    expect(store.getRun(run.id)?.phase).toBe('failed');
    expect(store.getRun(run.id)?.error).toBe('terminal not found');
  });
});
