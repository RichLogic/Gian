import type { JSX } from 'react';
import {
  GIAN_ICON_VIEWBOX,
  GIAN_VOICE_BODY_PATH,
  GIAN_VOICE_LINE_BOTTOM_PATH,
  GIAN_VOICE_LINE_TOP_PATH,
} from '../brand-icon.js';

interface Props {
  size?: number;
  state?: 'idle' | 'working';
  title?: string;
}

/** The Gian Voice-G logomark doubles as the working-state indicator. */
export function GianMascot({ size = 32, state = 'idle', title }: Props): JSX.Element {
  return state === 'working'
    ? <GianWorking size={size} title={title ?? 'Working…'} />
    : <GianStatic  size={size} title={title ?? 'Gian'} />;
}

function GianStatic({ size, title }: { size: number; title: string }) {
  return (
    <svg className="gian-mascot" width={size} height={size} viewBox={`0 0 ${GIAN_ICON_VIEWBOX} ${GIAN_ICON_VIEWBOX}`} role="img" aria-label={title}>
      <title>{title}</title>
      <path className="ink" d={GIAN_VOICE_BODY_PATH} fillRule="evenodd" />
      <path className="ink" d={GIAN_VOICE_LINE_TOP_PATH} />
      <path className="ink" d={GIAN_VOICE_LINE_BOTTOM_PATH} />
    </svg>
  );
}

function GianWorking({ size, title }: { size: number; title: string }) {
  return (
    <svg className="gian-mascot working" width={size} height={size} viewBox={`0 0 ${GIAN_ICON_VIEWBOX} ${GIAN_ICON_VIEWBOX}`} role="img" aria-label={title}>
      <title>{title}</title>
      <g className="g-body">
        <path className="ink" d={GIAN_VOICE_BODY_PATH} fillRule="evenodd" />
      </g>
      <path className="ink g-voice-line" d={GIAN_VOICE_LINE_TOP_PATH} />
      <path className="ink g-voice-line second" d={GIAN_VOICE_LINE_BOTTOM_PATH} />
    </svg>
  );
}
