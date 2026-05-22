import type { JSX } from 'react';

interface Props {
  size?: number;
  state?: 'idle' | 'working';
  title?: string;
}

/** Gian mascot — a slab-serif G with attitude that doubles as the project
 *  logomark and the "session is doing something" animated indicator.
 *  Source design: docs/mockups/2026-05-21-gian-mascot.html, Concept 1
 *  (Boombox-G). Colors resolve through the theme via .gian-mascot CSS
 *  helpers, so it re-tones across light / warm / dark / accent. */
export function GianMascot({ size = 32, state = 'idle', title }: Props): JSX.Element {
  return state === 'working'
    ? <GianWorking size={size} title={title ?? 'Working…'} />
    : <GianStatic  size={size} title={title ?? 'Gian'} />;
}

function GianStatic({ size, title }: { size: number; title: string }) {
  return (
    <svg className="gian-mascot" width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={title}>
      <title>{title}</title>
      {/* Slab G body — bold serif G with notch */}
      <path className="ink" d="M 32 6 C 18 6, 7 16, 7 32 C 7 48, 18 58, 32 58 C 42 58, 50 53, 54 46 L 54 30 L 35 30 L 35 39 L 44 39 C 41 45, 37 48, 32 48 C 23 48, 17 41, 17 32 C 17 23, 23 16, 32 16 C 36 16, 39 17, 42 19 L 49 11 C 43 7, 38 6, 32 6 Z" />
      {/* Single attitude eye (cyclops — clearly not Doraemon) */}
      <ellipse className="paper" cx="25" cy="24" rx="3.6" ry="3.2" />
      <circle className="ink" cx="26" cy="24.5" r="1.7" />
      {/* Eyebrow furrow */}
      <path className="paper-s" strokeWidth="2.4" strokeLinecap="round" d="M 21 20 L 29 22" />
    </svg>
  );
}

function GianWorking({ size, title }: { size: number; title: string }) {
  return (
    <svg className="gian-mascot working" width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={title}>
      <title>{title}</title>
      <g className="g-body">
        <path className="ink" d="M 32 6 C 18 6, 7 16, 7 32 C 7 48, 18 58, 32 58 C 42 58, 50 53, 54 46 L 54 30 L 35 30 L 35 39 L 44 39 C 41 45, 37 48, 32 48 C 23 48, 17 41, 17 32 C 17 23, 23 16, 32 16 C 36 16, 39 17, 42 19 L 49 11 C 43 7, 38 6, 32 6 Z" />
        <ellipse className="paper" cx="25" cy="24" rx="3.6" ry="3.2" />
        <circle className="ink" cx="26" cy="24.5" r="1.7" />
        <path className="paper-s" strokeWidth="2.4" strokeLinecap="round" d="M 21 20 L 29 22" />
        <ellipse className="g-mouth acc" cx="42" cy="36" rx="3" ry="3.5" />
      </g>
      <circle className="g-ring acc-s" cx="49" cy="22" r="4" strokeWidth="2" />
      <circle className="g-ring r2 acc-s" cx="49" cy="22" r="4" strokeWidth="2" />
      <circle className="g-ring r3 acc-s" cx="49" cy="22" r="4" strokeWidth="2" />
      <g className="g-note">
        <ellipse className="acc" cx="52" cy="22" rx="2.4" ry="1.8" transform="rotate(-20 52 22)" />
        <rect className="acc" x="53.4" y="14" width="1.4" height="9" />
      </g>
      <g className="g-note n2">
        <ellipse className="acc" cx="52" cy="22" rx="2.4" ry="1.8" transform="rotate(-20 52 22)" />
        <rect className="acc" x="53.4" y="14" width="1.4" height="9" />
      </g>
    </svg>
  );
}
