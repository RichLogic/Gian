import type { GianBrowserPermissionKind } from '@gian/shared';

export const BROWSER_PERMISSION_KINDS: readonly GianBrowserPermissionKind[] = [
  'camera',
  'microphone',
  'geolocation',
  'notifications',
  'clipboard',
];

export function browserPermissionKinds(
  permission: string,
  details: unknown,
): GianBrowserPermissionKind[] | null {
  if (permission === 'geolocation') return ['geolocation'];
  if (permission === 'notifications') return ['notifications'];
  if (permission === 'clipboard-read' || permission === 'clipboard-sanitized-write') return ['clipboard'];
  if (permission !== 'media') return null;
  const media = details && typeof details === 'object'
    ? details as { mediaTypes?: Array<'video' | 'audio'>; mediaType?: 'video' | 'audio' | 'unknown' }
    : {};
  const mediaTypes = media.mediaTypes ?? (media.mediaType && media.mediaType !== 'unknown'
    ? [media.mediaType]
    : []);
  const kinds: GianBrowserPermissionKind[] = [];
  if (mediaTypes.includes('video')) kinds.push('camera');
  if (mediaTypes.includes('audio')) kinds.push('microphone');
  return kinds.length > 0 ? kinds : null;
}

export function browserPermissionOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 16_384) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}
