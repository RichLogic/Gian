import { useCallback, useSyncExternalStore } from 'react';
import type { GitHistoryCommitDetail, GitHistoryFileDiff } from '../api.js';

export interface HistoryCommitFileState {
  status: 'idle' | 'loading' | 'loaded' | 'error';
  diff: GitHistoryFileDiff | null;
}

export interface HistoryCommitViewState {
  requested: boolean;
  detail: GitHistoryCommitDetail | null;
  loadError: string | null;
  loading: boolean;
  scrollTop: number;
  collapsed: Readonly<Record<string, boolean>>;
  files: Readonly<Record<string, HistoryCommitFileState>>;
}

const DEFAULT_STATE: HistoryCommitViewState = {
  requested: false,
  detail: null,
  loadError: null,
  loading: true,
  scrollTop: 0,
  collapsed: {},
  files: {},
};

const states = new Map<string, HistoryCommitViewState>();
const listeners = new Set<() => void>();

export function historyCommitOwnerKey(
  sessionId: string | null | undefined,
  workingTreeId: string | null,
  sha: string,
): string | null {
  return sessionId && workingTreeId && sha
    ? JSON.stringify([sessionId, workingTreeId, sha])
    : null;
}

export function getHistoryCommitState(key: string): HistoryCommitViewState {
  return states.get(key) ?? DEFAULT_STATE;
}

function patch(key: string, changes: Partial<HistoryCommitViewState>): void {
  states.set(key, { ...getHistoryCommitState(key), ...changes });
  for (const listener of listeners) listener();
}

export function useHistoryCommitState(key: string): HistoryCommitViewState {
  const snapshot = useCallback(() => getHistoryCommitState(key), [key]);
  return useSyncExternalStore(
    listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot,
  );
}

export function patchHistoryCommitState(
  key: string,
  changes: Partial<HistoryCommitViewState>,
): void {
  patch(key, changes);
}

export function setHistoryCommitCollapsed(
  key: string,
  path: string,
  collapsed: boolean,
): void {
  const state = getHistoryCommitState(key);
  patch(key, { collapsed: { ...state.collapsed, [path]: collapsed } });
}

export function setHistoryCommitFileState(
  key: string,
  path: string,
  fileState: HistoryCommitFileState,
): void {
  const state = getHistoryCommitState(key);
  patch(key, { files: { ...state.files, [path]: fileState } });
}

export function saveHistoryCommitScroll(key: string, scrollTop: number): void {
  states.set(key, { ...getHistoryCommitState(key), scrollTop });
}

export function __resetHistoryCommitForTests(): void {
  states.clear();
}
