import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { CSSProperties, Dispatch, MouseEvent as ReactMouseEvent, SetStateAction } from 'react';
import type { RailLayoutController } from '../components/RailLayout.js';
import {
  INSPECTOR_MAX_PX,
  INSPECTOR_MIN_PX,
  SIDEBAR_MAX_PX,
  SIDEBAR_MIN_PX,
  clampMiddleRatio,
  clampPanelValue,
  fitOuterPanelWidths,
  middlePanelMin,
  resizeMainSheet,
  resizeSheetInspector,
  resizeSidebarMain,
  sheetWidthForMiddleRatio,
} from '../presentation/panel-layout.js';
import type { PanelDragResult, PanelDragSnapshot } from '../presentation/panel-layout.js';

const DEFAULT_SIDEBAR_WIDTH = 272;
const DEFAULT_SHEET_WIDTH = 600;
const DEFAULT_INSPECTOR_WIDTH = 280;
const DEFAULT_MAIN_RATIO = 0.5;
const LAYOUT_SETTLE_MS = 200;

const STORAGE = {
  sidebarWidth: 'rail.w',
  sidebarCollapsed: 'rail.w.collapsed',
  inspectorWidth: 'gian.layout.inspector-w',
  mainRatio: 'gian.layout.main-ratio',
} as const;

type PanelSeam = 'sidebar-main' | 'main-sheet' | 'sheet-inspector';

interface UsePanelLayoutInput {
  enabled: boolean;
  panel1Visible: boolean;
  panel2Visible: boolean;
  inspectorVisible: boolean;
  p3Collapsed: boolean;
  setP3Collapsed: Dispatch<SetStateAction<boolean>>;
}

function readNumber(key: string, fallback: number, min: number, max: number): number {
  if (typeof window === 'undefined') return fallback;
  const stored = window.localStorage.getItem(key);
  if (stored === null) return fallback;
  const value = Number(stored);
  return Number.isFinite(value) ? clampPanelValue(value, min, max) : fallback;
}

function directChildWithClass(parent: Element | null, className: string): HTMLElement | null {
  if (!parent) return null;
  return Array.from(parent.children).find(child => child.classList.contains(className)) as HTMLElement | undefined ?? null;
}

function horizontalGap(
  left: DOMRect | undefined,
  right: DOMRect | undefined,
): number {
  if (!left || !right || left.width <= 0 || right.width <= 0) return 0;
  return Math.max(0, right.left - left.right);
}

