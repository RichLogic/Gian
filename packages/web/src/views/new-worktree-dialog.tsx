import { useMemo, useState } from 'react';
import type { Executor, Workspace } from '@gian/shared';
import type { LocalBranch, RemoteBranch } from '../api.js';
import { BranchPicker } from '../components/BranchPicker.js';
import { useT } from '../i18n/index.js';

export function NewWorktreeDialog({
  workspace,
  defaultBranch,
  branches,
  remoteBranches,
  onCancel,
  onCreate,
}: {
  workspace: Workspace;
  defaultBranch: string | null;
  branches: LocalBranch[];
  remoteBranches: RemoteBranch[];
  onCancel: () => void;
  onCreate: (input: {
    executor: Executor;
    baseBranch?: string;
    branch?: string;
  }) => void;
}) {
  const [executor, setExecutor] = useState<Executor>('codex');
  const t = useT();
  const existingLocalNames = useMemo(() => new Set(branches.map(b => b.name)), [branches]);
  // Seed base branch with the workspace default if it exists locally and
  // isn't already checked out elsewhere; otherwise fall back to the first
  // pickable branch, or just leave the field for the user.
  const initialBase = (() => {
    if (defaultBranch && branches.some(b => b.name === defaultBranch && !b.worktreePath)) {
      return defaultBranch;
    }
    const firstFree = branches.find(b => !b.worktreePath);
    return firstFree?.name ?? defaultBranch ?? '';
  })();
  const [baseBranch, setBaseBranch] = useState(initialBase);
  const [branchSuffix, setBranchSuffix] = useState<string>(() => shortId());
  const [submitting, setSubmitting] = useState(false);

  const trimmedSuffix = branchSuffix.trim();
  const composedBranch = trimmedSuffix ? `worktree/${trimmedSuffix}` : '';
  // Collision check on the composed name. The host also validates via
  // `git check-ref-format` for syntactic issues — we cover the common case
  // "name already exists" here.
  const branchNameError: string | null = !composedBranch
    ? null
    : existingLocalNames.has(composedBranch)
      ? `${t('spaces.git.branch')} "${composedBranch}" ${t('coding.form.branchExists')}`
      : null;

  function submit() {
    setSubmitting(true);
    onCreate({
      executor,
      ...(baseBranch.trim() ? { baseBranch: baseBranch.trim() } : {}),
      ...(composedBranch ? { branch: composedBranch } : {}),
    });
    // Parent closes the dialog optimistically; nothing else to do here.
  }

  return (
    <div className="adopt-dialog-backdrop" onClick={onCancel}>
      <div className="adopt-dialog" onClick={e => e.stopPropagation()}>
        <header className="adopt-dialog-head">
          <h2 className="adopt-dialog-title">{t('spaces.git.newWorktree')}</h2>
          <p className="adopt-dialog-sub">
            {t('spaces.git.newWorktreeSubPrefix')} <strong>{workspace.name}</strong>{t('spaces.git.newWorktreeSubSuffix')}
          </p>
        </header>
        <div className="adopt-dialog-body">
          <div className="adopt-field">
            <label className="adopt-label">{t('coding.form.baseBranch')}</label>
            <BranchPicker
              branches={branches}
              remoteBranches={remoteBranches}
              value={baseBranch}
              defaultBranch={defaultBranch}
              placeholder={t('coding.form.baseBranch.pick')}
              onChange={setBaseBranch}
              ariaLabel={t('coding.form.baseBranch')}
            />
          </div>

          <div className="adopt-field">
            <label className="adopt-label">{t('coding.form.newBranch')}</label>
            <div className="branch-name-field">
              <span className="prefix">worktree/</span>
              <input
                aria-label={t('coding.form.newBranchSuffix')}
                placeholder="short-id"
                value={branchSuffix}
                onChange={e => setBranchSuffix(e.target.value)}
                spellCheck={false}
              />
            </div>
            {branchNameError && (
              <p className="spaces-error" style={{ marginTop: 4 }}>{branchNameError}</p>
            )}
          </div>

          <div className="adopt-field">
            <label className="adopt-label">{t('coding.new.executor')}</label>
            <div className="segm" style={{ width: 'fit-content' }}>
              {(['claude', 'codex', 'kimi'] as const).map(x => (
                <button
                  key={x}
                  type="button"
                  className={`segm-item${executor === x ? ' active' : ''}`}
                  onClick={() => setExecutor(x)}
                >
                  {x === 'claude' ? 'Claude Code' : x === 'codex' ? 'Codex' : 'Kimi Code'}
                </button>
              ))}
            </div>
          </div>
        </div>
        <footer className="adopt-dialog-foot">
          <button className="btn ghost" onClick={onCancel} disabled={submitting}>{t('common.cancel')}</button>
          <button
            className="btn primary"
            onClick={submit}
            disabled={submitting || !composedBranch || !!branchNameError}
          >
            {submitting ? t('common.creating') : t('common.create')}
          </button>
        </footer>
      </div>
    </div>
  );
}

function shortId(): string {
  // 8 hex chars, matches the host's gian/<8-char-uuid> default convention.
  return Math.random().toString(16).slice(2, 10).padEnd(8, '0');
}
