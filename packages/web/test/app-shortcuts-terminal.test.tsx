import { act, renderHook } from '@testing-library/react';
import type { Session } from '@gian/shared';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useAppShortcuts } from '../src/controllers/use-app-shortcuts.js';
import type { OperationDispatcher } from '../src/operations/dispatcher.js';
import { sessionContractFixture } from './fixtures/ws-contract.js';

function renderShortcuts(session: Session) {
  const dispatch = vi.fn();
  const sessionsRef = { current: [session] } as RefObject<Session[]>;
  const ops = {
    dispatch,
    dispose: vi.fn(),
    store: {},
  } as unknown as OperationDispatcher;
  const setPaletteOpen = vi.fn() as Dispatch<SetStateAction<boolean>>;

  renderHook(() => useAppShortcuts({
    authenticated: true,
    mode: 'sessions',
    activeSessionId: session.id,
    activeTaskId: null,
    activeSubtaskId: null,
    sessionsRef,
    ops,
    paletteOpen: false,
    setPaletteOpen,
  }));

  return dispatch;
}

function pressQueueShortcut(modifier: 'metaKey' | 'ctrlKey'): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    [modifier]: true,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    document.dispatchEvent(event);
  });
  return event;
}

describe('global queue.sendNow shortcut terminal guard', () => {
  for (const modifier of ['metaKey', 'ctrlKey'] as const) {
    it(`dispatches ${modifier === 'metaKey' ? 'Cmd' : 'Ctrl'}+Enter for an open Codex session`, () => {
      const session = sessionContractFixture({ id: `open-${modifier}` });
      const dispatch = renderShortcuts(session);

      const event = pressQueueShortcut(modifier);

      expect(event.defaultPrevented).toBe(true);
      expect(dispatch).toHaveBeenCalledOnce();
      expect(dispatch).toHaveBeenCalledWith('queue.sendNow', { sessionId: session.id });
    });
  }

  for (const state of [
    { label: 'completed', completed_at: '2026-08-08T01:00:00.000Z', worktree_outcome: null },
    { label: 'merged', completed_at: null, worktree_outcome: 'merged' },
    { label: 'discarded', completed_at: null, worktree_outcome: 'discarded' },
  ] as const) {
    for (const modifier of ['metaKey', 'ctrlKey'] as const) {
      it(`ignores ${modifier === 'metaKey' ? 'Cmd' : 'Ctrl'}+Enter when the session is ${state.label}`, () => {
        const session = sessionContractFixture({
          id: `${state.label}-${modifier}`,
          completed_at: state.completed_at,
          worktree_outcome: state.worktree_outcome,
        });
        const dispatch = renderShortcuts(session);

        const event = pressQueueShortcut(modifier);

        expect(event.defaultPrevented).toBe(false);
        expect(dispatch).not.toHaveBeenCalled();
      });
    }
  }
});
