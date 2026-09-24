/**
 * Proxy branding logo. Bytes arrive lazily over the `proxy.logo` remote
 * method (Host manifest branding); until they land — or on older Hosts that
 * never advertise the capability — a monogram tile keeps the layout stable.
 */

import { resolveTheme, useSystemDark } from '../theme.js';
import { useRemoteState } from './controller-context.js';

export function ProxyLogo({
  proxy,
  name,
  size = 16,
}: {
  /** Catalog `agent.proxy` key the logos map is indexed by. */
  proxy: string;
  /** Display name — drives the monogram fallback and the alt text. */
  name: string;
  size?: number;
}) {
  const state = useRemoteState();
  const systemDark = useSystemDark();
  const dark = resolveTheme(state.settings.theme, systemDark) === 'dark';
  const entry = state.logos[proxy];
  const url = (dark ? entry?.dark : entry?.light) ?? entry?.light ?? entry?.dark;
  const style = { width: size, height: size };
  if (url) {
    // Decorative: the adjacent name text already labels the control.
    return <img className="proxy-logo" src={url} alt="" style={style} />;
  }
  return (
    <span className="proxy-logo proxy-logo-mono" style={style} aria-hidden="true">
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}
