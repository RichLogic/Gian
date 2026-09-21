/**
 * Boot entry. Remote Web ships as a static artifact (proposal §13.3).
 * `?fixture=<scenario>` drives screenshot/visual verification. Without it the
 * production controller owns enrollment, relay, E2EE, and cache.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@gian/chat-ui/styles.css';
import './styles/tokens.css';
import './styles/remote-web.css';
import { App } from './app.js';
import { createFixtureController } from './controller/fixture.js';
import type { FixtureScenario } from './controller/fixture.js';
import { createProductionController, resolveRemoteWebBoot } from './controller/create.js';
import { ControllerProvider } from './ui/controller-context.js';
import { LocaleProvider, resolveRemoteWebLocale } from './i18n/index.js';
import { ViewportProvider } from './ui/viewport.js';
import { FIXTURE_SCENARIOS } from './scenarios.js';
import { preparePairingLink } from './pairing-link.js';

declare global {
  interface Window {
    __GIAN_REMOTE__?: { publicOrigin: string; buildId: string };
  }
}

function BootGate({ reason }: { reason: string }) {
  return (
    <div className="rw-pair">
      <div className="rw-pair-card">
        <span className="rw-pair-brand">
          <span className="rw-host-dot" aria-hidden="true" />
          Gian Remote
        </span>
        <span className="rw-fail-title">Transport not wired</span>
        <span className="rw-fail-desc">{reason}</span>
      </div>
    </div>
  );
}

const boot = resolveRemoteWebBoot(window.location.search);
const locale = resolveRemoteWebLocale(window.location.search);

let content: React.ReactNode;
if (boot !== 'production') {
  const scenario: FixtureScenario | undefined = FIXTURE_SCENARIOS[boot.fixture];
  if (!scenario) {
    content = <BootGate reason={`Unknown fixture scenario "${boot.fixture}".`} />;
  } else {
    const controller = createFixtureController(scenario);
    content = (
      <ControllerProvider controller={controller}>
        <App />
      </ControllerProvider>
    );
  }
} else {
  const injected = window.__GIAN_REMOTE__;
  const pairingLink = preparePairingLink(window.location.href, url => {
    window.history.replaceState(null, '', url);
  });
  const controller = createProductionController({
    baseUrl: window.location.origin,
    publicOrigin: injected?.publicOrigin ?? window.location.origin,
    pairingNonce: pairingLink.nonce,
    onPairingLinkDismissed: pairingLink.dismiss,
  });
  content = (
    <ControllerProvider controller={controller}>
      <App />
    </ControllerProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LocaleProvider locale={locale}>
      <ViewportProvider>{content}</ViewportProvider>
    </LocaleProvider>
  </StrictMode>,
);
