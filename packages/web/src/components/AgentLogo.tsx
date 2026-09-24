import { useEffect, useState } from 'react';
import type { ProductExecutor } from '@gian/shared';

export interface AgentLogoSource {
  light: string;
  dark: string;
}

export function proxyLogoSource(proxy: ProductExecutor, environmentId?: string): AgentLogoSource {
  if (environmentId) return {
    light: `/api/remote/environments/${encodeURIComponent(environmentId)}/logos/${encodeURIComponent(proxy)}/light`,
    dark: `/api/remote/environments/${encodeURIComponent(environmentId)}/logos/${encodeURIComponent(proxy)}/dark`,
  };
  return {
    light: `/api/proxies/${proxy}/logo/light`,
    dark: `/api/proxies/${proxy}/logo/dark`,
  };
}

export function AgentLogo({
  proxy,
  environmentId,
  logo = proxy ? proxyLogoSource(proxy, environmentId) : { light: '', dark: '' },
  fallback,
  size = 24,
  className = '',
}: {
  proxy: ProductExecutor | null;
  environmentId?: string;
  logo?: AgentLogoSource;
  /** Fallback glyph source for open pluginIds without a legacy kind
   *  (WP4): the display name's first letter. */
  fallback?: string;
  size?: number;
  className?: string;
}) {
  const [lightFailed, setLightFailed] = useState(false);
  const [darkFailed, setDarkFailed] = useState(false);
  useEffect(() => {
    setLightFailed(false);
    setDarkFailed(false);
  }, [logo.light, logo.dark]);
  const letter = fallback?.trim()
    ? fallback.trim().slice(0, 1).toUpperCase()
    : proxy === 'dsh'
      ? 'D'
      : typeof proxy === 'string' && proxy.length > 0 ? proxy.slice(0, 1).toUpperCase() : '?';
  // No logo URLs (open pluginId without a Catalog/legacy entry): render the
  // fallback letter directly instead of an <img> with an empty src.
  if (!logo.light && !logo.dark) {
    return (
      <span
        className={`agent-logo ${className}`.trim()}
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        <span className="agent-logo-fallback agent-logo-light">{letter}</span>
        <span className="agent-logo-fallback agent-logo-dark">{letter}</span>
      </span>
    );
  }
  return (
    <span
      className={`agent-logo ${className}`.trim()}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {lightFailed
        ? <span className="agent-logo-fallback agent-logo-light">{letter}</span>
        : <img className="agent-logo-image agent-logo-light" src={logo.light} alt="" onError={() => setLightFailed(true)} />}
      {darkFailed
        ? <span className="agent-logo-fallback agent-logo-dark">{letter}</span>
        : <img className="agent-logo-image agent-logo-dark" src={logo.dark} alt="" onError={() => setDarkFailed(true)} />}
    </span>
  );
}
