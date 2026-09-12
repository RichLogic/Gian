/**
 * React binding for the RemoteUiController: the app reads state through
 * useSyncExternalStore and calls `controller.actions.*` — components never
 * hold their own transport, cookie, crypto, or fetch logic.
 */

import { createContext, useContext, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { RemoteUiActions, RemoteUiController, RemoteUiState } from '../controller/types.js';

const Ctx = createContext<RemoteUiController | null>(null);

export function ControllerProvider({
  controller,
  children,
}: {
  controller: RemoteUiController;
  children: ReactNode;
}) {
  return <Ctx.Provider value={controller}>{children}</Ctx.Provider>;
}

export function useController(): RemoteUiController {
  const controller = useContext(Ctx);
  if (!controller) throw new Error('RemoteUiController is not provided');
  return controller;
}

export function useRemoteState(): RemoteUiState {
  const controller = useController();
  return useSyncExternalStore(
    (listener) => controller.subscribe(listener),
    () => controller.state,
    () => controller.state,
  );
}

export function useRemoteActions(): RemoteUiActions {
  return useController().actions;
}
