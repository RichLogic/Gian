import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { LocaleProvider } from '../src/i18n/index.js';
import { Transcript } from '../src/transcript/Transcript.js';
import type { TranscriptSelectionActionsConfig } from '../src/transcript/TranscriptSelectionActions.js';
import {
  createSelectedTextContextItem,
  mintSelectionSideChatId,
} from '../src/transcript/selection-context.js';
import {
  startTranscriptSelectionSideChat,
} from '../src/controllers/transcript-selection-actions.js';
import type { OperationDispatcher } from '../src/operations/dispatcher.js';
import type { OperationRun } from '../src/operations/types.js';
import type { TranscriptItem } from '../src/types.js';

const ITEMS: TranscriptItem[] = [
  {
    kind: 'user',
    id: 'user-selection',
    text: 'Please inspect this exact phrase.',
    exec: 'codex',
    ts: 1,
    turn: 1,
  },
  {
    kind: 'assistant',
    id: 'assistant-selection',
    text: 'Assistant selectable response.',
    exec: 'codex',
    ts: 2,
    turn: 1,
  },
];

const rectDescriptor = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect');

function firstTextNode(root: HTMLElement): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const node = walker.nextNode();
  if (!(node instanceof Text)) throw new Error('Selectable message has no text node');
  return node;
}

function selectBetween(start: HTMLElement, startOffset: number, end: HTMLElement, endOffset: number): void {
  const range = document.createRange();
  range.setStart(firstTextNode(start), startOffset);
  range.setEnd(firstTextNode(end), endOffset);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  act(() => document.dispatchEvent(new Event('selectionchange')));
}

function enabledActions() {
  const add = vi.fn();
  const ask = vi.fn();
  const actions: TranscriptSelectionActionsConfig = {
    addToChat: { enabled: true, run: add },
    askInSideChat: { enabled: true, run: ask },
  };
  return { actions, add, ask };
}

function renderTranscript(actions: TranscriptSelectionActionsConfig, items = ITEMS) {
  return render(
    <LocaleProvider locale="en">
      <Transcript
        items={items}
        pending={false}
        onApprove={() => {}}
        selectionActions={actions}
      />
    </LocaleProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: 80,
      y: 100,
      left: 80,
      top: 100,
      right: 240,
      bottom: 122,
      width: 160,
      height: 22,
      toJSON: () => ({}),
    }),
  });
});

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  if (rectDescriptor) {
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', rectDescriptor);
  } else {
    Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
  }
});

