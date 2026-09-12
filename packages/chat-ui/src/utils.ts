/** Small pure helpers shared by the chat-ui components. */

export function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toTimeString().slice(0, 5);
}

/** `8s` under a minute, `1m 03s` past it. Used for Turn durations and the
 *  running-row timer. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

const NATIVE_IMAGE_MIME = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export function isNativeImageMime(mime: string): boolean {
  return NATIVE_IMAGE_MIME.has(mime);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
