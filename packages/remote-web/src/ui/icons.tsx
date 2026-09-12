/**
 * The small icon set Remote Web needs — paths are the ones Gian already ships
 * (same glyphs as packages/web controls and the v2 mockup); no new icon
 * dependency and no newly designed artwork.
 */

interface IconProps {
  name:
    | 'menu'
    | 'back'
    | 'forward'
    | 'plus'
    | 'settings'
    | 'close'
    | 'download'
    | 'caret-down'
    | 'caret-right'
    | 'warning'
    | 'wifi-off'
    | 'refresh'
    | 'send'
    | 'stop'
    | 'edit'
    | 'clock'
    | 'file'
    | 'sidebar'
    | 'check';
  size?: number;
}

const PATHS: Record<IconProps['name'], React.ReactNode> = {
  menu: <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />,
  back: <path d="M10 3 5 8l5 5" />,
  forward: <path d="M6 3l5 5-5 5" />,
  plus: <path d="M8 3v10M3 8h10" />,
  settings: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M13 8a5 5 0 0 0-.1-1l1.5-1.1-1.4-2.4-1.7.7a5 5 0 0 0-1.7-1L9.2 1.5H6.8l-.4 1.7a5 5 0 0 0-1.7 1l-1.7-.7-1.4 2.4L3.1 7a5 5 0 0 0 0 2l-1.5 1.1 1.4 2.4 1.7-.7a5 5 0 0 0 1.7 1l.4 1.7h2.4l.4-1.7a5 5 0 0 0 1.7-1l1.7.7 1.4-2.4-1.5-1.1c.06-.32.1-.66.1-1z" transform="scale(0.9) translate(0.9 0.9)" />
    </>
  ),
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  download: <path d="M8 2.5v8M4.5 7l3.5 3.5L11.5 7M3 13.5h10" />,
  'caret-down': <path d="M2.5 4 5 6.5 7.5 4" />,
  'caret-right': <path d="M3.5 2l3 3-3 3" />,
  warning: (
    <>
      <path d="M8 2 14.5 13.5h-13z" />
      <path d="M8 6.5v3.2M8 11.8v.01" />
    </>
  ),
  'wifi-off': (
    <>
      <path d="M2 6a9 9 0 0 1 12 0M5 9.5a5.5 5.5 0 0 1 6 0M8 13h.01" />
      <path d="M2.5 2.5l11 11" />
    </>
  ),
  refresh: <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" />,
  send: <path d="M14 2 7.3 8.7M14 2l-4.7 12-2-5.3L2 6.7z" />,
  stop: <rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" />,
  edit: <path d="M11.3 2.7l2 2L6 12H4v-2l7.3-7.3z" />,
  clock: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" />
    </>
  ),
  file: (
    <>
      <path d="M4 1.75h5l3 3V14.25H4z" />
      <path d="M9 1.75v3h3" />
    </>
  ),
  sidebar: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M6.5 3v10" />
    </>
  ),
  check: <path d="M3 8.2 6.4 11.5 13 4.8" />,
};

export function Icon({ name, size = 16 }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
