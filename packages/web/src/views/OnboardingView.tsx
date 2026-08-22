import { useEffect, useMemo, useState } from 'react';
import type { AgentInstallStatus, OnboardingProjectRootResult, OnboardingState } from '@gian/shared';
import { loadAgents } from '../api.js';
import type { PickFolderResult } from '../api.js';
import { agentEntityKey } from '../operations/agents.js';
import {
  useOperationDispatch,
  useOperationRun,
  useOperationStore,
  usePendingOperations,
  waitForRunSettle,
} from '../operations/use-operations.js';
import type { AppIdentity } from '../controllers/use-app-auth.js';
import { useT } from '../i18n/index.js';
import { releaseAgents } from '../release-executors.js';

const AGENT_ORDER = ['codex', 'claude', 'kimi', 'dsh'];

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
 * dispatches a registered pending operation — `agent.installCli` /
 * `agent.installProxy` / `agent.setCliPath` (install + path, restart-free:
 * onboarding runs before the desktop app needs a restart), the shared
 * `workspace.pickFolder` (native directory dialog), and the
 * `onboarding.saveProjectRoot` → `onboarding.complete` finish chain.
 * Busy states derive from the runs; `waitForRunSettle` sequences the
 * multi-step flows promise-style.
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
  const [agents, setAgents] = useState<AgentInstallStatus[]>(initialState?.agents ?? []);
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

  const orderedAgents = useMemo(() => releaseAgents(agents)
    .sort((a, b) => AGENT_ORDER.indexOf(a.id) - AGENT_ORDER.indexOf(b.id)), [agents]);
  const anyReady = orderedAgents.some(agent => agent.ready);

  async function refreshAgents() {
    const next = await loadAgents();
    setAgents(next);
    return next;
  }

  async function setupOne(agent: AgentInstallStatus) {
    setError('');
    if (agent.proxy.state !== 'ready') {
      const settled = await waitForRunSettle(
        store,
        dispatch('agent.installProxy', { executor: agent.id }).id,
      );
      if (settled.phase !== 'confirmed') {
        setError(settled.error ?? 'Install failed');
        await refreshAgents().catch(() => undefined);
        return;
      }
    }
    if (agent.cli.state !== 'ready') {
      const settled = await waitForRunSettle(
        store,
        dispatch('agent.installCli', { executor: agent.id }).id,
      );
      if (settled.phase !== 'confirmed') {
        setError(settled.error ?? 'Install failed');
        await refreshAgents().catch(() => undefined);
        return;
      }
    }
    await refreshAgents();
  }

  async function savePath(agent: AgentInstallStatus, path: string) {
    setError('');
    const settled = await waitForRunSettle(
      store,
      dispatch('agent.setCliPath', {
        executor: agent.id,
        path: path.trim() || null,
        restart: false,
        previousPath: agent.cli.path ?? null,
      }).id,
    );
    if (settled.phase !== 'confirmed') {
      setError(settled.error ?? 'Save failed');
      return;
    }
    await refreshAgents();
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
              {orderedAgents.map(agent => (
                <OnboardingAgentRow
                  key={agent.id}
                  agent={agent}
                  onSetup={() => void setupOne(agent)}
                  onSavePath={path => void savePath(agent, path)}
                />
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
  agent: AgentInstallStatus;
  onSetup: () => void;
  onSavePath: (path: string) => void;
}) {
  const t = useT();
  // Busy = any in-flight agent operation for THIS executor (Phase 3b).
  const busy = usePendingOperations(agentEntityKey(agent.id)).length > 0;
  const [path, setPath] = useState(agent.cli.path ?? '');
  const cliReady = agent.cli.state === 'ready';
  const proxyReady = agent.proxy.state === 'ready';
  const proxyInstalled = proxyReady || agent.proxy.state === 'outdated';
  useEffect(() => setPath(agent.cli.path ?? ''), [agent.cli.path]);
  return (
    <article className={`onboarding-agent ${agent.ready ? 'ready' : ''}`}>
      <div className="onboarding-agent-summary">
        <span className={`exec-dot ${agent.id}`} />
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
            ? `${agent.proxy.version ?? ''} · ${agent.proxy.source === 'development' ? 'Dev' : 'GitHub'}${agent.proxy.state === 'outdated' ? ` · ${t('settings.agents.updateRequired')}` : ''}`
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
          disabled={busy || path.trim() === (agent.cli.path ?? '')}
          onClick={() => onSavePath(path)}
        >
          {t('settings.agents.savePath')}
        </button>
      </div>
    </article>
  );
}
