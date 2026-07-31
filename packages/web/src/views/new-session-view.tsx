import { useEffect, useState } from 'react';
import type { ApprovalMode, Executor, Workspace } from '@gian/shared';
import {
  createWorkspace,
  loadBranches,
  loadRemoteBranches,
  loadRepoInfo,
} from '../api.js';
import type { LocalBranch, RemoteBranch } from '../api.js';
import { BranchPicker } from '../components/BranchPicker.js';
import { useT } from '../i18n/index.js';

function shortHexId(): string {
  return Math.random().toString(16).slice(2, 10).padEnd(8, '0');
}

export interface CreateSessionInput {
  workspaceId: string;
  name: string;
  executor: Executor;
  approvalMode?: ApprovalMode;
  mode?: 'regular' | 'worktree';
  baseBranch?: string;
  branch?: string;
  firstMessage?: string;
}

export interface SessionCreateFormState {
  workspaceId: string;
  sessionName: string;
  executor: Executor;
  approvalMode: ApprovalMode;
  mode: 'regular' | 'worktree';
  baseBranch: string;
  composedBranch: string;
  firstMessage: string;
}

export function buildSessionCreatePayload(form: SessionCreateFormState): CreateSessionInput {
  const trimmedFirst = form.firstMessage.trim();
  return {
    workspaceId: form.workspaceId,
    name: form.sessionName.trim(),
    executor: form.executor,
    ...(form.executor === 'kimi' ? {} : { approvalMode: form.approvalMode }),
    mode: form.mode,
    ...(form.mode === 'worktree' && form.baseBranch.trim() ? { baseBranch: form.baseBranch.trim() } : {}),
    ...(form.mode === 'worktree' && form.composedBranch ? { branch: form.composedBranch } : {}),
    ...(trimmedFirst ? { firstMessage: trimmedFirst } : {}),
  };
}

