import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  OnboardingProjectRootResult,
  OnboardingState,
  ProductExecutor,
  ProxyCatalogEntry,
  UserAgentStatus,
} from '@gian/shared';
import { loadAgents, loadProxies } from '../api.js';
import type { PickFolderResult } from '../api.js';
import { agentEntityKey, agentIdEntityKey } from '../operations/agents.js';
import {
  useOperationDispatch,
  useOperationRun,
  useOperationStore,
  usePendingOperations,
  waitForRunSettle,
} from '../operations/use-operations.js';
import type { AppIdentity } from '../controllers/use-app-auth.js';
import { useT } from '../i18n/index.js';

export function OnboardingSteps({ active }: { active: 1 | 2 | 3 }) {
  const t = useT();
  const steps = [
    t('onboarding.step.github'),
    t('onboarding.step.agents'),
    t('onboarding.step.directory'),
  ];
  return (
    <ol className="onboarding-steps" aria-label={t('onboarding.steps.label')}>
      {steps.map((label, index) => {
        const step = (index + 1) as 1 | 2 | 3;
        const state = step < active ? 'done' : step === active ? 'active' : 'upcoming';
        return (
          <li key={label} className={state} aria-current={state === 'active' ? 'step' : undefined}>
            <span className="onboarding-step-dot">{state === 'done' ? '✓' : step}</span>
            <span>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * First-run onboarding. Phase 3b (UI Operation Layer): every mutation
 * dispatches a registered pending operation. Step 2 is "add and set up at
 * least one Agent": Agents are created (agent.create) and their paths saved
 * (agent.patch) with `restart: false` — onboarding must never restart
 * mid-wizard and lose itself. When the wizard did touch agents.json, the
 * restart happens once, after `onboarding.complete`.
 */
export function OnboardingView({
  identity,
  initialState,
  initialError = '',
  onComplete,
}: {
  identity: AppIdentity | null;
  initialState: OnboardingState | null;
  initialError?: string;
  onComplete: (state: OnboardingState) => void;
}) {
  const t = useT();
  const dispatch = useOperationDispatch();
  const store = useOperationStore();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [agents, setAgents] = useState<UserAgentStatus[]>(initialState?.agents ?? []);
  const [proxies, setProxies] = useState<ProxyCatalogEntry[]>([]);
  const [root, setRoot] = useState(initialState?.projectRoot ?? '~/Coding');
  const [error, setError] = useState(initialError);
  // Tracked runs driving the directory-step busy states (derived, not
  // duplicated local flags).
  const [pickRunId, setPickRunId] = useState<string>();
  const [finishRunId, setFinishRunId] = useState<string>();
  const pickRun = useOperationRun(pickRunId);
  const finishRun = useOperationRun(finishRunId);
  const pickingDirectory = pickRun?.phase === 'pending';
  const savingDirectory = finishRun?.phase === 'pending';
  const anyAgentBusy = usePendingOperations().some(run => run.name.startsWith('agent.'));
  /** Set when step 2 wrote agents.json; finish() restarts once, after
   *  onboarding.complete (never mid-wizard). */
  const agentsTouched = useRef(false);

  const anyReady = agents.some(agent => agent.ready);
  const missingKinds = useMemo(
    () => proxies.filter(entry => !agents.some(agent => agent.proxy === entry.id)),
    [proxies, agents],
  );

  async function refreshAgents() {
    const next = await loadAgents({ refresh: true });
    setAgents(next);
    return next;
  }

  useEffect(() => {
    void refreshAgents().catch(() => undefined);
    loadProxies().then(setProxies).catch(() => setProxies([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function addAgent(kind: ProductExecutor) {
    setError('');
    let name = proxies.find(entry => entry.id === kind)?.name ?? kind;
    let cliPath: string | null = null;
    try {
      const { loadAgentDraftDefaults } = await import('../api.js');
      const defaults = await loadAgentDraftDefaults(kind);
      name = defaults.name;
      cliPath = defaults.cliPath;
    } catch {
      // Fall back to the catalog display name; the Host still validates.
    }
    const settled = await waitForRunSettle(
      store,
      dispatch('agent.create', { name, proxy: kind, cliPath, restart: false }).id,
    );
    if (settled.phase !== 'confirmed') {
      setError(settled.error ?? 'Add failed');
      return;
    }
    agentsTouched.current = true;
    await refreshAgents().catch(() => undefined);
  }

  async function setupOne(agent: UserAgentStatus) {
    setError('');
    // A Proxy activation smoke starts the exact vendor runtime, so a clean
    // machine must provision the CLI first. Installing Proxy first made the
    // fresh pair fail despite both installers being available.
    if (agent.cli.state !== 'ready') {
      const settled = await waitForRunSettle(
        store,
        dispatch('agent.installCli', { executor: agent.proxy }).id,
      );
      if (settled.phase !== 'confirmed') {
        setError(settled.error ?? 'Install failed');
        await refreshAgents().catch(() => undefined);
        return;
      }
    }
    const refreshed = (await refreshAgents().catch(() => []))
      .find(candidate => candidate.id === agent.id) ?? agent;
    if (refreshed.plugin.state !== 'ready') {
      const settled = await waitForRunSettle(
        store,
        dispatch('agent.installProxy', { executor: agent.proxy }).id,
      );
      if (settled.phase !== 'confirmed') {
        setError(settled.error ?? 'Install failed');
        await refreshAgents().catch(() => undefined);
        return;
      }
    }
    await refreshAgents();
  }

  async function savePath(agent: UserAgentStatus, path: string) {
    setError('');
    const settled = await waitForRunSettle(
      store,
      dispatch('agent.patch', {
        agentId: agent.id,
        patch: { cliPath: path.trim() || null },
      }).id,
    );
    if (settled.phase !== 'confirmed') {
      setError(settled.error ?? 'Save failed');
      return;
    }
    agentsTouched.current = true;
    await refreshAgents().catch(() => undefined);
  }

  async function pickDirectory() {
    setError('');
    const run = dispatch('workspace.pickFolder', {});
    setPickRunId(run.id);
    const settled = await waitForRunSettle(store, run.id);
    if (settled.phase !== 'confirmed') {
      setError(settled.error ?? 'Picker failed');
      return;
    }
    const result = settled.result as PickFolderResult | undefined;
    if (result?.path) setRoot(result.path);
  }

  async function finish() {
    setError('');
    const save = dispatch('onboarding.saveProjectRoot', { path: root });
    setFinishRunId(save.id);
    const savedRun = await waitForRunSettle(store, save.id);
    if (savedRun.phase !== 'confirmed') {
      setError(savedRun.error ?? 'Save failed');
      return;
    }
    const saved = savedRun.result as OnboardingProjectRootResult;
    setRoot(saved.projectRoot);
    const complete = dispatch('onboarding.complete', {});
    setFinishRunId(complete.id);
    const completedRun = await waitForRunSettle(store, complete.id);
    if (completedRun.phase !== 'confirmed') {
      setError(completedRun.error ?? 'Complete failed');
      return;
    }
    onComplete(completedRun.result as OnboardingState);
    // Agents written during the wizard only load at next launch. Restart
    // once, AFTER onboarding.complete, so the wizard is never interrupted.
    if (agentsTouched.current) {
      dispatch('agent.restartApp', {});
    }
  }

  const githubUser = identity?.provider === 'github' ? identity.user : null;
  return (
    <div className="onboarding-shell" data-testid="onboarding-shell">
      <div className="onboarding-card">
        <header className="onboarding-header">
          <div className="login-brand-mark" aria-hidden>G</div>
          <div>
            <h1>{t('onboarding.title')}</h1>
            <p>{t('onboarding.intro')}</p>
          </div>
        </header>
        <OnboardingSteps active={step} />

        {step === 1 ? (
          <section className="onboarding-panel" aria-labelledby="onboarding-github-title">
            <div className="onboarding-github-connected">
              {githubUser && (
                <img src={githubUser.avatarUrl} alt="" referrerPolicy="no-referrer" />
              )}
              <span className="onboarding-eyebrow">{t('onboarding.github.complete')}</span>
              <h2 id="onboarding-github-title">{t('onboarding.github.title')}</h2>
              <p>{t('onboarding.github.help')}</p>
              {githubUser && (
                <strong>@{githubUser.login}</strong>
              )}
            </div>
            <footer className="onboarding-actions">
              <button
                className="btn primary"
                type="button"
                onClick={() => { setError(''); setStep(2); }}
              >
                {t('common.continue')}
              </button>
            </footer>
          </section>
        ) : step === 2 ? (
          <section className="onboarding-panel" aria-labelledby="onboarding-agents-title">
            <div className="onboarding-panel-heading">
              <div>
                <span className="onboarding-eyebrow">{t('onboarding.github.complete')}</span>
                <h2 id="onboarding-agents-title">{t('onboarding.agents.title')}</h2>
                <p>{t('onboarding.agents.help')}</p>
              </div>
              {githubUser && (
                <div className="onboarding-user">
                  <img src={githubUser.avatarUrl} alt="" referrerPolicy="no-referrer" />
                  <span>@{githubUser.login}</span>
                </div>
              )}
            </div>

            <div className="onboarding-agent-list">
              {agents.map(agent => (
                <OnboardingAgentRow
                  key={agent.id}
                  agent={agent}
                  onSetup={() => void setupOne(agent)}
                  onSavePath={path => void savePath(agent, path)}
                />
              ))}
              {missingKinds.map(entry => (
                <article key={entry.id} className="onboarding-agent" data-testid={`onboarding-add-${entry.id}`}>
                  <div className="onboarding-agent-summary">
                    <div>
                      <h3>{entry.name}</h3>
                      <p>{entry.tagline}</p>
                    </div>
                    <button
                      className="btn xs secondary"
                      type="button"
                      disabled={anyAgentBusy}
                      onClick={() => void addAgent(entry.id)}
                    >
                      {t('settings.agents.add')}
                    </button>
                  </div>
                </article>
              ))}
            </div>
            {error && <p className="onboarding-error" role="alert">{error}</p>}
            <footer className="onboarding-actions">
              <button
                className="btn ghost"
                type="button"
                disabled={anyAgentBusy}
                onClick={() => { setError(''); setStep(1); }}
              >
                {t('common.back')}
              </button>
              <button
                className="btn primary"
                type="button"
                disabled={!anyReady || anyAgentBusy}
                onClick={() => { setError(''); setStep(3); }}
              >
                {t('common.continue')}
              </button>
            </footer>
          </section>
        ) : (
          <section className="onboarding-panel" aria-labelledby="onboarding-directory-title">
            <div className="onboarding-panel-heading">
              <div>
                <h2 id="onboarding-directory-title">{t('onboarding.directory.title')}</h2>
                <p>{t('onboarding.directory.help')}</p>
              </div>
            </div>
            <label className="onboarding-directory-label" htmlFor="onboarding-root">
              {t('onboarding.directory.projectRoot')}
            </label>
            <div className="onboarding-directory-input">
              <input
                id="onboarding-root"
                className="input mono"
                value={root}
                disabled={savingDirectory || pickingDirectory}
                onChange={event => setRoot(event.target.value)}
                spellCheck={false}
              />
              <button
                className="btn secondary"
                type="button"
                disabled={savingDirectory || pickingDirectory}
                onClick={() => void pickDirectory()}
              >
                {pickingDirectory ? t('onboarding.directory.picking') : t('onboarding.directory.browse')}
              </button>
            </div>
            <div className="onboarding-path-preview">
              <div>
                <span>{t('onboarding.directory.worktrees')}</span>
                <code>{root.trim() ? `${root.trim().replace(/\/$/, '')}/worktrees` : '—'}</code>
              </div>
            </div>
            <p className="onboarding-directory-note">{t('onboarding.directory.note')}</p>
            {error && <p className="onboarding-error" role="alert">{error}</p>}
            <footer className="onboarding-actions">
              <button className="btn ghost" type="button" disabled={savingDirectory} onClick={() => setStep(2)}>
                {t('common.back')}
              </button>
              <button
                className="btn primary"
                type="button"
                disabled={savingDirectory || !root.trim()}
                onClick={() => void finish()}
              >
                {savingDirectory ? t('onboarding.directory.finishing') : t('onboarding.directory.finish')}
              </button>
            </footer>
          </section>
        )}
      </div>
    </div>
  );
}

function OnboardingAgentRow({
  agent,
  onSetup,
  onSavePath,
}: {
  agent: UserAgentStatus;
  onSetup: () => void;
  onSavePath: (path: string) => void;
}) {
  const t = useT();
  // Busy = any in-flight operation for THIS Agent or its kind (Phase 3b).
  const agentRuns = usePendingOperations(agentIdEntityKey(agent.id));
  const kindRuns = usePendingOperations(agentEntityKey(agent.proxy));
  const busy = agentRuns.length > 0 || kindRuns.length > 0;
  const [path, setPath] = useState(agent.cliPath ?? agent.cli.path ?? '');
  const cliReady = agent.cli.state === 'ready';
  const proxyReady = agent.plugin.state === 'ready';
  const proxyInstalled = proxyReady || agent.plugin.state === 'outdated';
  useEffect(() => setPath(agent.cliPath ?? agent.cli.path ?? ''), [agent.cliPath, agent.cli.path]);
  return (
    <article className={`onboarding-agent ${agent.ready ? 'ready' : ''}`}>
      <div className="onboarding-agent-summary">
        <div>
          <h3>{agent.name}</h3>
          <p>{agent.ready ? t('onboarding.agents.ready') : t('onboarding.agents.setupRequired')}</p>
        </div>
        {!agent.ready && (
          <button className="btn xs primary" type="button" disabled={busy} onClick={onSetup}>
            {busy ? t('settings.agents.installing') : t('settings.agents.setup')}
          </button>
        )}
      </div>
      <div className="onboarding-agent-components">
        <span className={cliReady ? 'ready' : 'missing'}>
          <b>CLI</b>
          {cliReady
            ? `${agent.cli.version ?? ''} · ${agent.cli.path ?? ''}`
            : t(agent.cli.state === 'invalid' ? 'settings.agents.invalid' : 'settings.agents.notInstalled')}
        </span>
        <span className={proxyReady ? 'ready' : 'missing'}>
          <b>Proxy</b>
          {proxyInstalled
            ? `${agent.plugin.version ?? ''} · ${agent.plugin.source === 'development' ? 'Dev' : 'GitHub'}${agent.plugin.state === 'outdated' ? ` · ${t('settings.agents.updateRequired')}` : ''}`
            : t('settings.agents.notInstalled')}
        </span>
      </div>
      <div className="onboarding-cli-path">
        <input
          className="input mono"
          aria-label={`${agent.name} ${t('settings.agents.cliPath')}`}
          value={path}
          disabled={busy}
          placeholder="/absolute/path/to/cli"
          onChange={event => setPath(event.target.value)}
        />
        <button
          className="btn xs secondary"
          type="button"
          disabled={busy || path.trim() === (agent.cliPath ?? agent.cli.path ?? '')}
          onClick={() => onSavePath(path)}
        >
          {t('settings.agents.savePath')}
        </button>
      </div>
    </article>
  );
}
