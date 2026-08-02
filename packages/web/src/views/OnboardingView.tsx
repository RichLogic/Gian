import { useMemo, useState } from 'react';
import type { AgentInstallStatus, Executor, OnboardingState } from '@gian/shared';
import {
  completeOnboarding,
  installAgentCli,
  installAgentProxy,
  loadAgents,
  pickWorkspaceFolder,
  saveOnboardingWorkspace,
  setAgentCliPath,
} from '../api.js';
import type { AppIdentity } from '../controllers/use-app-auth.js';
import { useT } from '../i18n/index.js';

const AGENT_ORDER: Executor[] = ['codex', 'claude', 'kimi'];

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
  const [step, setStep] = useState<2 | 3>(2);
  const [agents, setAgents] = useState<AgentInstallStatus[]>(initialState?.agents ?? []);
  const [root, setRoot] = useState(initialState?.workspaceRoot ?? '~/Coding');
  const [workspaceDirectory, setWorkspaceDirectory] = useState(
    initialState?.workspaceDirectory ?? '~/Coding/workspaces',
  );
  const [busyAgent, setBusyAgent] = useState<Executor | 'all' | null>(null);
  const [savingDirectory, setSavingDirectory] = useState(false);
  const [pickingDirectory, setPickingDirectory] = useState(false);
  const [error, setError] = useState(initialError);

  const orderedAgents = useMemo(() => AGENT_ORDER
    .map(id => agents.find(agent => agent.id === id))
    .filter((agent): agent is AgentInstallStatus => !!agent), [agents]);
  const allReady = orderedAgents.length === AGENT_ORDER.length
    && orderedAgents.every(agent => agent.ready);

  async function refreshAgents() {
    const next = await loadAgents();
    setAgents(next);
    return next;
  }

  async function setupAgent(agent: AgentInstallStatus) {
    setError('');
    try {
      if (agent.proxy.state !== 'ready') await installAgentProxy(agent.id);
      if (agent.cli.state !== 'ready') await installAgentCli(agent.id);
      await refreshAgents();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      await refreshAgents().catch(() => undefined);
    }
  }

  async function setupOne(agent: AgentInstallStatus) {
    setBusyAgent(agent.id);
    try {
      await setupAgent(agent);
    } finally {
      setBusyAgent(null);
    }
  }

  async function setupAll() {
    setBusyAgent('all');
    setError('');
    try {
      let current = await refreshAgents();
      for (const id of AGENT_ORDER) {
        const agent = current.find(candidate => candidate.id === id);
        if (!agent) throw new Error(`Agent status is missing: ${id}`);
        if (!agent.ready) {
          await setupAgent(agent);
          current = await refreshAgents();
        }
      }
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusyAgent(null);
    }
  }

  async function savePath(agent: AgentInstallStatus, path: string) {
    setBusyAgent(agent.id);
    setError('');
    try {
      await setAgentCliPath(agent.id, path.trim() || null);
      await refreshAgents();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusyAgent(null);
    }
  }

  async function pickDirectory() {
    setPickingDirectory(true);
    setError('');
    try {
      const result = await pickWorkspaceFolder();
      if (result.error) setError(result.error);
      if (result.path) setRoot(result.path);
    } finally {
      setPickingDirectory(false);
    }
  }

  async function finish() {
    setSavingDirectory(true);
    setError('');
    try {
      const saved = await saveOnboardingWorkspace(root);
      setRoot(saved.workspaceRoot);
      setWorkspaceDirectory(saved.workspaceDirectory);
      onComplete(await completeOnboarding());
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setSavingDirectory(false);
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

        {step === 2 ? (
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
                  busy={busyAgent === agent.id || busyAgent === 'all'}
                  onSetup={() => void setupOne(agent)}
                  onSavePath={path => void savePath(agent, path)}
                />
              ))}
            </div>
            {error && <p className="onboarding-error" role="alert">{error}</p>}
            <footer className="onboarding-actions">
              <button
                className="btn secondary"
                type="button"
                disabled={busyAgent !== null || allReady}
                onClick={() => void setupAll()}
              >
                {busyAgent === 'all' ? t('onboarding.agents.installingAll') : t('onboarding.agents.installAll')}
              </button>
              <button
                className="btn primary"
                type="button"
                disabled={!allReady || busyAgent !== null}
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
                <span>{t('onboarding.directory.projects')}</span>
                <code>{root || '—'}</code>
              </div>
              <div>
                <span>{t('onboarding.directory.workspaces')}</span>
                <code>{root.trim() ? `${root.trim().replace(/\/$/, '')}/workspaces` : workspaceDirectory}</code>
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
  busy,
  onSetup,
  onSavePath,
}: {
  agent: AgentInstallStatus;
  busy: boolean;
  onSetup: () => void;
  onSavePath: (path: string) => void;
}) {
  const t = useT();
  const [path, setPath] = useState(agent.cli.path ?? '');
  const cliReady = agent.cli.state === 'ready';
  const proxyReady = agent.proxy.state === 'ready';
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
          {cliReady ? `${agent.cli.version ?? ''} · ${agent.cli.path ?? ''}` : t('settings.agents.notInstalled')}
        </span>
        <span className={proxyReady ? 'ready' : 'missing'}>
          <b>Proxy</b>
          {proxyReady ? `${agent.proxy.version ?? ''} · ${agent.proxy.source === 'development' ? 'Dev' : 'GitHub'}` : t('settings.agents.notInstalled')}
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
