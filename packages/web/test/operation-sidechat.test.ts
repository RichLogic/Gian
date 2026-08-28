/**
 * Side Chat / protocol-Fork operation definitions (gian.proxy/2.0 amendment,
 * `docs/proposals/gian-proxy-v2-ui-bridge.md` §10.5/§10.6) on the real
 * product registry entries from `src/operations/sidechat.ts`:
 * registration + policy + WS wire type for all four operations, the
 * duplicate-pending guard on sidechat.close (dispatcher §4.3), fresh
 * per-run entity keys for create/fork, and proof that the legacy
 * `session.fork` ("Fork as <executor>") operation is untouched.
 */
import type { ClientToServerMessage, ServerToClientMessage } from '@gian/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOperationDispatcher, type OperationTransport } from '../src/operations/dispatcher.js';
// Side effects: register the product definitions under test.
import '../src/operations/session.js';
import '../src/operations/sidechat.js';
import { registry } from '../src/operations/registry.js';
import { OPERATION_POLICIES, WS_TYPE_POLICIES } from '../src/operations/types.js';
import { createOperationStore } from '../src/operations/store.js';

class FakeTransport implements OperationTransport {
  sent: ClientToServerMessage[] = [];
  private messageListeners = new Set<(msg: ServerToClientMessage) => void>();
  private stateListeners = new Set<(state: 'connecting' | 'open' | 'closed', attempt: number) => void>();

  send(msg: ClientToServerMessage): void {
    this.sent.push(msg);
  }

