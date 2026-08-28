import { useEffect, useState } from 'react';
import type { ProductExecutor } from '@gian/shared';

export interface AgentLogoSource {
  light: string;
  dark: string;
}

export function proxyLogoSource(proxy: ProductExecutor): AgentLogoSource {
  return {
    light: `/api/proxies/${proxy}/logo/light`,
    dark: `/api/proxies/${proxy}/logo/dark`,
  };
}

export function AgentLogo({
  proxy,
  logo = proxyLogoSource(proxy),
  size = 24,
  className = '',
}: {
  proxy: ProductExecutor;
  logo?: AgentLogoSource;
  size?: number;
  className?: string;
}) {
  const [lightFailed, setLightFailed] = useState(false);
  const [darkFailed, setDarkFailed] = useState(false);
  useEffect(() => {
    setLightFailed(false);
    setDarkFailed(false);
  }, [logo.light, logo.dark]);
  const fallback = proxy === 'dsh'
    ? 'D'
    : typeof proxy === 'string' && proxy.length > 0 ? proxy.slice(0, 1).toUpperCase() : '?';
  return (
    <span
      className={`agent-logo ${className}`.trim()}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {lightFailed
        ? <span className="agent-logo-fallback agent-logo-light">{fallback}</span>
        : <img className="agent-logo-image agent-logo-light" src={logo.light} alt="" onError={() => setLightFailed(true)} />}
      {darkFailed
        ? <span className="agent-logo-fallback agent-logo-dark">{fallback}</span>
        : <img className="agent-logo-image agent-logo-dark" src={logo.dark} alt="" onError={() => setDarkFailed(true)} />}
    </span>
  );
}
