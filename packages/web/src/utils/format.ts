export function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toTimeString().slice(0, 5);
}

export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return (n / 1000).toFixed(1) + 'k';
  return Math.round(n / 1000) + 'k';
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export function formatAge(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diffSec = Math.max(0, Math.round((now - t) / 1000));
  if (diffSec < 60) return diffSec + 's';
  const m = Math.round(diffSec / 60);
  if (m < 60) return m + 'm';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h';
  const d = Math.round(h / 24);
  return d + 'd';
}
