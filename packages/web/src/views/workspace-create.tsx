import { useEffect, useState } from 'react';
import type { CloneWorkspaceRepoResult, PickFolderResult } from '../api.js';
import { useT } from '../i18n/index.js';
import { useOperationDispatch, useOperationRun } from '../operations/use-operations.js';

export interface NewWorkspaceFormState {
  name: string;
  path: string;
  gitUrl: string;
  nameTouched: boolean;
}

const EMPTY_FORM: NewWorkspaceFormState = {
  name: '',
  path: '',
  gitUrl: '',
  nameTouched: false,
};

export function useNewWorkspace(onChange: () => void) {
  const dispatch = useOperationDispatch();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<NewWorkspaceFormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  // Create runs as a pending operation (Phase 3a): `saving` reflects the
  // in-flight run; canonical state converges via the definition's reconcile
  // (upsert + refetch — the host does not broadcast workspace creates over
  // REST).
  const [createRunId, setCreateRunId] = useState<string | undefined>(undefined);
  const createRun = useOperationRun(createRunId);
  const saving = createRun?.phase === 'pending';
  // Clone-only run (issue #57): materializes the remote under the workspace
  // root and fills the Directory field; registration happens on Create.
  const [cloneRunId, setCloneRunId] = useState<string | undefined>(undefined);
  const cloneRun = useOperationRun(cloneRunId);
  const cloning = cloneRun?.phase === 'pending';

  function reset() {
    setForm(EMPTY_FORM);
    setError(null);
  }

  useEffect(() => {
    if (!createRun) return;
    if (createRun.phase === 'confirmed') {
      setCreateRunId(undefined);
      reset();
      setOpen(false);
      onChange();
    } else if (createRun.phase === 'failed') {
      setError(createRun.error ?? 'Create failed');
      setCreateRunId(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createRun?.phase]);

  useEffect(() => {
    if (!cloneRun) return;
    if (cloneRun.phase === 'confirmed') {
      const result = cloneRun.result as CloneWorkspaceRepoResult | undefined;
      setCloneRunId(undefined);
      if (result?.path) {
        setForm(previous => ({
          ...previous,
          path: result.path!,
          // Adopt the clone's directory name unless the user typed one.
          ...(!previous.nameTouched && result.name ? { name: result.name } : {}),
        }));
      }
    } else if (cloneRun.phase === 'failed') {
      setError(cloneRun.error ?? 'Clone failed');
      setCloneRunId(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloneRun?.phase]);

  function submit() {
    if (!form.name) {
      setError('Name is required');
      return;
    }
    if (!form.path.trim()) {
      setError('Directory is required — browse to one, or clone a Git URL below');
      return;
    }
    setError(null);
    const run = dispatch('workspace.create', {
      name: form.name,
      path: form.path.trim(),
    });
    setCreateRunId(run.id);
  }

  function clone() {
    const gitRemote = form.gitUrl.trim();
    if (!gitRemote || cloning) return;
    setError(null);
    const run = dispatch('workspace.cloneRepo', {
      gitRemote,
      ...(form.name ? { name: form.name } : {}),
    });
    setCloneRunId(run.id);
  }

  return { open, setOpen, form, setForm, saving, cloning, error, submit, clone, reset };
}

export function NewWorkspacePanel({
  onChange,
  onClose,
}: {
  onChange: () => void;
  onClose: () => void;
}) {
  const workspace = useNewWorkspace(() => {
    onChange();
    onClose();
  });
  return (
    <div className="ws-new-panel">
      <NewWorkspaceForm
        form={workspace.form}
        saving={workspace.saving}
        cloning={workspace.cloning}
        error={workspace.error}
        onChange={patch => workspace.setForm(previous => ({ ...previous, ...patch }))}
        onSubmit={workspace.submit}
        onClone={workspace.clone}
        onCancel={onClose}
      />
    </div>
  );
}

export function NewWorkspaceForm({
  form,
  saving,
  cloning,
  error,
  onChange,
  onSubmit,
  onClone,
  onCancel,
}: {
  form: NewWorkspaceFormState;
  saving: boolean;
  cloning: boolean;
  error: string | null;
  onChange: (patch: Partial<NewWorkspaceFormState>) => void;
  onSubmit: () => void;
  onClone: () => void;
  onCancel: () => void;
}) {
  const t = useT();

  function changePath(value: string) {
    const patch: Partial<NewWorkspaceFormState> = { path: value };
    if (!form.nameTouched) {
      const tail = value.trim().replace(/\/+$/, '').split('/').filter(Boolean).pop() ?? '';
      patch.name = tail.replace(/[^a-zA-Z0-9._-]/g, '-');
    }
    onChange(patch);
  }

  const submitDisabled = saving || cloning || !form.name || !form.path.trim();
  return (
    <div className="wsn-form">
      <div className="field">
        <div className="field-lbl">
          <span>Name</span>
          <span className="field-hint">a-z A-Z 0-9 . _ -</span>
        </div>
        <input
          className="input"
          aria-label="Workspace name"
          placeholder="my-project"
          value={form.name}
          onChange={event => onChange({ name: event.target.value, nameTouched: true })}
          autoFocus
        />
      </div>

      <div className="field">
        <div className="field-lbl">
          <span>Directory</span>
          <span className="field-hint">absolute path</span>
        </div>
        <div className="wsn-row">
          <input
            className="input"
            aria-label="Workspace path"
            placeholder="/Users/you/Code/some-project"
            value={form.path}
            onChange={event => changePath(event.target.value)}
            spellCheck={false}
          />
          <BrowseFolderButton
            disabled={saving || cloning}
            onPicked={changePath}
          />
        </div>
      </div>

      <div className="field">
        <div className="field-lbl">
          <span>Git URL</span>
          <span className="field-hint">clone fills the directory above</span>
        </div>
        <div className="wsn-row">
          <input
            className="input"
            aria-label="Git URL"
            placeholder="git@github.com:you/repo.git"
            value={form.gitUrl}
            onChange={event => onChange({ gitUrl: event.target.value })}
            spellCheck={false}
          />
          <button
            type="button"
            className="btn sm ghost wsn-clone"
            data-testid="ws-clone"
            onClick={onClone}
            disabled={cloning || saving || !form.gitUrl.trim()}
          >
            {cloning ? (
              <span className="ns-busy"><span className="ns-spinner" aria-hidden="true" />Cloning…</span>
            ) : 'Clone'}
          </button>
        </div>
      </div>

      {error && <p className="spaces-error">{error}</p>}
      <div className="wsn-actions">
        <button className="btn sm ghost" onClick={onCancel} disabled={saving}>
          {t('spaces.form.cancel')}
        </button>
        <button className="btn sm primary" data-testid="ws-create" onClick={onSubmit} disabled={submitDisabled}>
          {saving ? t('spaces.form.creating') : t('spaces.form.create')}
        </button>
      </div>
    </div>
  );
}

function BrowseFolderButton({
  disabled,
  onPicked,
}: {
  disabled?: boolean;
  onPicked: (path: string) => void;
}) {
  const dispatch = useOperationDispatch();
  const [error, setError] = useState<string | null>(null);
  // The native picker runs as a pending operation (Phase 3a). A cancel is a
  // CONFIRMED no-op — the button simply re-enables with no picked path.
  const [pickRunId, setPickRunId] = useState<string | undefined>(undefined);
  const pickRun = useOperationRun(pickRunId);
  const busy = pickRun?.phase === 'pending';

  useEffect(() => {
    if (!pickRun) return;
    if (pickRun.phase === 'confirmed') {
      const result = pickRun.result as PickFolderResult | undefined;
      setPickRunId(undefined);
      if (result?.path) onPicked(result.path);
    } else if (pickRun.phase === 'failed') {
      setError(pickRun.error ?? 'Picker failed');
      setPickRunId(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickRun?.phase]);

  function pick() {
    if (busy) return;
    setError(null);
    const run = dispatch('workspace.pickFolder', {});
    setPickRunId(run.id);
  }

  return (
    <>
      <button
        type="button"
        className="btn sm ghost spaces-browse-btn"
        onClick={() => void pick()}
        disabled={disabled || busy}
        title="Open native folder picker"
      >
        {busy ? 'Picking…' : 'Browse…'}
      </button>
      {error && <p className="spaces-error">{error}</p>}
    </>
  );
}
