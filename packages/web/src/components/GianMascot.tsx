import type { JSX } from 'react';
import {
  GIAN_DRAGON_BODY_PATH,
  GIAN_DRAGON_WHISKER_BOTTOM_PATH,
  GIAN_DRAGON_WHISKER_TOP_PATH,
  GIAN_ICON_VIEWBOX,
} from '../brand-icon.js';

interface Props {
  size?: number;
  state?: 'idle' | 'working';
  title?: string;
}

/** The Gian Dragon-G logomark doubles as the working-state indicator. */
export function GianMascot({ size = 32, state = 'idle', title }: Props): JSX.Element {
  return state === 'working'
    ? <GianWorking size={size} title={title ?? 'Working…'} />
    : <GianStatic  size={size} title={title ?? 'Gian'} />;
}

function GianStatic({ size, title }: { size: number; title: string }) {
  return (
    <svg className="gian-mascot" width={size} height={size} viewBox={`0 0 ${GIAN_ICON_VIEWBOX} ${GIAN_ICON_VIEWBOX}`} role="img" aria-label={title}>
      <title>{title}</title>
      <path className="ink" d={GIAN_DRAGON_BODY_PATH} fillRule="evenodd" />
      <path className="ink" d={GIAN_DRAGON_WHISKER_TOP_PATH} />
      <path className="ink" d={GIAN_DRAGON_WHISKER_BOTTOM_PATH} />
    </svg>
  );
}

function GianWorking({ size, title }: { size: number; title: string }) {
  return (
    <svg className="gian-mascot working" width={size} height={size} viewBox={`0 0 ${GIAN_ICON_VIEWBOX} ${GIAN_ICON_VIEWBOX}`} role="img" aria-label={title}>
      <title>{title}</title>
      <g className="g-body">
        <path className="ink" d={GIAN_DRAGON_BODY_PATH} fillRule="evenodd" />
      </g>
      <path className="ink g-whisker" d={GIAN_DRAGON_WHISKER_TOP_PATH} />
      <path className="ink g-whisker second" d={GIAN_DRAGON_WHISKER_BOTTOM_PATH} />
    </svg>
  );
}
