import { describe, expect, it } from 'vitest';
import {
  UPWARD_POPOVER_GAP,
  UPWARD_POPOVER_MARGIN,
  UPWARD_POPOVER_MIN_HEIGHT,
  UPWARD_POPOVER_PREFERRED_MAX_HEIGHT,
  rightAlignedPopoverLeft,
  upwardPopoverLayout,
} from '../src/components/composer/upward-popover.js';

const VIEWPORT = { viewportWidth: 1200, viewportHeight: 800 };

describe('upwardPopoverLayout', () => {
  it('anchors the bottom edge just above the composer box top, not the caret', () => {
    // Caret sits mid-editor (caret top 660) but the sheet must hang from the
    // composer box top (640) so it reads as an upward sheet like the + menu.
    const layout = upwardPopoverLayout({
      caretLeft: 120,
      composerTop: 640,
      popoverWidth: 420,
      ...VIEWPORT,
    });
    expect(layout.bottom).toBe(800 - 640 + UPWARD_POPOVER_GAP);
    expect(layout.left).toBe(120);
    // Plenty of room above: the preferred ~7.5-row cap wins.
    expect(layout.maxHeight).toBe(UPWARD_POPOVER_PREFERRED_MAX_HEIGHT);
  });

  it('clamps the height to the space above the composer when the window is short', () => {
    const layout = upwardPopoverLayout({
      caretLeft: 120,
      composerTop: 200,
      popoverWidth: 420,
      ...VIEWPORT,
    });
    expect(layout.maxHeight).toBe(200 - UPWARD_POPOVER_GAP - UPWARD_POPOVER_MARGIN);
  });

  it('keeps a usable floor height even with almost no space above', () => {
    const layout = upwardPopoverLayout({
      caretLeft: 120,
      composerTop: 0,
      popoverWidth: 420,
      ...VIEWPORT,
    });
    expect(layout.maxHeight).toBe(UPWARD_POPOVER_MIN_HEIGHT);
  });

  it('clamps the left edge to the viewport on the right', () => {
    const layout = upwardPopoverLayout({
      caretLeft: 1180,
      composerTop: 640,
      popoverWidth: 420,
      ...VIEWPORT,
    });
    expect(layout.left).toBe(1200 - 420 - UPWARD_POPOVER_MARGIN);
  });

  it('clamps the left edge to the viewport margin on the left', () => {
    const layout = upwardPopoverLayout({
      caretLeft: 2,
      composerTop: 640,
      popoverWidth: 420,
      ...VIEWPORT,
    });
    expect(layout.left).toBe(UPWARD_POPOVER_MARGIN);
  });
});

describe('rightAlignedPopoverLeft', () => {
  it('right-aligns the popover to the trigger, matching useUpDrop align:right', () => {
    // The + menu and the session-reference picker share this anchor: the
    // popover's right edge lands on the button's right edge.
    expect(rightAlignedPopoverLeft({
      anchorRight: 1150,
      popoverWidth: 340,
      viewportWidth: 1200,
    })).toBe(1150 - 340);
  });

  it('clamps to the viewport margin when the trigger sits near the right edge', () => {
    expect(rightAlignedPopoverLeft({
      anchorRight: 1199,
      popoverWidth: 340,
      viewportWidth: 1200,
    })).toBe(1200 - 340 - UPWARD_POPOVER_MARGIN);
  });

  it('clamps to the left margin when the popover is wider than the anchor reaches', () => {
    expect(rightAlignedPopoverLeft({
      anchorRight: 100,
      popoverWidth: 340,
      viewportWidth: 1200,
    })).toBe(UPWARD_POPOVER_MARGIN);
  });

  it('fits the width to a narrow viewport before anchoring', () => {
    expect(rightAlignedPopoverLeft({
      anchorRight: 290,
      popoverWidth: 340,
      viewportWidth: 300,
    })).toBe(UPWARD_POPOVER_MARGIN);
  });
});