export function NewSessionView({
  workspaces,
  onWorkspaceCreated,
  onCreate,
  onCancel,
  creating,
}: {
  workspaces: Workspace[];
  onWorkspaceCreated: (workspace: Workspace) => void;
  onCreate: (input: CreateSessionInput) => void;
  onCancel: () => void;
  creating: boolean;
}) {
  const t = useT();
  const [selectedWs, setSelectedWs] = useState(
    workspaces.find(workspace => workspace.hidden !== 1)?.id ?? workspaces[0]?.id ?? '',
  );
  const [sessionName, setSessionName] = useState('');
  const [executor, setExecutor] = useState<Executor>('codex');
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>('ask');
  const [mode, setMode] = useState<'regular' | 'worktree'>('regular');
  const [baseBranch, setBaseBranch] = useState('');
  const [branchSuffix, setBranchSuffix] = useState<string>(() => shortHexId());
  const [firstMessage, setFirstMessage] = useState('');
  const [branches, setBranches] = useState<LocalBranch[]>([]);
  const [remoteBranches, setRemoteBranches] = useState<RemoteBranch[]>([]);
  const [branchesLoaded, setBranchesLoaded] = useState(false);
  const [defaultBranchHint, setDefaultBranchHint] = useState<string | null>(null);
  const [wsName, setWsName] = useState('');
  const [wsRemote, setWsRemote] = useState('');
  const [wsBusy, setWsBusy] = useState(false);
  const [wsError, setWsError] = useState<string | null>(null);

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

  useEffect(() => {
    if (mode !== 'worktree' || !canCreate) {
      setBranches([]);
      setRemoteBranches([]);
      setBranchesLoaded(false);
      return;
    }
    let cancelled = false;
    setBranchesLoaded(false);
    void Promise.all([
      loadBranches(selectedWs),
      loadRemoteBranches(selectedWs),
      loadRepoInfo(selectedWs),
    ]).then(([localBranches, remotes, info]) => {
      if (cancelled) return;
      setBranches(localBranches);
      setRemoteBranches(remotes);
      setBranchesLoaded(true);
      const defaultBranch = info?.git.defaultBranch ?? null;
      setDefaultBranchHint(defaultBranch);
      if (defaultBranch && !baseBranch && localBranches.some(branch => branch.name === defaultBranch && !branch.worktreePath)) {
        setBaseBranch(defaultBranch);
      }
    });
    return () => { cancelled = true; };
    // Seed the base branch once per workspace selection, not after user picks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, selectedWs, canCreate]);

  const trimmedSuffix = branchSuffix.trim();
  const composedBranch = trimmedSuffix ? `worktree/${trimmedSuffix}` : '';
  const existingLocalNames = new Set(branches.map(branch => branch.name));
  const branchNameError: string | null =
    mode !== 'worktree' || !branchesLoaded || !composedBranch
      ? null
      : existingLocalNames.has(composedBranch)
        ? `${composedBranch} ${t('coding.form.branchExists')}`
        : null;
  const canSubmit = canCreate
    && !creating
    && (mode === 'regular' || (!!composedBranch && !branchNameError));

  function submit() {
    if (!canSubmit) return;
    onCreate(buildSessionCreatePayload({
      workspaceId: selectedWs,
      sessionName,
      executor,
      approvalMode,
      mode,
      baseBranch,
      composedBranch,
      firstMessage,
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
                <button
                  type="button"
                  className={`exec-card codex${executor === 'codex' ? ' active' : ''}`}
                  onClick={() => {
                    setExecutor('codex');
                    if (approvalMode === 'plan') setApprovalMode('ask');
                  }}
                >
                  <div className="exec-card-dot" />
                  <div className="exec-card-body">
                    <div className="exec-card-name">Codex</div>
                    <div className="exec-card-desc">OpenAI · gpt-5-codex</div>
                  </div>
                </button>
                <button
                  type="button"
                  className={`exec-card claude${executor === 'claude' ? ' active' : ''}`}
                  onClick={() => {
                    setExecutor('claude');
                    if (approvalMode === 'custom' || approvalMode === 'full-access') setApprovalMode('ask');
                  }}
                >
                  <div className="exec-card-dot" />
                  <div className="exec-card-body">
                    <div className="exec-card-name">Claude Code</div>
                    <div className="exec-card-desc">CLI plan</div>
                  </div>
                </button>
                <button
                  type="button"
                  className={`exec-card kimi${executor === 'kimi' ? ' active' : ''}`}
                  onClick={() => setExecutor('kimi')}
                >
                  <div className="exec-card-dot" />
                  <div className="exec-card-body">
                    <div className="exec-card-name">Kimi Code</div>
                    <div className="exec-card-desc">Moonshot AI · ACP</div>
                  </div>
                </button>
              </div>
            </div>

            {executor !== 'kimi' && <div className="field">
              <div className="field-lbl">
                <span>{t('coding.new.approval')}</span>
                <span className="field-hint">{t('coding.new.approval.hint')}</span>
              </div>
              <div className="segm" style={{ width: 'fit-content' }}>
                {(executor === 'codex'
                  ? [
                      ['custom', t('mode.custom')],
                      ['ask', t('composer.approval.ask.title')],
                      ['auto', t('composer.approval.approve.title')],
                      ['full-access', t('mode.full-access')],
                    ] as Array<[ApprovalMode, string]>
                  : [
                      ['plan', t('mode.plan')],
                      ['ask', t('mode.ask')],
                      ['auto', t('mode.auto')],
                    ] as Array<[ApprovalMode, string]>
                ).map(([approval, label]) => (
                  <button
                    key={approval}
                    type="button"
                    className={`segm-item${approvalMode === approval ? ' active' : ''}`}
                    onClick={() => setApprovalMode(approval)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="field-hint">{t('coding.new.approval.help')}</div>
            </div>}

            <div className="field">
              <div className="field-lbl">
                <span>{t('coding.new.mode')}</span>
                <span className="field-hint">{t('coding.new.mode.hint')}</span>
              </div>
              <div className="segm" style={{ width: 'fit-content' }}>
                <button
                  type="button"
                  className={`segm-item${mode === 'regular' ? ' active' : ''}`}
                  onClick={() => setMode('regular')}
                >
                  {t('coding.form.mode.regular')}
                </button>
                <button
                  type="button"
                  className={`segm-item${mode === 'worktree' ? ' active' : ''}`}
                  onClick={() => setMode('worktree')}
                >
                  {t('coding.form.mode.worktree')}
                </button>
              </div>
              {mode === 'worktree' && (
                <div className="ns-worktree-fields">
                  <label className="ns-sublabel">{t('coding.form.baseBranch')}</label>
                  <BranchPicker
                    branches={branches}
                    remoteBranches={remoteBranches}
                    value={baseBranch}
                    defaultBranch={defaultBranchHint}
                    disabled={!branchesLoaded}
                    placeholder={branchesLoaded ? t('coding.form.baseBranch.pick') : t('coding.form.baseBranch.loading')}
                    onChange={setBaseBranch}
                    ariaLabel={t('coding.form.baseBranch')}
                  />
                  <label className="ns-sublabel">{t('coding.form.newBranch')}</label>
                  <div className="branch-name-field">
                    <span className="prefix">worktree/</span>
                    <input
                      aria-label={t('coding.form.newBranchSuffix')}
                      placeholder="short-id"
                      value={branchSuffix}
                      onChange={event => setBranchSuffix(event.target.value)}
                      spellCheck={false}
                    />
                  </div>
                  {branchNameError && (
                    <p className="spaces-error" style={{ marginTop: 4 }}>{branchNameError}</p>
                  )}
                </div>
              )}
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

            <div className="field">
              <div className="field-lbl">
                <span>{t('coding.new.first')}</span>
              </div>
              <textarea
                className="input"
                aria-label={t('coding.form.first.label')}
                rows={4}
                placeholder={t('coding.new.first.placeholder')}
                value={firstMessage}
                onChange={event => setFirstMessage(event.target.value)}
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
