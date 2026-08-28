/**
 * Phase 2b Message operations on the real product definitions
 * (`src/operations/message.ts`), proving the proposal §8/§9 send-echo
 * contract: the ordinary AND skill echo commit synchronously with the
 * dispatch; failure marks the echo failed in place (never silently removed)
 * with a retry affordance that re-dispatches the same operation; timeout and
 * disconnect leave the echo pending with an unknown-outcome state (no silent
 * success); and the canonical user_message event still replaces the echo.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { ClientToServerMessage, EventEnvelope, ServerToClientMessage } from '@gian/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadAttachment } from '../src/api.js';
import { LocaleProvider } from '../src/i18n/index.js';
import { createOperationDispatcher, type OperationTransport } from '../src/operations/dispatcher.js';
// Runtime import: registers the product Message definitions used below.
import {
  dispatchMessageSend,
  wireMessageEchoSink,
  type MessageEchoSink,
} from '../src/operations/message.js';
import { createOperationStore } from '../src/operations/store.js';
import { OperationDispatcherProvider, OperationStoreProvider } from '../src/operations/use-operations.js';
import { applyEnvelope } from '../src/transcript/apply.js';
import { UserMessage } from '../src/transcript/items.js';
import type { MessageSendPayload, MsgItem } from '../src/types.js';

vi.mock('../src/api.js', () => ({
  uploadAttachment: vi.fn(),
  // Imported by operations/session.js (pulled in via operations/message.js).
  dropSession: vi.fn(),
  mergeSession: vi.fn(),
}));

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

  emit(msg: ServerToClientMessage): void {
    for (const listener of this.messageListeners) listener(msg);
  }

  emitResult(requestId: string, ok: boolean, error?: { code: string; message: string }): void {
    this.emit({ type: 'operation:result', request_id: requestId, request_type: 'message:send', ok, error });
  }

  disconnect(): void {
    for (const listener of this.stateListeners) listener('closed', 0);
  }
}

function requestIdOf(msg: ClientToServerMessage | undefined): string {
  const id = (msg as { request_id?: string } | undefined)?.request_id;
  expect(id).toBeTruthy();
  return id!;
}

/** Fake transcript echo sink — App wires the real one with its setters. */
function fakeSink() {
  const sink: MessageEchoSink & {
    appended: Array<{ sessionId: string; item: MsgItem }>;
    confirmed: string[];
    failed: string[];
  } = {
    appended: [],
    confirmed: [],
    failed: [],
    append(sessionId, item) {
      sink.appended.push({ sessionId, item });
    },
    markConfirmed(runId) {
      sink.confirmed.push(runId);
    },
    markFailed(runId) {
      sink.failed.push(runId);
    },
  };
  return sink;
}

function setup() {
  const store = createOperationStore();
  const transport = new FakeTransport();
  const dispatcher = createOperationDispatcher({ store, transport });
  const sink = fakeSink();
  wireMessageEchoSink(sink);
  return { store, transport, dispatcher, sink };
}

function payload(overrides: Partial<MessageSendPayload> = {}): MessageSendPayload {
  return { sessionId: 's1', text: 'hello', exec: 'claude', ...overrides };
}

