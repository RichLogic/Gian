import { useState } from 'react';
import { createWorkspace, pickWorkspaceFolder } from '../api.js';
import { useT } from '../i18n/index.js';

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
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<NewWorkspaceFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);

  function reset() {
    setForm(EMPTY_FORM);
    setError(null);
    setNotes([]);
  }

  async function submit() {
    if (!form.name) {
      setError('Name is required');
      return;
    }
    if (form.source === 'adopt' && !form.path.trim()) {
      setError('Path is required');
      return;
    }
    setSaving(true);
    setError(null);
    const result = await createWorkspace(
      form.name,
      form.source === 'adopt'
        ? { path: form.path.trim() }
        : { gitRemote: form.gitRemote.trim() || undefined },
    );
    setSaving(false);
    if (!result.workspace) {
      setError(result.error ?? 'Create failed');
      setNotes(result.notes);
      return;
    }
    reset();
    setOpen(false);
    onChange();
  }

  return { open, setOpen, form, setForm, saving, error, notes, submit, reset };
}

export function NewWorkspacePanel({
  workspaceRoot,
  onChange,
  onClose,
}: {
  workspaceRoot: string;
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
        workspaceRoot={workspaceRoot}
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
  workspaceRoot,
  onChange,
  onSubmit,
  onCancel,
}: {
  form: NewWorkspaceFormState;
  saving: boolean;
  error: string | null;
  workspaceRoot: string;
  onChange: (patch: Partial<NewWorkspaceFormState>) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const isAdopt = form.source === 'adopt';
  const pathPreview = isAdopt
    ? form.path.trim()
    : form.name
      ? `${workspaceRoot.replace(/\/$/, '')}/${form.name}`
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await pickWorkspaceFolder();
    setBusy(false);
    if (result.error) {
      setError(result.error);
    } else if (result.path) {
      onPicked(result.path);
    }
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