describe('Transcript selected-text actions', () => {
  it('adds the exact user selection to chat without replacing ordinary text selection', async () => {
    const { actions, add, ask } = enabledActions();
    renderTranscript(actions);
    const userText = document.querySelector<HTMLElement>('[data-transcript-source-kind="user"]')!;

    selectBetween(userText, 7, userText, 25);

    const toolbar = await screen.findByRole('toolbar', { name: 'Selected text actions' });
    expect(toolbar).toBeInTheDocument();
    expect(window.getSelection()?.toString()).toBe('inspect this exact');
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Add to chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }));

    expect(add).toHaveBeenCalledWith(expect.objectContaining({
      text: 'inspect this exact',
      sourceKind: 'user',
      turn: 1,
    }));
    expect(ask).not.toHaveBeenCalled();
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('routes an assistant selection to Ask in side chat', async () => {
    const { actions, add, ask } = enabledActions();
    renderTranscript(actions);
    const assistantText = document.querySelector<HTMLElement>('[data-transcript-source-kind="assistant"]')!;

    selectBetween(assistantText, 0, assistantText, 20);
    await screen.findByRole('toolbar');
    fireEvent.click(screen.getByRole('button', { name: 'Ask in side chat' }));

    expect(ask).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Assistant selectable',
      sourceKind: 'assistant',
      turn: 1,
    }));
    expect(add).not.toHaveBeenCalled();
  });

  it('does not offer actions for a cross-message selection', async () => {
    const { actions } = enabledActions();
    renderTranscript(actions);
    const userText = document.querySelector<HTMLElement>('[data-transcript-source-kind="user"]')!;
    const assistantText = document.querySelector<HTMLElement>('[data-transcript-source-kind="assistant"]')!;

    selectBetween(userText, 0, assistantText, 9);

    await waitFor(() => expect(screen.queryByRole('toolbar')).toBeNull());
    expect(window.getSelection()?.isCollapsed).toBe(false);
  });

  it('keeps an unavailable Side Chat action visible with its gating reason', async () => {
    const { actions } = enabledActions();
    actions.askInSideChat = {
      enabled: false,
      reason: 'Side Chat is unavailable while history is recovering.',
      run: vi.fn(),
    };
    renderTranscript(actions);
    const userText = document.querySelector<HTMLElement>('[data-transcript-source-kind="user"]')!;

    selectBetween(userText, 0, userText, 6);
    await screen.findByRole('toolbar');

    expect(screen.getByRole('button', { name: 'Add to chat' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Ask in side chat' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Ask in side chat' }))
      .toHaveAttribute('title', 'Side Chat is unavailable while history is recovering.');
  });

  it('dismisses on collapsed selection, Escape, outside interaction, and source removal', async () => {
    const { actions } = enabledActions();
    const view = renderTranscript(actions);
    const userText = document.querySelector<HTMLElement>('[data-transcript-source-kind="user"]')!;

    selectBetween(userText, 0, userText, 6);
    await screen.findByRole('toolbar');
    window.getSelection()?.removeAllRanges();
    act(() => document.dispatchEvent(new Event('selectionchange')));
    await waitFor(() => expect(screen.queryByRole('toolbar')).toBeNull());

    selectBetween(userText, 0, userText, 6);
    await screen.findByRole('toolbar');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('toolbar')).toBeNull();

    act(() => document.dispatchEvent(new Event('selectionchange')));
    await screen.findByRole('toolbar');
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('toolbar')).toBeNull();

    act(() => document.dispatchEvent(new Event('selectionchange')));
    await screen.findByRole('toolbar');
    view.rerender(
      <LocaleProvider locale="en">
        <Transcript items={[ITEMS[1]!]} pending={false} onApprove={() => {}} selectionActions={actions} />
      </LocaleProvider>,
    );
    await waitFor(() => expect(screen.queryByRole('toolbar')).toBeNull());
  });

  it('keeps both actions visible but disabled when the selection exceeds the context cap', async () => {
    const { actions, add, ask } = enabledActions();
    const huge: TranscriptItem[] = [{ ...ITEMS[0]!, text: 'x'.repeat(70_000) }];
    renderTranscript(actions, huge);
    const userText = document.querySelector<HTMLElement>('[data-transcript-source-kind="user"]')!;

    selectBetween(userText, 0, userText, 70_000);
    await screen.findByRole('toolbar');

    const addButton = screen.getByRole('button', { name: 'Add to chat' });
    const askButton = screen.getByRole('button', { name: 'Ask in side chat' });
    expect(addButton).toBeDisabled();
    expect(askButton).toBeDisabled();
    expect(addButton).toHaveAttribute('title', 'The selection exceeds the 64 KB context limit');
    fireEvent.click(addButton);
    fireEvent.click(askButton);
    expect(add).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('selected-text context metadata', () => {
  it('preserves exact visible text and derives bounded metadata', () => {
    const item = createSelectedTextContextItem({
      text: 'first line\nsecond line',
      sourceId: 'assistant:1',
      sourceKind: 'assistant',
      turn: 2,
    }, 'ctx-selection');
    expect(item).toEqual({
      type: 'pastedText',
      id: 'ctx-selection',
      text: 'first line\nsecond line',
      lineCount: 2,
      byteSize: 22,
      origin: 'selection',
    });
    expect(createSelectedTextContextItem({
      text: 'x'.repeat(70_000),
      sourceId: 'assistant:1',
      sourceKind: 'assistant',
      turn: 2,
    })).toBeNull();
    expect(mintSelectionSideChatId('selection-id')).toBe('sc_selection-id');
  });

  it('seeds the exact selected text into the client-minted Side Chat draft before opening it', () => {
    const rawDispatch = vi.fn(() => ({
      id: 'run-selection-sidechat',
      name: 'sidechat.create',
      entityKey: 'pending:selection-sidechat',
      phase: 'pending',
      startedAt: 1,
    } satisfies OperationRun));
    const openChatPanel = vi.fn();
    const started = startTranscriptSelectionSideChat({
      parentSessionId: 'session-parent',
      selection: {
        text: 'exact selected response',
        sourceId: 'assistant:1',
        sourceKind: 'assistant',
        turn: 1,
      },
      dispatch: rawDispatch as unknown as OperationDispatcher['dispatch'],
      openChatPanel,
      sidechatId: 'sc_selected_context',
    });

    expect(started).toEqual({
      run: expect.objectContaining({ id: 'run-selection-sidechat' }),
      sidechatId: 'sc_selected_context',
    });
    expect(rawDispatch).toHaveBeenCalledWith('sidechat.create', {
      parentSessionId: 'session-parent',
      sidechatId: 'sc_selected_context',
    });
    expect(openChatPanel).toHaveBeenCalledWith({ kind: 'sidechat' });
    const draft = JSON.parse(
      localStorage.getItem('gian.composer.draft.v4.sc_selected_context') ?? 'null',
    );
    expect(draft.contextItems).toEqual([expect.objectContaining({
      type: 'pastedText',
      text: 'exact selected response',
      lineCount: 1,
      byteSize: 23,
    })]);
  });

  it('removes the transient Side Chat draft when create dispatch throws', () => {
    const dispatch = vi.fn(() => { throw new Error('transport unavailable'); });
    expect(() => startTranscriptSelectionSideChat({
      parentSessionId: 'session-parent',
      selection: {
        text: 'selected response',
        sourceId: 'assistant:1',
        sourceKind: 'assistant',
        turn: 1,
      },
      dispatch: dispatch as unknown as OperationDispatcher['dispatch'],
      openChatPanel: vi.fn(),
      sidechatId: 'sc_failed_context',
    })).toThrow('transport unavailable');
    expect(localStorage.getItem('gian.composer.draft.v4.sc_failed_context')).toBeNull();
  });
});
