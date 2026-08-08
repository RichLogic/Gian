export const MIN_ZOOM_PERCENT = 80;
export const MAX_ZOOM_PERCENT = 150;
export const ZOOM_STEP_PERCENT = 10;
export const DEFAULT_ZOOM_PERCENT = 100;

/** Keep renderer IPC and native menu zoom on the same bounded 10% scale. */
export function normalizeZoomPercent(
  value: unknown,
  fallback = DEFAULT_ZOOM_PERCENT,
): number {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : Number.NaN;
  const safe = Number.isFinite(numeric) ? numeric : fallback;
  const stepped = Math.round(safe / ZOOM_STEP_PERCENT) * ZOOM_STEP_PERCENT;
  return Math.min(MAX_ZOOM_PERCENT, Math.max(MIN_ZOOM_PERCENT, stepped));
}

export function stepZoomPercent(current: unknown, direction: -1 | 1): number {
  return normalizeZoomPercent(
    normalizeZoomPercent(current) + direction * ZOOM_STEP_PERCENT,
  );
}