export function usePanelLayout({
  enabled,
  panel1Visible,
  panel2Visible,
  inspectorVisible,
  p3Collapsed,
  setP3Collapsed,
}: UsePanelLayoutInput) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    readNumber(STORAGE.sidebarWidth, DEFAULT_SIDEBAR_WIDTH, SIDEBAR_MIN_PX, SIDEBAR_MAX_PX));
  const [sidebarCollapsed, setSidebarCollapsedState] = useState(() =>
    typeof window !== 'undefined' && window.localStorage.getItem(STORAGE.sidebarCollapsed) === '1');
  const [sheetWidth, setSheetWidth] = useState(DEFAULT_SHEET_WIDTH);
  const [inspectorWidth, setInspectorWidth] = useState(() =>
    readNumber(STORAGE.inspectorWidth, DEFAULT_INSPECTOR_WIDTH, INSPECTOR_MIN_PX, INSPECTOR_MAX_PX));
  const mainRatioRef = useRef(readNumber(STORAGE.mainRatio, DEFAULT_MAIN_RATIO, 0.05, 0.95));
  const [resizing, setResizing] = useState(false);
  const resizingRef = useRef(false);
  const sidebarCollapsedRef = useRef(sidebarCollapsed);
  // Responsive fitting changes rendered widths without overwriting the sizes
  // the user chose. Visible panels can recover those sizes after pressure lifts.
  const sidebarPreferredWidthRef = useRef(sidebarWidth);
  const sidebarWidthRef = useRef(sidebarWidth);
  const sheetWidthRef = useRef(sheetWidth);
  const inspectorPreferredWidthRef = useRef(inspectorWidth);
  const inspectorWidthRef = useRef(inspectorWidth);
  const inspectorVisibleRef = useRef(inspectorVisible);
  const panel1VisibleRef = useRef(panel1Visible);
  const panel2VisibleRef = useRef(panel2Visible);

  sidebarCollapsedRef.current = sidebarCollapsed;
  sidebarWidthRef.current = sidebarWidth;
  sheetWidthRef.current = sheetWidth;
  inspectorWidthRef.current = inspectorWidth;
  inspectorVisibleRef.current = inspectorVisible;
  panel1VisibleRef.current = panel1Visible;
  panel2VisibleRef.current = panel2Visible;

  useEffect(() => {
    window.localStorage.setItem(STORAGE.sidebarCollapsed, sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);
  const setSidebarCollapsed = useCallback((next: boolean) => {
    setSidebarCollapsedState(next);
  }, []);

  const getElements = useCallback(() => {
    const body = bodyRef.current;
    const view = directChildWithClass(body, 'view');
    const sidebar = directChildWithClass(view, 'sidebar');
    const main = directChildWithClass(view, 'main');
    const sheet = directChildWithClass(body, 'sheet')
      ?? directChildWithClass(body, 'chat-context-panel');
    const inspector = directChildWithClass(body, 'inspector');
    const dock = directChildWithClass(body, 'dock');
    return { body, view, sidebar, main, sheet, inspector, dock };
  }, []);

  const measure = useCallback((): PanelDragSnapshot | null => {
    const { body, view, sidebar, main, sheet, inspector, dock } = getElements();
    if (!body || !view) return null;
    const bodyRect = body.getBoundingClientRect();
    const dockRect = dock?.getBoundingClientRect();
    const sidebarRect = sidebar?.getBoundingClientRect();
    const mainRect = main?.getBoundingClientRect();
    const sheetRect = sheet?.getBoundingClientRect();
    const inspectorRect = inspector?.getBoundingClientRect();
    const bodyWidth = body.clientWidth || bodyRect.width || window.innerWidth;
    const dockWidth = dockRect?.width || dock?.offsetWidth || 0;
    const chromeWidth = horizontalGap(sidebarRect, mainRect)
      + horizontalGap(mainRect, sheetRect)
      + horizontalGap(sheetRect, inspectorRect);

    return {
      usableWidth: Math.max(0, bodyWidth - dockWidth - chromeWidth),
      sidebarWidth: sidebarRect?.width || sidebarWidthRef.current,
      mainWidth: mainRect?.width || 0,
      sheetWidth: sheetRect?.width || sheetWidthRef.current,
      inspectorWidth: inspectorRect?.width || inspectorWidthRef.current,
      sidebarVisible: !sidebarCollapsedRef.current,
      inspectorVisible: inspectorVisibleRef.current,
    };
  }, [getElements]);

  const recordMiddleRatio = useCallback(() => {
    const { main, sheet } = getElements();
    const mainWidthNow = main?.getBoundingClientRect().width ?? 0;
    const sheetWidthNow = sheet?.getBoundingClientRect().width ?? 0;
    const total = mainWidthNow + sheetWidthNow;
    if (total <= 0 || mainWidthNow <= 0 || sheetWidthNow <= 0) return;
    const next = clampMiddleRatio(mainWidthNow / total);
    mainRatioRef.current = next;
    window.localStorage.setItem(STORAGE.mainRatio, String(next));
  }, [getElements]);

  const applyDragResult = useCallback((result: PanelDragResult) => {
    if (result.sidebarWidth !== undefined) {
      sidebarPreferredWidthRef.current = result.sidebarWidth;
      window.localStorage.setItem(STORAGE.sidebarWidth, String(result.sidebarWidth));
      setSidebarWidth(result.sidebarWidth);
    }
    if (result.sheetWidth !== undefined) setSheetWidth(result.sheetWidth);
    if (result.inspectorWidth !== undefined) {
      inspectorPreferredWidthRef.current = result.inspectorWidth;
      window.localStorage.setItem(STORAGE.inspectorWidth, String(result.inspectorWidth));
      setInspectorWidth(result.inspectorWidth);
    }
  }, []);

  const beginDrag = useCallback((seam: PanelSeam, event: ReactMouseEvent) => {
    if (event.button !== 0) return;
    const start = measure();
    if (!start) return;
    if (seam === 'sidebar-main' && (!start.sidebarVisible || start.mainWidth <= 0)) return;
    if (seam === 'main-sheet' && (start.mainWidth <= 0 || start.sheetWidth <= 0)) return;
    if (seam === 'sheet-inspector' && (start.sheetWidth <= 0 || !start.inspectorVisible)) return;

    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    const startX = event.clientX;
    let finished = false;
    handle.classList.add('dragging');
    resizingRef.current = true;
    setResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const cleanup = (saveRatio: boolean) => {
      if (finished) return;
      finished = true;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      handle.classList.remove('dragging');
      resizingRef.current = false;
      setResizing(false);
      if (saveRatio) window.requestAnimationFrame(recordMiddleRatio);
    };

    const onMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const result = seam === 'sidebar-main'
        ? resizeSidebarMain(start, deltaX)
        : seam === 'main-sheet'
          ? resizeMainSheet(start, deltaX)
          : resizeSheetInspector(start, deltaX);
      applyDragResult(result);
    };

    const onUp = () => cleanup(true);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [applyDragResult, measure, recordMiddleRatio]);

  const reconcileLayout = useCallback(() => {
    if (resizingRef.current) return;
    const snapshot = measure();
    if (!snapshot || snapshot.usableWidth <= 0) return;
    const outerFit = fitOuterPanelWidths(
      snapshot.usableWidth,
      sidebarPreferredWidthRef.current,
      inspectorPreferredWidthRef.current,
      !sidebarCollapsedRef.current,
      inspectorVisibleRef.current,
    );

    if (outerFit.hideTarget === 'inspector') {
      setP3Collapsed(true);
      return;
    }
    if (outerFit.hideTarget === 'sidebar') {
      setSidebarCollapsedState(true);
      return;
    }

    let outerWidthChanged = false;
    if (!sidebarCollapsedRef.current
      && Math.abs(outerFit.sidebarWidth - sidebarWidthRef.current) > 0.5) {
      setSidebarWidth(outerFit.sidebarWidth);
      outerWidthChanged = true;
    }
    if (inspectorVisibleRef.current
      && Math.abs(outerFit.inspectorWidth - inspectorWidthRef.current) > 0.5) {
      setInspectorWidth(outerFit.inspectorWidth);
      outerWidthChanged = true;
    }
    if (outerWidthChanged) return;

    const min = middlePanelMin(snapshot.usableWidth);

    if (!panel2VisibleRef.current) {
      if (panel1VisibleRef.current
        && snapshot.mainWidth > 0
        && snapshot.mainWidth < min
        && !sidebarCollapsedRef.current) {
        setSidebarCollapsedState(true);
      }
      return;
    }

    if (!panel1VisibleRef.current || snapshot.mainWidth <= 0) {
      if (snapshot.sheetWidth < min) setSheetWidth(min);
      return;
    }

    const middleWidth = snapshot.mainWidth + snapshot.sheetWidth;
    const targetSheet = sheetWidthForMiddleRatio(
      middleWidth,
      mainRatioRef.current,
      snapshot.usableWidth,
    );
    if (targetSheet > 0 && Math.abs(targetSheet - snapshot.sheetWidth) > 0.5) {
      setSheetWidth(targetSheet);
    }
  }, [measure, setP3Collapsed]);

  useEffect(() => {
    if (!enabled) return;
    const body = bodyRef.current;
    if (!body) return;
    const run = () => window.requestAnimationFrame(reconcileLayout);
    const observer = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(run)
      : null;
    observer?.observe(body);
    window.addEventListener('resize', run);
    const frame = window.requestAnimationFrame(reconcileLayout);
    const settled = window.setTimeout(reconcileLayout, LAYOUT_SETTLE_MS);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', run);
      window.cancelAnimationFrame(frame);
      window.clearTimeout(settled);
    };
  }, [
    enabled,
    inspectorVisible,
    panel1Visible,
    panel2Visible,
    p3Collapsed,
    reconcileLayout,
    sidebarCollapsed,
  ]);

  const railLayout = useMemo<RailLayoutController>(() => ({
    width: sidebarWidth,
    collapsed: sidebarCollapsed,
    setCollapsed: setSidebarCollapsed,
    onMouseDown: event => beginDrag('sidebar-main', event),
  }), [beginDrag, setSidebarCollapsed, sidebarCollapsed, sidebarWidth]);

  const bodyStyle = {
    '--sheet-w': `${sheetWidth}px`,
    '--inspector-w': `${inspectorWidth}px`,
  } as CSSProperties;

  return {
    bodyRef,
    bodyStyle,
    resizing,
    railLayout,
    onMainSheetMouseDown: (event: ReactMouseEvent) => beginDrag('main-sheet', event),
    onSheetInspectorMouseDown: (event: ReactMouseEvent) => beginDrag('sheet-inspector', event),
    toggleSidebar: () => setSidebarCollapsed(!sidebarCollapsedRef.current),
    toggleInspector: () => setP3Collapsed(collapsed => !collapsed),
  };
}