describe('message send echo (proposal §9, product definitions)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    wireMessageEchoSink(null);
    vi.useRealTimers();
  });

  it('ordinary send: echo appears synchronously with the dispatch, tagged for retry', () => {
    const { transport, dispatcher, sink } = setup();

    const run = dispatchMessageSend(dispatcher.dispatch, payload());

    expect(run.phase).toBe('optimistic');
    expect(sink.appended).toHaveLength(1);
    const echo = sink.appended[0]!.item;
    expect(echo).toMatchObject({ kind: 'user', text: 'hello', pending: true });
    expect(echo.sendRunId).toBe(run.id);
    expect(echo.sendRetry).toEqual(payload());
    expect(transport.sent[0]).toMatchObject({ type: 'message:send', session_id: 's1', text: 'hello' });
    expect(requestIdOf(transport.sent[0])).toBeTruthy();
  });

  it('carries context cards through the wire, optimistic echo, and canonical reconciliation', () => {
    const { transport, dispatcher, sink } = setup();
    const contextItems = [{
      type: 'pastedText' as const,
      id: 'paste-1',
      text: 'reference text',
      lineCount: 1,
      byteSize: 14,
    }];
    dispatchMessageSend(dispatcher.dispatch, payload({ contextItems }));

    expect(transport.sent[0]).toMatchObject({ context_items: contextItems });
    const echo = sink.appended[0]!.item;
    expect(echo.contextItems).toEqual(contextItems);
    const envelope: EventEnvelope = {
      session_id: 's1',
      turn: 1,
      call_id: 'real-user-context',
      event: 'user_message',
      ts: echo.ts + 1,
      data: { text: 'hello', context_items: contextItems },
    };
    const after = applyEnvelope([echo], envelope, 'claude');
    expect(after).toHaveLength(1);
    expect((after[0] as MsgItem).contextItems).toEqual(contextItems);
    expect((after[0] as MsgItem).sendCanonical).toBe(true);
  });

  it('carries an ordered composer document through wire, echo, and canonical reconciliation', () => {
    const { transport, dispatcher, sink } = setup();
    const composerDocument = {
      version: 1 as const,
      segments: [
        { type: 'text' as const, text: 'Review ' },
        { type: 'reference' as const, id: 'file-1', referenceType: 'attachment' as const, label: 'notes.md' },
        { type: 'text' as const, text: ' carefully' },
      ],
    };
    dispatchMessageSend(dispatcher.dispatch, payload({ composerDocument }));

    expect(transport.sent[0]).toMatchObject({ composer_document: composerDocument });
    const echo = sink.appended[0]!.item;
    expect(echo.composerDocument).toEqual(composerDocument);
    const after = applyEnvelope([echo], {
      session_id: 's1',
      turn: 1,
      call_id: 'real-user-document',
      event: 'user_message',
      ts: echo.ts + 1,
      data: { text: 'Review  carefully', composer_document: composerDocument },
    }, 'claude');
    expect((after[0] as MsgItem).composerDocument).toEqual(composerDocument);
  });

  it.each(['codex', 'kimi'] as const)(
    'one-shot bypass fails closed before transport or optimistic echo for %s',
    exec => {
      const { transport, dispatcher, sink } = setup();

      expect(() => dispatchMessageSend(dispatcher.dispatch, payload({
        exec,
        oneShotBypass: true,
      }))).toThrow(/only supported for Claude sessions/);

      expect(transport.sent).toHaveLength(0);
      expect(sink.appended).toHaveLength(0);
    },
  );

  it('skill send: echo appears synchronously (the pre-Phase-2b gap), wire carries the typed skill item', () => {
    const { transport, dispatcher, sink } = setup();

    dispatchMessageSend(dispatcher.dispatch, payload({
      text: '/commit',
      skill: { name: 'commit', path: '/skills/commit.md' },
    }));

    expect(sink.appended).toHaveLength(1);
    expect(sink.appended[0]!.item).toMatchObject({ text: '/commit', pending: true });
    expect(transport.sent[0]).toMatchObject({
      type: 'message:send',
      session_id: 's1',
      text: '/commit',
      items: [{ type: 'skill', name: 'commit', path: '/skills/commit.md' }],
    });
  });

  it('failure marks the echo failed in place — it is never silently removed', () => {
    const { store, transport, dispatcher, sink } = setup();
    const run = dispatchMessageSend(dispatcher.dispatch, payload());

    transport.emitResult(requestIdOf(transport.sent[0]), false, { code: 'MESSAGE_SEND_FAILED', message: 'send rejected' });

    expect(store.getRun(run.id)?.phase).toBe('failed');
    // The definition's rollback marks THIS run's echo via the sink.
    expect(sink.failed).toEqual([run.id]);
    // The echo stays in the transcript (the sink never removes on failure).
    expect(sink.appended).toHaveLength(1);
  });

  it('success clears transient echo correlation through the production reconcile hook', () => {
    const { transport, dispatcher, sink } = setup();
    const run = dispatchMessageSend(dispatcher.dispatch, payload());

    transport.emitResult(requestIdOf(transport.sent[0]), true);

    expect(sink.confirmed).toEqual([run.id]);
    expect(sink.failed).toEqual([]);
  });

  it('retry re-dispatches the same operation from the failed echo', () => {
    const { transport, dispatcher, sink } = setup();
    dispatchMessageSend(dispatcher.dispatch, payload());
    transport.emitResult(requestIdOf(transport.sent[0]), false, { code: 'X', message: 'nope' });

    const retry = sink.appended[0]!.item.sendRetry!;
    const retryRun = dispatchMessageSend(dispatcher.dispatch, retry);

    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[1]).toMatchObject({ type: 'message:send', session_id: 's1', text: 'hello' });
    expect(sink.appended).toHaveLength(2);
    expect(sink.appended[1]!.item.sendRunId).toBe(retryRun.id);
    expect(sink.appended[1]!.item.pending).toBe(true);
  });

  it('timeout leaves the echo pending (unknown outcome) — never a silent success or failure', () => {
    const { store, transport, dispatcher, sink } = setup();
    const run = dispatchMessageSend(dispatcher.dispatch, payload());
    const requestId = requestIdOf(transport.sent[0]);

    vi.advanceTimersByTime(10_001);

    expect(store.getRun(run.id)?.phase).toBe('timed-out');
    expect(sink.failed).toEqual([]); // NOT marked failed — outcome unknown
    expect(sink.appended[0]!.item.pending).toBe(true); // echo stays pending

    // A late result never confirms an unknown outcome.
    transport.emitResult(requestId, true);
    expect(store.getRun(run.id)?.phase).toBe('timed-out');
  });

  it('disconnect marks the in-flight send timed-out; later results never confirm it', () => {
    const { store, transport, dispatcher, sink } = setup();
    const run = dispatchMessageSend(dispatcher.dispatch, payload());
    const requestId = requestIdOf(transport.sent[0]);

    transport.disconnect();

    expect(store.getRun(run.id)?.phase).toBe('timed-out');
    expect(sink.failed).toEqual([]);
    transport.emitResult(requestId, true);
    expect(store.getRun(run.id)?.phase).toBe('timed-out');
  });

  it('the canonical user_message event still replaces the pending echo', () => {
    const { dispatcher, sink } = setup();
    dispatchMessageSend(dispatcher.dispatch, payload());
    const echo = sink.appended[0]!.item;

    const envelope: EventEnvelope = {
      session_id: 's1',
      turn: 1,
      call_id: 'real-user-1',
      event: 'user_message',
      ts: echo.ts + 1,
      data: { text: 'hello' },
    };
    const after = applyEnvelope([echo], envelope, 'claude');

    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ kind: 'user', id: 'real-user-1', text: 'hello' });
    expect((after[0] as MsgItem).pending).toBe(true);
    expect((after[0] as MsgItem).sendCanonical).toBe(true);
    expect((after[0] as MsgItem).sendRunId).toBe(echo.sendRunId);
    expect((after[0] as MsgItem).sendRetry).toEqual(echo.sendRetry);
  });
});

