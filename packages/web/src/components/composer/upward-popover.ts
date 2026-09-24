/**
 * Geometry for the composer's upward-opening popovers (`@` file mentions,
 * and any other caret-triggered sheet): the popover's bottom edge sits just
 * above the composer box top and the sheet grows upward — the same `bottom`
 * anchoring `useUpDrop` gives the `+` / option menus and the slash popover's
 * composer-rect positioning. Pure so the layout is unit-testable without a
 * DOM; the Lexical typeahead's own caret-relative flip cannot express this
 * (it compares against the small contenteditable rect, not the composer box).
 */

export interface UpwardPopoverLayout {
  left: number;
  bottom: number;
  maxHeight: number;
}

/** Gap between the composer box top and the popover's bottom edge — the same
 *  4px the slash popover uses. */
export const UPWARD_POPOVER_GAP = 4;
/** Viewport edge margin used when clamping, matching useUpDrop. */
export const UPWARD_POPOVER_MARGIN = 8;
/** Preferred cap: ~7.5 rows plus the hint footer (the 8th row peeks to signal
 *  scrollability), matching `.cmp-file-pop`. */
export const UPWARD_POPOVER_PREFERRED_MAX_HEIGHT = 288;
/** Floor for a short window: below this the sheet would be unusable, so it
 *  keeps this height and scrolls rather than collapsing to nothing. */
export const UPWARD_POPOVER_MIN_HEIGHT = 96;

export function upwardPopoverLayout({
  caretLeft,
  composerTop,
  viewportWidth,
  viewportHeight,
  popoverWidth,
}: {
  /** Caret x in viewport coordinates — the popover's left edge aligns here. */
  caretLeft: number;
  /** Composer box top in viewport coordinates; the popover's bottom edge
   *  sits `UPWARD_POPOVER_GAP` above it. */
  composerTop: number;
  viewportWidth: number;
  viewportHeight: number;
  /** Assumed width for right-edge clamping (pass the CSS max-width). */
  popoverWidth: number;
}): UpwardPopoverLayout {
  const left = Math.max(
    UPWARD_POPOVER_MARGIN,
    Math.min(caretLeft, viewportWidth - popoverWidth - UPWARD_POPOVER_MARGIN),
  );
  const bottom = viewportHeight - composerTop + UPWARD_POPOVER_GAP;
  const available = composerTop - UPWARD_POPOVER_GAP - UPWARD_POPOVER_MARGIN;
  const maxHeight = Math.max(
    UPWARD_POPOVER_MIN_HEIGHT,
    Math.min(UPWARD_POPOVER_PREFERRED_MAX_HEIGHT, available),
  );
  return { left, bottom, maxHeight };
}

/**
 * Left edge for a popover that right-aligns to its trigger's right edge — the
 * same anchor `useUpDrop`'s `align: 'right'` gives the `+` menu, so a sheet
 * opened from that menu (e.g. the session-reference picker) stacks on the
 * same anchor instead of opening shifted right.
 */
export function rightAlignedPopoverLeft({
  anchorRight,
  popoverWidth,
  viewportWidth,
}: {
  /** Trigger's right edge in viewport coordinates. */
  anchorRight: number;
  popoverWidth: number;
  viewportWidth: number;
}): number {
  const fittedWidth = Math.min(popoverWidth, viewportWidth - UPWARD_POPOVER_MARGIN * 2);
  return Math.max(
    UPWARD_POPOVER_MARGIN,
    Math.min(anchorRight - fittedWidth, viewportWidth - fittedWidth - UPWARD_POPOVER_MARGIN),
  );
}
