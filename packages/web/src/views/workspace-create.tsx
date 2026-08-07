import { useEffect, useState } from 'react';
import type { PickFolderResult } from '../api.js';
import { useT } from '../i18n/index.js';
import { useOperationDispatch, useOperationRun } from '../operations/use-operations.js';

type NewWorkspaceSource = 'new' | 'adopt';

export interface NewWorkspaceFormState {
  source: NewWorkspaceSource;
  name: string;
  gitRemote: string;
  path: string;
  nameTouched: boolean;
}

const EMPTY_FORM: NewWorkspaceFormState = {
  source: 'new',
  name: '',
  gitRemote: '',
  path: '',
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

  function submit() {
    if (!form.name) {
      setError('Name is required');
      return;
    }
    if (form.source === 'adopt' && !form.path.trim()) {
      setError('Path is required');
      return;
    }
    setError(null);
    const run = dispatch('workspace.create', {
      name: form.name,
      ...(form.source === 'adopt'
        ? { path: form.path.trim() }
        : { ...(form.gitRemote.trim() ? { gitRemote: form.gitRemote.trim() } : {}) }),
    });
    setCreateRunId(run.id);
  }

  return { open, setOpen, form, setForm, saving, error, submit, reset };
}

export function NewWorkspacePanel({
  projectRoot,
  onChange,
  onClose,
}: {
  projectRoot: string;
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
        error={workspace.error}
        projectRoot={projectRoot}
        onChange={patch => workspace.setForm(previous => ({ ...previous, ...patch }))}
        onSubmit={workspace.submit}
        onCancel={onClose}
      />
    </div>
  );
}

export function NewWorkspaceForm({
  form,
  saving,
  error,
  projectRoot,
  onChange,
  onSubmit,
  onCancel,
}: {
  form: NewWorkspaceFormState;
  saving: boolean;
  error: string | null;
  projectRoot: string;
  onChange: (patch: Partial<NewWorkspaceFormState>) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const isAdopt = form.source === 'adopt';
  const pathPreview = isAdopt
    ? form.path.trim()
    : form.name
      ? `${projectRoot.replace(/\/$/, '')}/${form.name}`
      : '';

  function changePath(value: string) {
    const patch: Partial<NewWorkspaceFormState> = { path: value };
    if (isAdopt && !form.nameTouched) {
      const tail = value.trim().replace(/\/+$/, '').split('/').filter(Boolean).pop() ?? '';
      patch.name = tail.replace(/[^a-zA-Z0-9._-]/g, '-');
    }
    onChange(patch);
  }

  const submitDisabled = saving || !form.name || (isAdopt && !form.path.trim());
  return (
    <div className="spaces-new-form">
      <div className="segm spaces-new-source" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={!isAdopt}
          className={`segm-item${!isAdopt ? ' active' : ''}`}
          onClick={() => onChange({ source: 'new' })}
        >
          New
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={isAdopt}
          className={`segm-item${isAdopt ? ' active' : ''}`}
          onClick={() => onChange({ source: 'adopt' })}
        >
          Adopt path
        </button>
      </div>
      {isAdopt && (
        <div className="spaces-new-path-row">
          <input
            className="input"
            aria-label="Workspace path"
            placeholder="/Users/you/Code/some-project or ~/Code/some-project"
            value={form.path}
            onChange={event => changePath(event.target.value)}
            autoFocus
            spellCheck={false}
          />
          <BrowseFolderButton
            disabled={saving}
            onPicked={changePath}
          />
        </div>
      )}
      <input
        className="input"
        aria-label="Workspace name"
        placeholder="Name (a-z A-Z 0-9 . _ -)"
        value={form.name}
        onChange={event => onChange({ name: event.target.value, nameTouched: true })}
        autoFocus={!isAdopt}
      />
      {!isAdopt && (
        <input
          className="input"
          aria-label="Git remote URL"
          placeholder="Git remote URL (optional)"
          value={form.gitRemote}
          onChange={event => onChange({ gitRemote: event.target.value })}
        />
      )}
      {pathPreview && (
        <div className="spaces-path-preview">
          <span className="spaces-path-preview-lbl">→</span>
          <span className="spaces-path-preview-val">{pathPreview}</span>
        </div>
      )}
      {error && <p className="spaces-error">{error}</p>}
      <div className="spaces-new-form-actions">
        <button className="btn sm ghost" onClick={onCancel} disabled={saving}>
          {t('spaces.form.cancel')}
        </button>
        <button className="btn sm primary" onClick={onSubmit} disabled={submitDisabled}>
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
