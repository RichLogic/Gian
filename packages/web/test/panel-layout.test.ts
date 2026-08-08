import { describe, expect, it } from 'vitest';
import {
  fitOuterPanelWidths,
  middlePanelMin,
  outerPanelBudget,
  resizeMainSheet,
  resizeSheetInspector,
  resizeSidebarMain,
  sheetWidthForMiddleRatio,
} from '../src/presentation/panel-layout.js';
import type { PanelDragSnapshot } from '../src/presentation/panel-layout.js';

function snapshot(overrides: Partial<PanelDragSnapshot> = {}): PanelDragSnapshot {
  return {
    usableWidth: 1_200,
    sidebarWidth: 272,
    mainWidth: 420,
    sheetWidth: 480,
    inspectorWidth: 300,
    sidebarVisible: true,
    inspectorVisible: true,
    ...overrides,
  };
}

describe('four-panel resize geometry', () => {
  it('reserves one quarter for each middle panel and half for both outer panels', () => {
    expect(middlePanelMin(1_200)).toBe(300);
    expect(middlePanelMin(840)).toBe(210);
    expect(outerPanelBudget(1_200)).toBe(600);
    expect(outerPanelBudget(840)).toBe(420);
  });

  it('resizes only Sidebar and Panel 1 at their seam', () => {
    const start = snapshot({ mainWidth: 500, inspectorVisible: false });
    expect(resizeSidebarMain(start, 80)).toEqual({ sidebarWidth: 352 });
    // Panel 1's quarter floor caps Sidebar growth before its own 480px max.
    expect(resizeSidebarMain(start, 300)).toEqual({ sidebarWidth: 472 });
  });

  it('also caps Sidebar against the shared outer-panel budget', () => {
    expect(resizeSidebarMain(snapshot({ mainWidth: 500 }), 300)).toEqual({
      sidebarWidth: 300,
    });
  });

  it('hard-stops Sidebar at 200px without drag-to-hide state', () => {
    expect(resizeSidebarMain(snapshot(), -1_000)).toEqual({ sidebarWidth: 200 });
  });

  it('resizes only Panel 2 and Panel 3 at their seam', () => {
    const start = snapshot();
    expect(resizeSheetInspector(start, 50)).toEqual({
      sheetWidth: 530,
      inspectorWidth: 250,
    });
    // The shared outer budget caps Panel 3 before Panel 2 reaches its floor.
    expect(resizeSheetInspector(start, -300)).toEqual({
      sheetWidth: 452,
      inspectorWidth: 328,
    });
  });

  it('hard-stops Panel 3 at 220px without drag-to-hide state', () => {
    expect(resizeSheetInspector(snapshot(), 1_000)).toEqual({
      sheetWidth: 560,
      inspectorWidth: 220,
    });
  });

  it('transfers middle-seam overflow to Panel 3 after Panel 2 reaches its floor', () => {
    const start = snapshot();
    expect(resizeMainSheet(start, 100)).toEqual({ sheetWidth: 380 });
    expect(resizeMainSheet(start, 200)).toEqual({
      sheetWidth: 300,
      inspectorWidth: 280,
    });
    expect(resizeMainSheet(start, 1_000)).toEqual({
      sheetWidth: 300,
      inspectorWidth: 220,
    });
  });

  it('transfers middle-seam overflow to Sidebar after Panel 1 reaches its floor', () => {
    const start = snapshot();
    expect(resizeMainSheet(start, -100)).toEqual({ sheetWidth: 580 });
    expect(resizeMainSheet(start, -160)).toEqual({
      sheetWidth: 640,
      sidebarWidth: 232,
    });
    expect(resizeMainSheet(start, -1_000)).toEqual({
      sheetWidth: 672,
      sidebarWidth: 200,
    });
  });

  it('hard-stops the middle seam when the matching outer panel is hidden', () => {
    expect(resizeMainSheet(snapshot({ inspectorVisible: false }), 400)).toEqual({
      sheetWidth: 300,
    });
    expect(resizeMainSheet(snapshot({ sidebarVisible: false }), -400)).toEqual({
      sheetWidth: 600,
    });
  });

  it('restores the persisted middle ratio while respecting both quarter floors', () => {
    expect(sheetWidthForMiddleRatio(800, 0.5, 1_200)).toBe(400);
    expect(sheetWidthForMiddleRatio(800, 0.9, 1_200)).toBe(300);
    expect(sheetWidthForMiddleRatio(800, 0.1, 1_200)).toBe(500);
  });
});

describe('responsive outer-panel fitting', () => {
  it('shrinks Panel 3 first, then Sidebar, to fit the shared half-width budget', () => {
    expect(fitOuterPanelWidths(1_200, 400, 350, true, true)).toEqual({
      sidebarWidth: 380,
      inspectorWidth: 220,
    });
    expect(fitOuterPanelWidths(1_000, 272, 300, true, true)).toEqual({
      sidebarWidth: 272,
      inspectorWidth: 228,
    });
    expect(fitOuterPanelWidths(840, 272, 300, true, true)).toEqual({
      sidebarWidth: 200,
      inspectorWidth: 220,
    });
  });

  it('hides Panel 3 first when both outer floors no longer fit', () => {
    expect(fitOuterPanelWidths(800, 272, 300, true, true)).toEqual({
      sidebarWidth: 272,
      inspectorWidth: 300,
      hideTarget: 'inspector',
    });
  });

  it('hides a lone outer panel only when its own floor no longer fits', () => {
    expect(fitOuterPanelWidths(380, 272, 300, true, false)).toEqual({
      sidebarWidth: 272,
      inspectorWidth: 300,
      hideTarget: 'sidebar',
    });
    expect(fitOuterPanelWidths(430, 272, 300, false, true)).toEqual({
      sidebarWidth: 272,
      inspectorWidth: 300,
      hideTarget: 'inspector',
    });
  });

  it('does not automatically reopen hidden panels when more room becomes available', () => {
    expect(fitOuterPanelWidths(1_600, 272, 300, false, false)).toEqual({
      sidebarWidth: 272,
      inspectorWidth: 300,
    });
  });
});
