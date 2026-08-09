import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type UnderbarPanelId = 'plan' | 'agent' | 'diff';

interface UnderbarPanelController {
  openPanel: UnderbarPanelId | null;
  togglePanel: (panel: UnderbarPanelId) => void;
  closePanel: () => void;
}

const UnderbarPanelContext = createContext<UnderbarPanelController | null>(null);

/**
 * One controller for every upward panel above the composer. Panel sections and
 * their triggers opt into the interactive surface with
 * `data-underbar-panel-interactive`; every other pointer target is treated as
 * outside/blank space and closes the active panel.
 */
export function UnderbarPanelGroup({
  sessionId,
  children,
}: {
  sessionId: string;
  children: ReactNode;
}) {
  const [openPanel, setOpenPanel] = useState<UnderbarPanelId | null>(null);
  const closePanel = useCallback(() => setOpenPanel(null), []);
  const togglePanel = useCallback((panel: UnderbarPanelId) => {
    setOpenPanel(current => current === panel ? null : panel);
  }, []);

  useEffect(() => {
    closePanel();
  }, [closePanel, sessionId]);

  useEffect(() => {
    if (!openPanel) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('[data-underbar-panel-interactive]')) {
        return;
      }
      closePanel();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closePanel();
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [closePanel, openPanel]);

  const controller = useMemo<UnderbarPanelController>(() => ({
    openPanel,
    togglePanel,
    closePanel,
  }), [closePanel, openPanel, togglePanel]);

  return (
    <UnderbarPanelContext.Provider value={controller}>
      <div className="main-underbar">{children}</div>
    </UnderbarPanelContext.Provider>
  );
}

export function useUnderbarPanelController(): UnderbarPanelController | null {
  return useContext(UnderbarPanelContext);
}
