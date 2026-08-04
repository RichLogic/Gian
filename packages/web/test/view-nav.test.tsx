import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import type { Mode } from '../src/components/Topbar.js';
import { useViewNav } from '../src/controllers/use-view-nav.js';

/** Wire the controlled App-level state the hook expects, exactly as App does. */
function useHarness() {
  const [mode, setMode] = useState<Mode>('tasks');
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [activeSubtaskId, setActiveSubtaskId] = useState<string | null>(null);
  const nav = useViewNav({
    mode,
    activeSessionId,
    activeTaskId,
    activeSubtaskId,
    setMode,
    setActiveSessionId,
    setActiveTaskId,
    setActiveSubtaskId,
  });
  return { mode, activeSessionId, activeTaskId, activeSubtaskId, setMode, setActiveSessionId, setActiveTaskId, setActiveSubtaskId, nav };
}

describe('useViewNav', () => {
  it('starts with no back/forward and pushes an entry on selection change', () => {
    const { result } = renderHook(() => useHarness());
    expect(result.current.nav.canGoBack).toBe(false);
    expect(result.current.nav.canGoForward).toBe(false);

    act(() => result.current.setActiveSessionId('s1'));
    expect(result.current.nav.canGoBack).toBe(true);
    expect(result.current.nav.canGoForward).toBe(false);
  });

  it('navigate(-1) restores the previous mode + selection without pushing', () => {
    const { result } = renderHook(() => useHarness());
    act(() => result.current.setActiveSessionId('s1'));
    act(() => result.current.setMode('sessions'));
    act(() => result.current.setActiveSessionId('s2'));

    act(() => result.current.nav.navigate(-1));
    expect(result.current.mode).toBe('sessions');
    expect(result.current.activeSessionId).toBe('s1');
    expect(result.current.nav.canGoForward).toBe(true);

    act(() => result.current.nav.navigate(-1));
    expect(result.current.mode).toBe('tasks');
    expect(result.current.activeSessionId).toBe('s1');

    act(() => result.current.nav.navigate(-1));
    expect(result.current.mode).toBe('tasks');
    expect(result.current.activeSessionId).toBe(null);
    expect(result.current.nav.canGoBack).toBe(false);

    act(() => result.current.nav.navigate(1));
    expect(result.current.mode).toBe('tasks');
    expect(result.current.activeSessionId).toBe('s1');
  });

  it('truncates the forward branch when a new change happens after going back', () => {
    const { result } = renderHook(() => useHarness());
    act(() => result.current.setActiveSessionId('s1'));
    act(() => result.current.setActiveSessionId('s2'));
    act(() => result.current.nav.navigate(-1));
    expect(result.current.activeSessionId).toBe('s1');

    act(() => result.current.setActiveSessionId('s3'));
    expect(result.current.nav.canGoForward).toBe(false);
    act(() => result.current.nav.navigate(-1));
    expect(result.current.activeSessionId).toBe('s1');
  });

  it('does not push duplicate entries for repeated identical state', () => {
    const { result } = renderHook(() => useHarness());
    act(() => result.current.setActiveSessionId('s1'));
    // Re-render with the same values (e.g. an unrelated state bump) must not push.
    act(() => result.current.setActiveSessionId('s1'));
    act(() => result.current.nav.navigate(-1));
    expect(result.current.activeSessionId).toBe(null);
    expect(result.current.nav.canGoBack).toBe(false);
  });
});
