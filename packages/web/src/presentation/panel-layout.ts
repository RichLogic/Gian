export const SIDEBAR_MIN_PX = 200;
export const SIDEBAR_MAX_PX = 480;
export const INSPECTOR_MIN_PX = 220;
export const INSPECTOR_MAX_PX = 500;

export type PanelCollapseTarget = 'sidebar' | 'inspector';

export interface PanelDragSnapshot {
  /** Width available to panels after Dock and visible seams/gaps. */
  usableWidth: number;
  sidebarWidth: number;
  mainWidth: number;
  sheetWidth: number;
  inspectorWidth: number;
  sidebarVisible: boolean;
  inspectorVisible: boolean;
}

export interface PanelDragResult {
  sidebarWidth?: number;
  sheetWidth?: number;
  inspectorWidth?: number;
}

export interface OuterPanelFit {
  sidebarWidth: number;
  inspectorWidth: number;
  hideTarget?: PanelCollapseTarget;
}

export function clampPanelValue(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Panel 1 and Panel 2 each reserve one quarter of the panel-only width. */
export function middlePanelMin(usableWidth: number): number {
  return Math.max(0, usableWidth / 4);
}

/** The two outer panels together may consume at most half of panel-only width. */
export function outerPanelBudget(usableWidth: number): number {
  return Math.max(0, usableWidth / 2);
}

/**
 * Fit the visible outer panels into their shared half-width budget. Window and
 * zoom pressure shrinks Panel 3 first, then Sidebar. Once the budget cannot
 * hold both floors, Panel 3 hides; Sidebar hides only if its own floor no
 * longer fits. Hidden panels never auto-reopen here.
 */
export function fitOuterPanelWidths(
  usableWidth: number,
  sidebarWidth: number,
  inspectorWidth: number,
  sidebarVisible: boolean,
  inspectorVisible: boolean,
): OuterPanelFit {
  const budget = outerPanelBudget(usableWidth);
  let nextSidebar = clampPanelValue(sidebarWidth, SIDEBAR_MIN_PX, SIDEBAR_MAX_PX);
  let nextInspector = clampPanelValue(inspectorWidth, INSPECTOR_MIN_PX, INSPECTOR_MAX_PX);

  if (sidebarVisible && inspectorVisible) {
    if (budget + 0.5 < SIDEBAR_MIN_PX + INSPECTOR_MIN_PX) {
      return {
        sidebarWidth: nextSidebar,
        inspectorWidth: nextInspector,
        hideTarget: 'inspector',
      };
    }

    let excess = Math.max(0, nextSidebar + nextInspector - budget);
    const inspectorReduction = Math.min(excess, nextInspector - INSPECTOR_MIN_PX);
    nextInspector -= inspectorReduction;
    excess -= inspectorReduction;
    nextSidebar -= Math.min(excess, nextSidebar - SIDEBAR_MIN_PX);
  } else if (sidebarVisible) {
    if (budget + 0.5 < SIDEBAR_MIN_PX) {
      return {
        sidebarWidth: nextSidebar,
        inspectorWidth: nextInspector,
        hideTarget: 'sidebar',
      };
    }
    nextSidebar = Math.min(nextSidebar, budget);
  } else if (inspectorVisible) {
    if (budget + 0.5 < INSPECTOR_MIN_PX) {
      return {
        sidebarWidth: nextSidebar,
        inspectorWidth: nextInspector,
        hideTarget: 'inspector',
      };
    }
    nextInspector = Math.min(nextInspector, budget);
  }

  return { sidebarWidth: nextSidebar, inspectorWidth: nextInspector };
}

/** Sidebar | Panel 1: Panel 2/3 never move and the seam hard-stops at a floor. */
export function resizeSidebarMain(
  start: PanelDragSnapshot,
  deltaX: number,
): PanelDragResult {
  const mainMin = middlePanelMin(start.usableWidth);
  const rawSidebar = start.sidebarWidth + deltaX;
  const maxFromMain = start.sidebarWidth + Math.max(0, start.mainWidth - mainMin);
  const maxFromOuterBudget = outerPanelBudget(start.usableWidth)
    - (start.inspectorVisible ? start.inspectorWidth : 0);
  const maxSidebar = Math.max(
    SIDEBAR_MIN_PX,
    Math.min(SIDEBAR_MAX_PX, maxFromMain, maxFromOuterBudget),
  );

  return {
    sidebarWidth: clampPanelValue(rawSidebar, SIDEBAR_MIN_PX, maxSidebar),
  };
}

/** Panel 2 | Panel 3: Sidebar/Panel 1 never move and both sides hard-stop. */
export function resizeSheetInspector(
  start: PanelDragSnapshot,
  deltaX: number,
): PanelDragResult {
  const sheetMin = middlePanelMin(start.usableWidth);
  const maxFromOuterBudget = outerPanelBudget(start.usableWidth)
    - (start.sidebarVisible ? start.sidebarWidth : 0);
  const maxInspector = Math.max(
    INSPECTOR_MIN_PX,
    Math.min(INSPECTOR_MAX_PX, maxFromOuterBudget),
  );
  const minDelta = Math.max(
    sheetMin - start.sheetWidth,
    start.inspectorWidth - maxInspector,
  );
  const maxDelta = start.inspectorWidth - INSPECTOR_MIN_PX;
  const appliedDelta = clampPanelValue(deltaX, minDelta, maxDelta);

  return {
    sheetWidth: start.sheetWidth + appliedDelta,
    inspectorWidth: start.inspectorWidth - appliedDelta,
  };
}

/**
 * Panel 1 | Panel 2: resize the middle pair first. Once one middle panel hits
 * its quarter-width floor, consume the matching outer panel down to its floor,
 * then hard-stop. Dragging never changes visibility.
 */
export function resizeMainSheet(
  start: PanelDragSnapshot,
  deltaX: number,
): PanelDragResult {
  const middleMin = middlePanelMin(start.usableWidth);

  if (deltaX >= 0) {
    const sheetCapacity = Math.max(0, start.sheetWidth - middleMin);
    if (deltaX <= sheetCapacity || !start.inspectorVisible) {
      const applied = Math.min(deltaX, sheetCapacity);
      return { sheetWidth: start.sheetWidth - applied };
    }

    const outerDelta = deltaX - sheetCapacity;
    const inspectorCapacity = Math.max(0, start.inspectorWidth - INSPECTOR_MIN_PX);
    const appliedOuter = Math.min(outerDelta, inspectorCapacity);
    return {
      sheetWidth: middleMin,
      inspectorWidth: start.inspectorWidth - appliedOuter,
    };
  }

  const dragLeft = -deltaX;
  const mainCapacity = Math.max(0, start.mainWidth - middleMin);
  if (dragLeft <= mainCapacity || !start.sidebarVisible) {
    const applied = Math.min(dragLeft, mainCapacity);
    return { sheetWidth: start.sheetWidth + applied };
  }

  const outerDelta = dragLeft - mainCapacity;
  const sidebarCapacity = Math.max(0, start.sidebarWidth - SIDEBAR_MIN_PX);
  const appliedOuter = Math.min(outerDelta, sidebarCapacity);
  return {
    sidebarWidth: start.sidebarWidth - appliedOuter,
    sheetWidth: start.sheetWidth + mainCapacity + appliedOuter,
  };
}

export function clampMiddleRatio(value: number): number {
  return clampPanelValue(value, 0.05, 0.95);
}

export function sheetWidthForMiddleRatio(
  middleWidth: number,
  mainRatio: number,
  usableWidth: number,
): number {
  const min = middlePanelMin(usableWidth);
  if (middleWidth <= min * 2) return Math.max(0, middleWidth - min);
  return clampPanelValue(
    middleWidth * (1 - clampMiddleRatio(mainRatio)),
    min,
    middleWidth - min,
  );
}
