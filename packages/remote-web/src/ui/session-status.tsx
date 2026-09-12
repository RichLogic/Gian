import type { CSSProperties } from 'react';
import type { RemoteSession } from '@gian/remote-protocol';
import { useT } from '../i18n/index.js';

const DISC = "<circle cx='8' cy='8' r='7.4' fill='#fff'/>";

function glyph(kind: 'done' | 'err' | 'pend'): string {
  if (kind === 'done') {
    return "<path d='M5 8l2 2 4-4' fill='none' stroke='#fff' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'/>";
  }
  if (kind === 'err') {
    return "<rect x='7.05' y='3.8' width='1.9' height='5.3' rx='.95' fill='#fff'/><circle cx='8' cy='11.4' r='1.05' fill='#fff'/>";
  }
  return "<rect x='5.5' y='4.8' width='1.7' height='6.4' rx='.85' fill='#fff'/><rect x='8.8' y='4.8' width='1.7' height='6.4' rx='.85' fill='#fff'/>";
}

function maskUrl(inner: string): string {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'>${inner}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function maskStyle(kind: 'done' | 'err' | 'pend'): CSSProperties {
  const layers = `${maskUrl(DISC)}, ${maskUrl(glyph(kind))}`;
  return { maskImage: layers, WebkitMaskImage: layers };
}

export function remoteStatusGlyphShown(
  status: RemoteSession['status'],
  unread: boolean,
  stale: boolean,
): boolean {
  if (stale || status === 'new') return false;
  if (status === 'running' || status === 'pending' || status === 'error') return true;
  return status === 'done' && unread;
}

export function RemoteStatusIcon({
  status,
  unread,
}: {
  status: RemoteSession['status'];
  unread: boolean;
}) {
  const t = useT();
  if (status === 'running') {
    return (
      <span className="ri-status running" title={t('session.status.running')} aria-hidden="true">
        <span className="gico ring"><span className="gring" /></span>
      </span>
    );
  }

  const kind = status === 'pending' ? 'pend' : status === 'error' ? 'err' : 'done';
  const attention = status === 'pending' || unread;
  const label = status === 'pending'
    ? t('session.status.pending')
    : status === 'error'
      ? t('session.status.error')
      : t('session.status.done');
  return (
    <span className={`ri-status ${kind}`} title={label} aria-hidden="true">
      <span className={`gico ${attention ? 'unread' : 'read'} ${kind}`}>
        <span className="gfill" style={maskStyle(kind)} />
      </span>
    </span>
  );
}
