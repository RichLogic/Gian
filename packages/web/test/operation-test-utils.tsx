/**
 * Shared operation-layer test harness (Phase 3b): wraps a rendered tree in
 * the OperationStore/Dispatcher providers with a real dispatcher bound to a
 * fake transport, and registers EVERY product operation definition as a side
 * effect. Tests for components that dispatch operations (Settings, git/
 * native panes, Inspector, login/onboarding) render through
 * `renderWithOperations` (or `operationWrapper`) instead of mounting
 * provider-less.
 */
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import type { ClientToServerMessage, ServerToClientMessage } from '@gian/shared';
import type { ReactElement, ReactNode } from 'react';
import { createOperationDispatcher, type OperationTransport } from '../src/operations/dispatcher.js';
import type { OperationStore } from '../src/operations/store.js';
import { createOperationStore } from '../src/operations/store.js';
// Side effects: register all product definitions used by migrated views.
import '../src/operations/session.js';
import '../src/operations/workspace.js';
import '../src/operations/task.js';
import '../src/operations/settings.js';
import '../src/operations/agents.js';
import '../src/operations/git.js';
import '../src/operations/native.js';
import '../src/operations/files.js';
import '../src/operations/terminal.js';
import '../src/operations/auth.js';
import '../src/operations/onboarding.js';
import { OperationDispatcherProvider, OperationStoreProvider } from '../src/operations/use-operations.js';

/** Fake WS transport: captures sent messages and lets the test deliver
 *  `operation:result` responses and socket state changes. */
export class FakeOperationTransport implements OperationTransport {
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
    return () => this.stateListeners.delete(listener);
  }

  /** Deliver a server message to the dispatcher (e.g. an operation:result). */
  emit(msg: ServerToClientMessage): void {
    for (const listener of this.messageListeners) listener(msg);
  }

  /** Settle the run behind a sent request: extracts its request_id and
   *  delivers a matching operation:result. */
  resolveLast(ok = true, error?: { code: string; message: string }): void {
    const last = this.sent[this.sent.length - 1] as { request_id?: string } | undefined;
    if (!last?.request_id) throw new Error('no correlated request sent');
    this.emit({ type: 'operation:result', request_id: last.request_id, request_type: (last as { type: string }).type as never, ok, ...(error ? { error } : {}) });
  }

  close(): void {
    for (const listener of this.stateListeners) listener('closed', 0);
  }
}

export interface OperationHarness {
  store: OperationStore;
  dispatcher: ReturnType<typeof createOperationDispatcher>;
  transport: FakeOperationTransport;
  wrapper: ({ children }: { children: ReactNode }) => ReactElement;
}

export function createOperationHarness(): OperationHarness {
  const store = createOperationStore();
  const transport = new FakeOperationTransport();
  const dispatcher = createOperationDispatcher({ store, transport });
  return {
    store,
    dispatcher,
    transport,
    wrapper: ({ children }: { children: ReactNode }) => (
      <OperationStoreProvider store={store}>
        <OperationDispatcherProvider dispatcher={dispatcher}>{children}</OperationDispatcherProvider>
      </OperationStoreProvider>
    ),
  };
}

/** render() with fresh operation providers around the tree. */
export function renderWithOperations(
  ui: ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>,
): RenderResult & OperationHarness {
  const harness = createOperationHarness();
  const result = render(ui, { ...options, wrapper: harness.wrapper });
  return { ...result, ...harness };
}
