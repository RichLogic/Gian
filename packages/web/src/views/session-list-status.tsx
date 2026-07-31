import type { CSSProperties } from 'react';
import type { SessionStatus } from '@gian/shared';
import { useT } from '../i18n/index.js';

export function relTime(iso: string): string {
  const milliseconds = Date.now() - Date.parse(iso);
  if (Number.isNaN(milliseconds)) return '';
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(days / 365)}y`;
}

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

export function statusGlyphShown(status: SessionStatus, unread: boolean): boolean {
  if (status === 'running' || status === 'pending' || status === 'error') return true;
  return status === 'done' && unread;
}

export function StatusIcon({
  status,
  unread = false,
}: {
  status: SessionStatus;
  unread?: boolean;
}) {
  const t = useT();
  if (status === 'new') return null;
  if (status === 'running') {
    return (
      <span className="ri-status running" title={t('coding.status.running')} aria-label="running">
        <span className="gico ring"><span className="gring" /></span>
      </span>
    );
  }

  const kind = status === 'pending' ? 'pend' : status === 'error' ? 'err' : 'done';
  const attention = status === 'pending' || unread;
  if (kind === 'done' && !attention) return null;
  const className = kind === 'err' ? 'err' : kind === 'pend' ? 'pending' : 'done';
  const label = status === 'pending'
    ? t('coding.status.awaitingApproval')
    : status === 'error'
      ? t('coding.status.error')
      : t('coding.status.done');
  return (
    <span className={`ri-status ${className}`} title={label} aria-label={status}>
      <span className={`gico ${attention ? 'unread' : 'read'} ${kind}`}>
        <span className="gfill" style={maskStyle(kind)} />
      </span>
    </span>
  );
}
