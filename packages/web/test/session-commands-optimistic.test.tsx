import { act, renderHook } from '@testing-library/react';
import { useRef, useState } from 'react';
import type { ClientToServerMessage, ServerToClientMessage, Session } from '@gian/shared';
import { describe, expect, it } from 'vitest';
import { useSessionCommands } from '../src/controllers/use-session-commands.js';
import { createOperationDispatcher, type OperationTransport } from '../src/operations/dispatcher.js';
// Side effect: registers the product Session definitions on the default
// registry the dispatcher falls back to.
import { sessionEntityKey } from '../src/operations/session.js';
import { createOperationStore, entityFieldKey } from '../src/operations/store.js';

function fixture(): Session {
  return {
    id: 'session-1',
    name: 'Before',
    type: 'primary',
    task_id: null,
    workspace_id: 'workspace-1',
    executor: 'codex',
    model: null,
    approval_mode: 'ask',
    executor_config: { schemaVersion: 1, values: {} },
    native_config_options: [],
    thinking_effort: null,
    service_tier: null,
    active_channel: 'web',
    status: 'done',
    archived: 0,
    pinned_at: null,
    unread: 0,
    worktree_path: null,
    branch: null,
    base_branch: null,
    worktree_outcome: null,
    detected_worktree_path: null,
    completed_at: null,
    native_session_id: 'native-1',
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    last_accessed_at: null,
    context_tokens_used: null,
    context_window_tokens: null,
    context_usage_updated_at: null,
    conversation_input_tokens: null,
    conversation_output_tokens: null,
    conversation_cached_input_tokens: null,
    conversation_total_tokens: null,
    conversation_usage_complete: 0,
  };
}

/** Minimal socket double — only the surface the dispatcher subscribes to. */
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
    listener('open', 0); // GianWs contract: fires immediately
    return () => this.stateListeners.delete(listener);
  }

  emitResult(requestId: string, ok: boolean, error?: { code: string; message: string }): void {
    for (const listener of this.messageListeners) {
      listener({ type: 'operation:result', request_id: requestId, request_type: 'session:rename', ok, error });
    }
  }
}

function requestIdOf(msg: ClientToServerMessage | undefined): string {
  const id = (msg as { request_id?: string } | undefined)?.request_id;
  expect(id).toBeTruthy();
  return id!;
}

describe('session commands on the operation layer (Phase 2a)', () => {
  it('commits the optimistic overlay synchronously and never patches canonical session state', () => {
    const transport = new FakeTransport();
    const store = createOperationStore();
    const { result } = renderHook(() => {
      const [sessions] = useState([fixture()]);
      const sessionsRef = useRef(sessions);
      const [dispatcher] = useState(() => createOperationDispatcher({
        store,
        transport,
        readCanonicalField: (entityKey, field) => entityKey === sessionEntityKey('session-1')
          ? sessionsRef.current[0]?.[field as keyof Session]
          : undefined,
      }));
      const commands = useSessionCommands({
        ops: dispatcher,
        sessionsRef,
      });
      return { sessions, commands };
    });

    act(() => result.current.commands.onRename('session-1', '  After  '));

    // Local feedback is committed before the transport result — as an
    // overlay, while the canonical session keeps the Host-owned value.
    const overlay = store.getOverlay(entityFieldKey('session:session-1', 'name'));
    expect(overlay?.value).toBe('After');
    expect(overlay?.previous).toBe('Before');
    expect(result.current.sessions[0]?.name).toBe('Before');

    // The wire message keeps the pre-migration shape, plus request_id (§4.4).
    expect(transport.sent.at(-1)).toMatchObject({
      type: 'session:rename', session_id: 'session-1', name: '  After  ',
    });
    const renameRequest = requestIdOf(transport.sent.at(-1));

    act(() => transport.emitResult(renameRequest, true));
    expect(store.getEntityOverlays('session:session-1')).toHaveLength(0);

    act(() => result.current.commands.onPin('session-1', true));
    expect(store.getOverlay(entityFieldKey('session:session-1', 'pinned_at'))?.value).not.toBeNull();
    expect(result.current.sessions[0]?.pinned_at).toBeNull(); // canonical untouched
    expect(transport.sent.at(-1)).toMatchObject({ type: 'session:pin', session_id: 'session-1', pinned: true });
  });

  it('routes pending commands through the dispatcher with its duplicate guard', () => {
    const transport = new FakeTransport();
    const store = createOperationStore();
    const { result } = renderHook(() => {
      const [sessions] = useState([fixture()]);
      const sessionsRef = useRef(sessions);
      const [dispatcher] = useState(() => createOperationDispatcher({ store, transport }));
      const commands = useSessionCommands({
        ops: dispatcher,
        sessionsRef,
      });
      return { commands };
    });

    act(() => result.current.commands.onStop('session-1'));
    act(() => result.current.commands.onStop('session-1')); // duplicate — blocked
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toMatchObject({ type: 'session:stop', session_id: 'session-1' });
    expect(store.getPendingRuns('session:session-1').map(run => run.name)).toEqual(['session.stop']);
    // No success claim: pending runs write no overlays.
    expect(store.getEntityOverlays('session:session-1')).toHaveLength(0);
  });
});
