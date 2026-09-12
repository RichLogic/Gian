/**
 * Custom page (Issue #50) layout contract — the detail sheet is the shared
 * panel-2 shell (`.p2`), a real second track of the content column, not a
 * fixed overlay:
 *
 * - `side` (wide): list and detail sit side by side. The tracks are
 *   main ≥ MAIN_MIN (flexible) + detail DETAIL_MIN…DETAIL_MAX (matching the
 *   `.p2` clamp).
 * - `swap` (space below the two minimum tracks + gutter): the detail
 *   replaces the content column with a back affordance; the list stays
 *   mounted (hidden) so search text, filters, and scroll position survive.
 *
 * The decision is a pure function of the measured content-column width so
 * the mode never depends on window chrome, sidebar state, or other panels.
 */
export const CUSTOM_MAIN_MIN_PX = 360;
export const CUSTOM_DETAIL_MIN_PX = 340;
export const CUSTOM_DETAIL_IDEAL_PX = 440;
export const CUSTOM_DETAIL_MAX_PX = 640;
export const CUSTOM_TRACK_GUTTER_PX = 3;

export type CustomDetailLayout = 'side' | 'swap';

export function customDetailLayout(contentWidthPx: number): CustomDetailLayout {
  // An unmeasurable width (jsdom, pre-layout) stays on the wide track.
  if (contentWidthPx <= 0) return 'side';
  return contentWidthPx < CUSTOM_MAIN_MIN_PX + CUSTOM_DETAIL_MIN_PX + CUSTOM_TRACK_GUTTER_PX
    ? 'swap'
    : 'side';
}
