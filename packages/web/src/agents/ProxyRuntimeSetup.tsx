import { useContext, useEffect, useRef, useState } from 'react';
import type {
  ProxyCatalogItem,
  RuntimeDiscoverResponse,
  RuntimeProbeResponse,
} from '@gian/shared';
import { useT } from '../i18n/index.js';
import { BrowserLinkOpenContext } from '../presentation/chat-panel.js';
import { runtimeEntityKey } from '../operations/catalog.js';
import {
  useOperationDispatch,
  useOperationStore,
  usePendingOperations,
  waitForRunSettle,
} from '../operations/use-operations.js';

type DiscoveryState =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; data: RuntimeDiscoverResponse };

type ProbeState =
  | { state: 'idle' }
  | { state: 'error'; message: string }
  | { state: 'done'; result: RuntimeProbeResponse };

/**
 * Runtime section of the Proxy detail Setup tab (WP6 Runtime control plane,
 * issue #150). Everything rendered here comes from the Host:
 * `runtime.discover` returns the Manifest runtime, candidate paths and the
 * authoritative setup/available actions; `runtime.probe` validates one
 * user-supplied absolute path Host-side. Web never infers actions from the
 * pluginId, error text, or local filesystem guesses.
 *
 * Gating follows the Host projection only: items whose runtime is
 * `not_required` render the self-contained note and never discover; items
 * without a Host-projected `open_setup`/`select_runtime` action
 * (incompatible, not installed, invalid, quarantined) stay documentation-
 * only and never trigger discover/probe.
 */