  onMessage(listener: (msg: ServerToClientMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onState(listener: (state: 'connecting' | 'open' | 'closed', attempt: number) => void): () => void {
    this.stateListeners.add(listener);
    listener('open', 0);
    return () => this.stateListeners.delete(listener);
  }
}

function setup() {
  const store = createOperationStore();
  const transport = new FakeTransport();
  const dispatcher = createOperationDispatcher({ store, transport });
  return { store, transport, dispatcher };
}

describe('sidechat/fork operation registration (proposal §10.5/§10.6)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers lifecycle and independent turn-config operations with their WS policies', () => {
    for (const name of ['sidechat.create', 'sidechat.resume', 'sidechat.close', 'session.forkSession'] as const) {
      expect(OPERATION_POLICIES[name]).toBe('pending');
      expect(registry.has(name)).toBe(true);
    }
    expect(WS_TYPE_POLICIES['sidechat:create']).toBe('pending');
    expect(WS_TYPE_POLICIES['sidechat:resume']).toBe('pending');
    expect(WS_TYPE_POLICIES['sidechat:close']).toBe('pending');
    expect(OPERATION_POLICIES['sidechat.setTurnConfig']).toBe('optimistic');
    expect(registry.has('sidechat.setTurnConfig')).toBe(true);
    expect(WS_TYPE_POLICIES['sidechat:set_turn_config']).toBe('optimistic');
    expect(WS_TYPE_POLICIES['session:fork']).toBe('pending');
  });

  it('sidechat.setTurnConfig overlays the full draft and sends only the changed option', () => {
    const { store, transport, dispatcher } = setup();
    const run = dispatcher.dispatch('sidechat.setTurnConfig', {
      sidechatId: 'sc-1',
      optionId: 'model',
      value: 'gpt-next',
      turnConfig: { model: 'gpt-next', effort: 'high' },
    });

    expect(run.phase).toBe('optimistic');
    expect(store.getOverlay('sidechat:sc-1:turn_config')?.value).toEqual({
      model: 'gpt-next',
      effort: 'high',
    });
    expect(transport.sent[0]).toMatchObject({
      type: 'sidechat:set_turn_config',
      sidechat_id: 'sc-1',
      option_id: 'model',
      value: 'gpt-next',
    });
    expect(transport.sent[0]).not.toHaveProperty('turn_config');
  });

  it('sidechat.create sends sidechat:create with only the parent session id', () => {
    const { transport, dispatcher } = setup();

    const run = dispatcher.dispatch('sidechat.create', { parentSessionId: 's-parent' });

    expect(run.phase).toBe('pending');
    expect(transport.sent).toHaveLength(1);
    const message = transport.sent[0]!;
    expect(message.type).toBe('sidechat:create');
    // The web never sends resumeRef/streamId/sidechatId — the Host owns them
    // (shared/web.ts SidechatCreateMessage contract).
    expect(message).toMatchObject({ parent_session_id: 's-parent' });
    expect(Object.keys(message).sort()).toEqual(['parent_session_id', 'request_id', 'type']);
  });

  it('sidechat.resume and sidechat.close key on sidechat:<id> and send their WS types', () => {
    const { transport, dispatcher } = setup();

    const resumeRun = dispatcher.dispatch('sidechat.resume', {
      sidechatId: 'sc-1',
      parentSessionId: 's-parent',
    });
    const closeRun = dispatcher.dispatch('sidechat.close', { sidechatId: 'sc-2' });

    expect(resumeRun.entityKey).toBe('sidechat:sc-1');
    expect(closeRun.entityKey).toBe('sidechat:sc-2');
    expect(transport.sent.map(message => message.type)).toEqual(['sidechat:resume', 'sidechat:close']);
    expect(transport.sent[0]).toMatchObject({
      sidechat_id: 'sc-1',
      parent_session_id: 's-parent',
    });
    expect(transport.sent[1]).toMatchObject({ sidechat_id: 'sc-2' });
  });

  it('ignores a duplicate sidechat.close for the same Side Chat while one is in flight', () => {
    const { transport, dispatcher } = setup();

    const first = dispatcher.dispatch('sidechat.close', { sidechatId: 'sc-1' });
    const second = dispatcher.dispatch('sidechat.close', { sidechatId: 'sc-1' });

    // Dispatcher duplicate pending guard (§4.3): the second submission is
    // ignored — same run returned, no second transport frame.
    expect(second.id).toBe(first.id);
    expect(transport.sent).toHaveLength(1);
  });

  it('does not treat closes of DIFFERENT Side Chats as duplicates', () => {
    const { transport, dispatcher } = setup();

    const first = dispatcher.dispatch('sidechat.close', { sidechatId: 'sc-1' });
    const other = dispatcher.dispatch('sidechat.close', { sidechatId: 'sc-2' });

    expect(other.id).not.toBe(first.id);
    expect(transport.sent).toHaveLength(2);
  });

  it('mints a fresh entity key per sidechat.create run so concurrent creates are not duplicates', () => {
    const { transport, dispatcher } = setup();

    const first = dispatcher.dispatch('sidechat.create', { parentSessionId: 's-parent' });
    const second = dispatcher.dispatch('sidechat.create', { parentSessionId: 's-parent' });

    expect(first.entityKey).toMatch(/^pending:sidechat\.create:/);
    expect(second.entityKey).toMatch(/^pending:sidechat\.create:/);
    expect(second.entityKey).not.toBe(first.entityKey);
    expect(transport.sent).toHaveLength(2);
  });

  it('session.forkSession sends session:fork with the exact head or turn anchor (§10.6)', () => {
    const { transport, dispatcher } = setup();

    const headRun = dispatcher.dispatch('session.forkSession', {
      sourceSessionId: 's-parent',
      anchor: { type: 'head' },
    });
    const turnRun = dispatcher.dispatch('session.forkSession', {
      sourceSessionId: 's-parent',
      anchor: { type: 'turn', turnId: 't_anchor', sourceTurnId: 'provider-turn-anchor' },
    });

    expect(headRun.entityKey).toMatch(/^pending:session\.forkSession:/);
    expect(turnRun.entityKey).not.toBe(headRun.entityKey);
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[0]).toMatchObject({
      type: 'session:fork',
      source_session_id: 's-parent',
      anchor: { type: 'head' },
    });
    expect(transport.sent[1]).toMatchObject({
      type: 'session:fork',
      source_session_id: 's-parent',
      anchor: { type: 'turn', turn_id: 't_anchor', source_turn_id: 'provider-turn-anchor' },
    });
  });

  it('keeps the legacy session.fork ("Fork as <executor>") on session:create, untouched', () => {
    const { transport, dispatcher } = setup();

    dispatcher.dispatch('session.fork', {
      workspaceId: 'w1',
      executor: 'codex',
      name: 'Fork as codex',
      approvalMode: 'ask',
    });

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toMatchObject({
      type: 'session:create',
      workspace_id: 'w1',
      executor: 'codex',
      name: 'Fork as codex',
      approval_mode: 'ask',
    });
  });
});
