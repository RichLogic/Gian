import { useCallback, useSyncExternalStore } from 'react';

export interface FilesInspectorViewState {
  query: string;
  reloadRevision: number;
  scrollTop: number;
  folderOpen: Readonly<Record<string, boolean>>;
}

const DEFAULT_STATE: FilesInspectorViewState = {
  query: '',
  reloadRevision: 0,
  scrollTop: 0,
  folderOpen: {},
};

const states = new Map<string, FilesInspectorViewState>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function filesInspectorOwnerKey(
  sessionId: string | null | undefined,
  workingTreeId: string | null,
): string | null {
  return sessionId && workingTreeId
    ? JSON.stringify([sessionId, workingTreeId])
    : null;
}

export function getFilesInspectorState(ownerKey: string): FilesInspectorViewState {
  return states.get(ownerKey) ?? DEFAULT_STATE;
}

function patch(ownerKey: string, changes: Partial<FilesInspectorViewState>): void {
  states.set(ownerKey, { ...getFilesInspectorState(ownerKey), ...changes });
  emit();
}

export function useFilesInspectorState(ownerKey: string | null): FilesInspectorViewState {
  const snapshot = useCallback(
    () => ownerKey ? getFilesInspectorState(ownerKey) : DEFAULT_STATE,
    [ownerKey],
  );
  return useSyncExternalStore(subscribe, snapshot);
}

export function setFilesInspectorQuery(ownerKey: string, query: string): void {
  if (getFilesInspectorState(ownerKey).query === query) return;
  patch(ownerKey, { query });
}

export function refreshFilesInspector(ownerKey: string): void {
  const current = getFilesInspectorState(ownerKey);
  patch(ownerKey, { reloadRevision: current.reloadRevision + 1 });
}

export function saveFilesInspectorScroll(ownerKey: string, scrollTop: number): void {
  const current = getFilesInspectorState(ownerKey);
  states.set(ownerKey, { ...current, scrollTop });
}

export function setFilesFolderOpen(
  ownerKey: string,
  path: string,
  open: boolean,
): void {
  const current = getFilesInspectorState(ownerKey);
  if (current.folderOpen[path] === open) return;
  patch(ownerKey, {
    folderOpen: { ...current.folderOpen, [path]: open },
  });
}

export function toggleFilesFolder(
  ownerKey: string,
  path: string,
  defaultOpen = false,
): void {
  const current = getFilesInspectorState(ownerKey);
  const open = current.folderOpen[path] ?? defaultOpen;
  setFilesFolderOpen(ownerKey, path, !open);
}

export function __resetFilesInspectorForTests(): void {
  states.clear();
}