export function ProxyRuntimeSetup({
  item,
  onRuntimeSelected,
  onProjectionChanged,
}: {
  item: ProxyCatalogItem;
  /** A probe succeeded: the page remembers this pluginId's selected path
   *  (with the plugin version it belongs to) so a new Agent draft can
   *  prefill its Runtime path. */
  onRuntimeSelected: (pluginId: string, pluginVersion: string, selectedPath: string) => void;
  /** Ask the page to reload the full /api/proxies + /api/agents projections
   *  so the Host-re-projected actions replace anything learned locally. */
  onProjectionChanged: () => Promise<void>;
}) {
  const t = useT();
  const dispatch = useOperationDispatch();
  const store = useOperationStore();
  const openBrowser = useContext(BrowserLinkOpenContext);
  const runs = usePendingOperations(runtimeEntityKey(item.pluginId));
  const busy = runs.length > 0;

  const [discovery, setDiscovery] = useState<DiscoveryState>({ state: 'idle' });
  const [pathInput, setPathInput] = useState('');
  const [probe, setProbe] = useState<ProbeState>({ state: 'idle' });
  const [retryTick, setRetryTick] = useState(0);
  const pathInputRef = useRef<HTMLInputElement>(null);

  const pluginId = item.pluginId;
  const installedVersion = item.installation.installedVersion;
  /** Synchronous generation anchors: the probe completion callback and the
   *  render path must never act on a result whose pluginVersion predates the
   *  currently installed one (state effects run after paint). */
  const installedVersionRef = useRef(installedVersion);
  installedVersionRef.current = installedVersion;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const notRequired = item.runtime.state === 'not_required';
  // The list projection only decides whether discovery may START. Once the
  // discover response lands, its availableActions are the fresher Host
  // authority and alone decide whether setup is offered.
  const projectedCanSetup = !notRequired
    && (item.availableActions.includes('select_runtime')
      || item.availableActions.includes('open_setup'));

  /** Current-generation discover data + setup authorization from it. */
  function discoverAuthority(): {
    data: RuntimeDiscoverResponse | null;
    allowed: boolean;
  } {
    const data = discovery.state === 'ready' ? discovery.data : null;
    const current = data !== null && data.pluginVersion === installedVersionRef.current;
    const allowed = current && data !== null
      && (data.availableActions.includes('select_runtime')
        || data.availableActions.includes('open_setup'));
    return { data: current ? data : null, allowed };
  }

  // One effect owns the whole lifecycle: a different plugin version owns a
  // different Runtime state, so any identity/version change drops everything
  // learned about the old one (a stale probe must never pose as the new
  // version's readiness) and re-discovers on demand. `discovery.state` is
  // deliberately NOT a dependency — setting `loading` must not retrigger the
  // effect and orphan its own in-flight run; retry is explicit via
  // `retryTick`.
  useEffect(() => {
    setPathInput('');
    setProbe({ state: 'idle' });
    if (!projectedCanSetup) {
      setDiscovery({ state: 'idle' });
      return;
    }
    let alive = true;
    setDiscovery({ state: 'loading' });
    const dispatched = dispatch('catalog.discoverRuntime', { pluginId });
    void waitForRunSettle(store, dispatched.id).then(settled => {
      if (!alive) return;
      if (settled.phase === 'confirmed') {
        setDiscovery({ state: 'ready', data: settled.result as RuntimeDiscoverResponse });
      } else {
        setDiscovery({ state: 'error', message: settled.error ?? 'Runtime discovery failed' });
      }
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectedCanSetup, pluginId, installedVersion, retryTick, dispatch, store]);

  async function probePath(path: string): Promise<void> {
    const trimmed = path.trim();
    if (!trimmed || busy) return;
    // Re-check against the CURRENT discover response, never the (possibly
    // stale) list projection: if the Host revoked the setup actions since
    // discovery — or the plugin version moved — do not probe.
    if (!discoverAuthority().allowed) return;
    setProbe({ state: 'idle' });
    const dispatched = dispatch('catalog.probeRuntime', { pluginId, path: trimmed });
    const settled = await waitForRunSettle(store, dispatched.id);
    if (!mountedRef.current) return;
    if (settled.phase !== 'confirmed') {
      setProbe({ state: 'error', message: settled.error ?? 'Runtime probe failed' });
      return;
    }
    const result = settled.result as RuntimeProbeResponse;
    // A probe answered for a previous plugin version is dropped wholesale.
    if (result.pluginVersion !== installedVersionRef.current) return;
    setProbe({ state: 'done', result });
    // Only a runnable Runtime may prefill a draft: verified or unverified
    // with no readinessIssue. incompatible/flagged paths stay visible as a
    // result but are never recorded as the page's selected path.
    if (!result.readinessIssue
      && (result.profile.verification === 'verified'
        || result.profile.verification === 'unverified')) {
      onRuntimeSelected(pluginId, result.pluginVersion, result.selectedPath);
    }
    // The probe changes the Host-projected readiness/actions; reload the
    // full projections instead of trusting the local response alone.
    await onProjectionChanged();
  }

  if (notRequired) {
    return (
      <p className="s2-help" style={{ margin: 0 }} data-testid="runtime-none">
        {t('agents.proxy.runtime.notRequired')}
      </p>
    );
  }

  // Probe results render only for the currently installed plugin version —
  // an old-generation result must not flash while the version change
  // propagates through the effect.
  const probeResult = probe.state === 'done'
    && probe.result.pluginVersion === installedVersion
    ? probe.result
    : null;

  if (!projectedCanSetup && !probeResult) {
    return (
      <p className="s2-help" style={{ margin: 0 }} data-testid="runtime-unavailable">
        {t('agents.runtime.setupUnavailable')}
      </p>
    );
  }

  const { data, allowed: setupAllowed } = discoverAuthority();
  // The Manifest may declare `{kind: 'none'}` even when the projection still
  // carries a setup action — the discover response is the runtime truth.
  const manifestRuntimeNone = data?.runtime.kind === 'none';
  const runtimeName = data?.runtime.displayName ?? item.runtime.displayName ?? pluginId;
  const hasSelectFile = data?.setupActions.some(action => action.kind === 'select_file') ?? false;

  return (
    <div className="ag-runtime" data-testid="runtime-setup">
      {discovery.state === 'loading' && (
        <p className="s2-help" style={{ margin: 0 }} data-testid="runtime-discover-loading">
          {t('agents.runtime.loading')}
        </p>
      )}
      {discovery.state === 'error' && (
        <div className="notice danger" role="alert" data-testid="runtime-discover-error">
          <span style={{ flex: 1, minWidth: 0 }}>
            {t('agents.runtime.error').replace('{message}', discovery.message)}
          </span>
          <button
            type="button"
            className="btn sm ghost"
            data-testid="runtime-discover-retry"
            onClick={() => setRetryTick(tick => tick + 1)}
          >
            {t('common.retry')}
          </button>
        </div>
      )}
      {data && (
        <>
          <p className="s2-help" style={{ margin: 0 }}>
            {manifestRuntimeNone
              ? t('agents.proxy.runtime.notRequired')
              : t('agents.proxy.runtime.setupRequired').replace('{name}', runtimeName)}
          </p>
          {!manifestRuntimeNone && !setupAllowed && (
            // The fresh discover response revoked the setup actions (install
            // or compatibility changed mid-session): no candidates, no path
            // form, no probe.
            <p className="s2-help" style={{ margin: 0 }} data-testid="runtime-revoked">
              {t('agents.runtime.setupUnavailable')}
            </p>
          )}
          {setupAllowed && data.setupActions.length > 0 && (
            <div className="ag-runtime-actions">
              {data.setupActions.map(action => {
                if (action.kind === 'open_url') {
                  // Host-verified https only; every other scheme renders
                  // nothing actionable (the Catalog contract guarantees
                  // https, this guard keeps the client fail-closed).
                  if (!/^https:\/\//i.test(action.url)) return null;
                  return openBrowser ? (
                    <button
                      key={action.id}
                      type="button"
                      className="btn sm secondary"
                      data-testid={`runtime-action-${action.id}`}
                      onClick={() => openBrowser(action.url)}
                    >
                      {action.label}
                    </button>
                  ) : (
                    <a
                      key={action.id}
                      className="btn sm secondary"
                      href={action.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid={`runtime-action-${action.id}`}
                    >
                      {action.label}
                    </a>
                  );
                }
                // select_file: no Desktop API returns an arbitrary absolute
                // executable path (the composer resource picker strips
                // paths), so the action focuses the manual input instead.
                return (
                  <button
                    key={action.id}
                    type="button"
                    className="btn sm secondary"
                    data-testid={`runtime-action-${action.id}`}
                    onClick={() => {
                      pathInputRef.current?.focus();
                      pathInputRef.current?.scrollIntoView?.({ block: 'nearest' });
                    }}
                  >
                    {action.label}
                  </button>
                );
              })}
            </div>
          )}
          {setupAllowed && !manifestRuntimeNone && (
            <>
              {data.candidates.length > 0 ? (
                <div
                  className="ag-runtime-candidates"
                  role="radiogroup"
                  aria-label={t('agents.runtime.candidates')}
                  data-testid="runtime-candidates"
                >
                  {data.candidates.map((candidate, index) => (
                    <label
                      key={`${candidate.source}:${candidate.path}`}
                      className="ag-runtime-candidate"
                    >
                      <input
                        type="radio"
                        name={`runtime-path-${pluginId}`}
                        checked={pathInput === candidate.path}
                        disabled={busy}
                        onChange={() => setPathInput(candidate.path)}
                        data-testid={`runtime-candidate-${index}`}
                      />
                      <span className="grow">
                        <span className="mono ellip" style={{ display: 'block' }} title={candidate.path}>
                          {candidate.path}
                        </span>
                        <span className="hint">
                          {candidate.source}
                          {candidate.label ? ` · ${candidate.label}` : ''}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="s2-help" style={{ margin: 0 }} data-testid="runtime-candidates-empty">
                  {t('agents.runtime.empty')}
                </p>
              )}
              <div className="cli-path-row">
                <input
                  ref={pathInputRef}
                  className="input mono"
                  value={pathInput}
                  placeholder="/absolute/path/to/runtime"
                  aria-label={t('agents.runtime.pathLabel')}
                  disabled={busy}
                  data-testid="runtime-path-input"
                  onChange={event => setPathInput(event.target.value)}
                />
                <button
                  type="button"
                  className="btn sm primary"
                  disabled={busy || !pathInput.trim()}
                  data-testid="runtime-probe"
                  onClick={() => { void probePath(pathInput); }}
                >
                  {busy ? t('agents.runtime.probing') : t('agents.runtime.probe')}
                </button>
              </div>
              {hasSelectFile && (
                <span className="hint">{t('agents.runtime.selectFileHint')}</span>
              )}
            </>
          )}
        </>
      )}
      {probe.state === 'error' && (
        <div className="notice danger" role="alert" data-testid="runtime-probe-error">
          {t('agents.runtime.probeError').replace('{message}', probe.message)}
        </div>
      )}
      {probeResult && (
        <div data-testid="runtime-probe-result">
          <dl className="kv-grid">
            <dt>{t('agents.runtime.result.status')}</dt>
            <dd>
              <span className={`st ${
                probeResult.profile.verification === 'verified'
                  ? 'ok'
                  : probeResult.profile.verification === 'unverified'
                    ? 'warn'
                    : 'err'
              }`}>
                <span className="st-dot" />
                {t(`agents.runtime.result.${probeResult.profile.verification === 'verified'
                  ? 'ready'
                  : probeResult.profile.verification === 'unverified'
                    ? 'unverified'
                    : 'invalid'}`)}
              </span>
            </dd>
            <dt>{t('settings.agents.version')}</dt>
            <dd><span className="mono">{probeResult.profile.version ?? '—'}</span></dd>
            <dt>{t('agents.runtime.selectedPath')}</dt>
            <dd>
              <span className="mono ellip" style={{ display: 'block' }} title={probeResult.selectedPath}>
                {probeResult.selectedPath}
              </span>
            </dd>
          </dl>
          {probeResult.readinessIssue && (
            <div className="notice warn" role="status" data-testid="runtime-readiness-issue">
              {probeResult.readinessIssue.message}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
