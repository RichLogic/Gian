import { useEffect, useState } from 'react';
import type { AgentInstallStatus, Executor, Workspace } from '@gian/shared';
import { createWorkspace, loadAgents } from '../api.js';
import { useT } from '../i18n/index.js';

export interface CreateSessionInput {
  workspaceId: string;
  name: string;
  executor: Executor;
}

export interface SessionCreateFormState {
  workspaceId: string;
  sessionName: string;
  executor: Executor;
}

export function buildSessionCreatePayload(form: SessionCreateFormState): CreateSessionInput {
  return {
    workspaceId: form.workspaceId,
    name: form.sessionName.trim(),
    executor: form.executor,
  };
}

/** Display blurbs for the built-in agents. Temporary: once agents become
 *  plugins, the manifest owns this metadata and this map goes away. */
const AGENT_DESC: Record<string, string> = {
  codex: 'OpenAI · gpt-5-codex',
  claude: 'CLI plan',
  kimi: 'Moonshot AI · ACP',
};

export function NewSessionView({
  workspaces,
  initialWorkspaceId,
  taskName,
  initialExecutor,
  onWorkspaceCreated,
  onCreate,
  onCancel,
  creating,
}: {
  workspaces: Workspace[];
  /** Preselected workspace (sidebar workspace-row "+" entry point). */
  initialWorkspaceId?: string;
  /** Task context (Tasks sidebar task-row "+" entry point): shown read-only —
   *  the new session is created as a subtask of this task. */
  taskName?: string;
  /** Preselected agent (⌘J/⌘K "new subtask" shortcut carries the choice). */
  initialExecutor?: Executor;
  onWorkspaceCreated: (workspace: Workspace) => void;
  onCreate: (input: CreateSessionInput) => void;
  onCancel: () => void;
  creating: boolean;
}) {
  const t = useT();
  const [selectedWs, setSelectedWs] = useState(() => {
    const initial = initialWorkspaceId
      ? workspaces.find(workspace => workspace.id === initialWorkspaceId && workspace.hidden !== 1)
      : undefined;
    return initial?.id
      ?? workspaces.find(workspace => workspace.hidden !== 1)?.id
      ?? workspaces[0]?.id
      ?? '';
  });
  const [sessionName, setSessionName] = useState('');
  /** Which agents exist and whether they're usable — driven by the host's
   *  /api/agents install status so the picker follows Settings, not a
   *  hardcoded list. Null while loading. */
  const [agents, setAgents] = useState<AgentInstallStatus[] | null>(null);
  const [executor, setExecutor] = useState<Executor | null>(initialExecutor ?? null);
  const [wsName, setWsName] = useState('');
  const [wsRemote, setWsRemote] = useState('');
  const [wsBusy, setWsBusy] = useState(false);
  const [wsError, setWsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadAgents()
      .then(list => { if (!cancelled) setAgents(list); })
      .catch(() => { if (!cancelled) setAgents([]); });
    return () => { cancelled = true; };
  }, []);

  // Default to the first ready agent once the install status lands.
  useEffect(() => {
    if (!agents || executor) return;
    const first = agents.find(agent => agent.ready) ?? agents[0];
    if (first) setExecutor(first.id);
  }, [agents, executor]);

  async function createWs() {
    if (!wsName) return;
    setWsBusy(true);
    setWsError(null);
    const result = await createWorkspace(wsName, { gitRemote: wsRemote.trim() || undefined });
    setWsBusy(false);
    if (!result.workspace) {
      setWsError(result.error ?? 'workspace create failed');
      return;
    }
    onWorkspaceCreated(result.workspace);
    setSelectedWs(result.workspace.id);
    setWsName('');
    setWsRemote('');
  }

  const showInlineCreate = workspaces.length === 0 || selectedWs === '__new__';
  const canCreate = !!selectedWs && selectedWs !== '__new__';
  const selectedAgent = agents?.find(agent => agent.id === executor) ?? null;
  const canSubmit = canCreate && !creating && selectedAgent?.ready === true;

  function submit() {
    if (!canSubmit || !executor) return;
    onCreate(buildSessionCreatePayload({
      workspaceId: selectedWs,
      sessionName,
      executor,
    }));
  }

  return (
    <main className="main">
      <div className="main-head">
        <div className="main-head-l">
          <span className="main-title">{t('coding.new.title')}</span>
        </div>
        <div className="main-head-r">
          <button className="btn ghost sm" onClick={onCancel}>{t('coding.new.cancel')}</button>
        </div>
      </div>
      <div className="ns-wrap">
        <div className="ns-card">
          <div className="ns-head">
            <div className="ns-title">{t('coding.new.heading')}</div>
            <div className="ns-sub">{t('coding.new.sub')}</div>
          </div>
          <div className="ns-body">
            {taskName !== undefined && (
              <div className="field">
                <div className="field-lbl">
                  <span>{t('coding.new.task')}</span>
                  <span className="field-hint">{t('coding.new.task.hint')}</span>
                </div>
                <div className="ns-task-static" data-testid="ns-task-name">{taskName}</div>
              </div>
            )}
            <div className="field">
              <div className="field-lbl">
                <span>{t('coding.new.workspace')}</span>
                <span className="field-hint">{t('coding.new.workspace.hint')}</span>
              </div>
              {workspaces.length > 0 && (
                <select
                  className="select"
                  aria-label="Workspace"
                  value={selectedWs}
                  onChange={event => setSelectedWs(event.target.value)}
                >
                  {workspaces.map(workspace => (
                    <option key={workspace.id} value={workspace.id} disabled={workspace.hidden === 1}>
                      {workspace.name}{workspace.hidden === 1 ? ` (${t('coding.session.workspaceHidden.aria')})` : ''}
                    </option>
                  ))}
                  <option value="__new__">{t('coding.form.ws.createnew')}</option>
                </select>
              )}
              {showInlineCreate && (
                <div className="ns-inline-ws">
                  <input
                    className="input"
                    aria-label={t('coding.form.ws.name.placeholder')}
                    placeholder={t('coding.form.ws.name.placeholder')}
                    value={wsName}
                    onChange={event => setWsName(event.target.value)}
                  />
                  <input
                    className="input"
                    aria-label={t('coding.form.ws.gitremote.label')}
                    placeholder={t('coding.form.ws.gitremote.placeholder')}
                    value={wsRemote}
                    onChange={event => setWsRemote(event.target.value)}
                  />
                  {wsError && <p className="spaces-error">{wsError}</p>}
                  <button
                    className="btn primary sm"
                    onClick={() => void createWs()}
                    disabled={wsBusy || !wsName}
                  >
                    {wsBusy ? (
                      <span className="ns-busy"><span className="ns-spinner" aria-hidden="true" />{t('common.creating')}</span>
                    ) : t('coding.form.ws.create')}
                  </button>
                </div>
              )}
            </div>

            <div className="field">
              <div className="field-lbl">
                <span>{t('coding.new.executor')}</span>
                <span className="field-hint">{t('coding.new.executor.hint')}</span>
              </div>
              <div className="exec-picker">
                {(agents ?? []).map(agent => (
                  <button
                    key={agent.id}
                    type="button"
                    className={`exec-card ${agent.id}${executor === agent.id ? ' active' : ''}`}
                    disabled={!agent.ready}
                    title={agent.ready ? undefined : t('coding.new.executor.notReady')}
                    onClick={() => setExecutor(agent.id)}
                  >
                    <div className="exec-card-dot" />
                    <div className="exec-card-body">
                      <div className="exec-card-name">{agent.name}</div>
                      <div className="exec-card-desc">
                        {agent.ready ? (AGENT_DESC[agent.id] ?? '') : t('coding.new.executor.notReady')}
                      </div>
                    </div>
                  </button>
                ))}
                {agents === null && <div className="field-hint">{t('common.loading')}</div>}
                {agents !== null && agents.length === 0 && (
                  <div className="field-hint">{t('coding.new.executor.none')}</div>
                )}
              </div>
            </div>

            <div className="field">
              <div className="field-lbl">
                <span>{t('coding.new.name')}</span>
                <span className="field-hint">{t('coding.new.name.hint')}</span>
              </div>
              <input
                className="input"
                aria-label={t('coding.form.session.name.label')}
                placeholder={t('coding.new.name.placeholder')}
                value={sessionName}
                onChange={event => setSessionName(event.target.value)}
              />
            </div>
          </div>
          <div className="ns-foot">
            <button className="btn ghost sm" onClick={onCancel} disabled={creating}>
              {t('coding.new.cancel')}
            </button>
            <button className="btn primary sm" disabled={!canSubmit} onClick={submit}>
              {creating ? (
                <span className="ns-busy"><span className="ns-spinner" aria-hidden="true" />{t('common.creating')}</span>
              ) : t('coding.new.create')}
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
