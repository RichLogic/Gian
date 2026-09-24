import { act, renderHook } from '@testing-library/react';
import { useEffect, useRef, useState } from 'react';
import { expect, it, vi } from 'vitest';
import type { Session } from '@gian/shared';
import type { Mode } from '../src/components/Topbar.js';
import type { OperationDispatcher } from '../src/operations/dispatcher.js';
import { useSessionSelection } from '../src/controllers/use-session-selection.js';

const ops = { dispatch: vi.fn() } as unknown as OperationDispatcher;
const restore = vi.fn();

function useHarness() {
  const [mode, setMode] = useState<Mode>('tasks');
  const [activeSubtaskId, setSubtask] = useState<string | null>('a');
  const [activeSessionId, setSession] = useState<string | null>('a');
  const sessionsRef = useRef([{ id: 'a', type: 'subtask' }, { id: 'b', type: 'subtask' }] as Session[]);
  const activeSessionIdRef = useRef(activeSessionId);
  useEffect(() => { activeSessionIdRef.current = activeSessionId; }, [activeSessionId]);
  useSessionSelection({ mode, activeSubtaskId, activeSessionId, sessionsRef, activeSessionIdRef,
    setActiveSessionId: setSession, restoreChatPanelForSession: restore, ops });
  return { activeSessionId, activeSubtaskId, setSession, setSubtask, setMode };
}

it('reconciles a stale Session update even when the selected Task row did not change', () => {
  const { result } = renderHook(useHarness);
  act(() => result.current.setSession('b'));
  expect(result.current.activeSubtaskId).toBe('a');
  expect(result.current.activeSessionId).toBe('a');
});

it('keeps rapid Task selection and restored Session state aligned', () => {
  const { result } = renderHook(useHarness);
  act(() => result.current.setSubtask('b'));
  expect(result.current.activeSessionId).toBe('b');
  act(() => { result.current.setSubtask('a'); result.current.setSession('b'); });
  expect(result.current.activeSessionId).toBe('a');
  act(() => result.current.setMode('sessions'));
  expect(result.current.activeSessionId).toBe('a');
});