describe('message send bubble (failure retry + unknown state)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    wireMessageEchoSink(null);
    vi.useRealTimers();
  });

  function wrapper(store: ReturnType<typeof createOperationStore>, dispatcher: ReturnType<typeof createOperationDispatcher>) {
    return ({ children }: { children: ReactNode }) => (
      <LocaleProvider locale="en">
        <OperationStoreProvider store={store}>
          <OperationDispatcherProvider dispatcher={dispatcher}>
            {children}
          </OperationDispatcherProvider>
        </OperationStoreProvider>
      </LocaleProvider>
    );
  }

  it('a failed echo renders the retry affordance; clicking it re-dispatches the send', () => {
    const { transport, dispatcher, sink, store } = setup();
    dispatchMessageSend(dispatcher.dispatch, payload());
    act(() => {
      transport.emitResult(requestIdOf(transport.sent[0]), false, { code: 'X', message: 'nope' });
    });
    // Simulate the App sink's markFailed: the echo is failed in place.
    const echo: MsgItem = { ...sink.appended[0]!.item, pending: false, failed: true };

    render(<UserMessage item={echo} />, { wrapper: wrapper(store, dispatcher) });

    expect(screen.getByText('failed to send')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[1]).toMatchObject({ type: 'message:send', session_id: 's1', text: 'hello' });
    // The retry commits a fresh pending echo through the same send path.
    expect(sink.appended).toHaveLength(2);
    expect(sink.appended[1]!.item.pending).toBe(true);
  });

  it('a pending echo whose run timed out shows the unknown-outcome state', () => {
    const { dispatcher, sink, store } = setup();
    dispatchMessageSend(dispatcher.dispatch, payload());
    const echo = sink.appended[0]!.item;
    render(<UserMessage item={echo} />, { wrapper: wrapper(store, dispatcher) });
    expect(screen.queryByText('may not have been sent')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(10_001);
    });

    // Unresolved semantics: still pending, labeled unknown — no silent success.
    expect(screen.getByText('may not have been sent')).toBeInTheDocument();
    expect(screen.queryByText('failed to send')).toBeNull();
  });
});

describe('message.uploadAttachment (REST executor)', () => {
  beforeEach(() => {
    vi.mocked(uploadAttachment).mockReset();
  });
  afterEach(() => {
    wireMessageEchoSink(null);
  });

  it('settles confirmed and delivers the result to the chip callback', async () => {
    const { store, dispatcher } = setup();
    vi.mocked(uploadAttachment).mockResolvedValue({
      path: '/tmp/gian/attachments/s1/uuid.png',
      name: 'paste-1.png',
      size: 3,
      mime: 'image/png',
    });
    const onUploaded = vi.fn();
    const onFailed = vi.fn();
    const file = new File(['img'], 'paste-1.png', { type: 'image/png' });

    const run = dispatcher.dispatch('message.uploadAttachment', {
      sessionId: 's1', blob: file, filename: 'paste-1.png', onUploaded, onFailed,
    });
    expect(run.phase).toBe('pending');

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(onUploaded).toHaveBeenCalledWith({
      path: '/tmp/gian/attachments/s1/uuid.png', name: 'paste-1.png', size: 3, mime: 'image/png',
    });
    expect(onFailed).not.toHaveBeenCalled();
    expect(store.getRun(run.id)?.phase).toBe('confirmed');
  });

  it('settles failed and delivers the error to the chip callback', async () => {
    const { store, dispatcher } = setup();
    vi.mocked(uploadAttachment).mockRejectedValue(new Error('upload failed (413)'));
    const onUploaded = vi.fn();
    const onFailed = vi.fn();

    const run = dispatcher.dispatch('message.uploadAttachment', {
      sessionId: 's1', blob: new File(['x'], 'a.txt'), filename: 'a.txt', onUploaded, onFailed,
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(onFailed).toHaveBeenCalledWith('upload failed (413)');
    expect(onUploaded).not.toHaveBeenCalled();
    expect(store.getRun(run.id)?.phase).toBe('failed');
    expect(store.getRun(run.id)?.error).toBe('upload failed (413)');
  });
});
