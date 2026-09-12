import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Workspace } from '@gian/shared';
import { useT } from '../i18n/index.js';
import { useOperationDispatch, useOperationRun } from '../operations/use-operations.js';
import { NewWorkspaceForm, useNewWorkspace } from './workspace-create.js';

/** The App-owned Repo dialog (2026-09-09, owner mockup): a centered modal
 *  replacing both the Workbench "New Repo" sheet tab and the sidebar group
 *  header's inline rename. Create mode reuses the issue-#57 NewWorkspaceForm
 *  unchanged (same testids/aria-labels); edit mode keeps the same three-row
 *  layout with Directory/Git URL read-only — only the name can change. */
export type WorkspaceDialogState =
  | { kind: 'create' }
  | { kind: 'edit'; workspace: Workspace };

export function WorkspaceDialog({
  dialog,
  onClose,
  onChanged,
}: {
  dialog: WorkspaceDialogState;
  onClose: () => void;
  onChanged: () => void;
}) {
  return createPortal(
    dialog.kind === 'create'
      ? <CreateWorkspaceDialog onClose={onClose} onChanged={onChanged} />
      : <EditWorkspaceDialog workspace={dialog.workspace} onClose={onClose} onChanged={onChanged} />,
    document.body,
  );
}

/** Backdrop + Escape chrome shared by both modes. `busy` blocks dismissal so
 *  an in-flight create/rename is never orphaned mid-run. */
function DialogShell({
  title,
  busy,
  onClose,
  children,
}: {
  title: string;
  busy: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  return (
    <div className="ws-dialog-backdrop" onClick={() => { if (!busy) onClose(); }}>
      <div
        className="ws-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={event => event.stopPropagation()}
      >
        <header className="ws-dialog-head">
          <h2 className="ws-dialog-title">{title}</h2>
        </header>
        <div className="ws-dialog-body">{children}</div>
      </div>
    </div>
  );
}

function CreateWorkspaceDialog({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useT();
  // A confirmed create triggers the same workspace-list reload the sheet's
  // onChange did — App's handler consumes the new-session return flag, so the
  // "+ New Repo" round trip from the new-session page still preselects the
  // created workspace.
  const workspace = useNewWorkspace(() => {
    onChanged();
    onClose();
  });
  return (
    <DialogShell
      title={t('coding.new.workspace.new')}
      busy={workspace.saving || workspace.cloning}
      onClose={onClose}
    >
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
    </DialogShell>
  );
}

function EditWorkspaceDialog({
  workspace,
  onClose,
  onChanged,
}: {
  workspace: Workspace;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useT();
  const dispatch = useOperationDispatch();
  const [name, setName] = useState(workspace.name);
  const [error, setError] = useState<string | null>(null);
  const [renameRunId, setRenameRunId] = useState<string | undefined>(undefined);
  const renameRun = useOperationRun(renameRunId);
  const saving = renameRun?.phase === 'optimistic' || renameRun?.phase === 'pending';

  useEffect(() => {
    if (!renameRun) return;
    if (renameRun.phase === 'confirmed') {
      setRenameRunId(undefined);
      onChanged();
      onClose();
    } else if (renameRun.phase === 'failed' || renameRun.phase === 'timed-out') {
      setError(renameRun.error ?? 'Rename failed');
      setRenameRunId(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renameRun?.phase]);

  const trimmed = name.trim();
  const unchanged = trimmed === workspace.name;
  const saveDisabled = saving || !trimmed || unchanged;

  function save() {
    if (saveDisabled) return;
    setError(null);
    const run = dispatch('workspace.rename', { workspaceId: workspace.id, name: trimmed });
    setRenameRunId(run.id);
  }

  return (
    <DialogShell title={t('coding.workspace.dialog.edit')} busy={saving} onClose={onClose}>
      <div className="wsn-form">
        <div className="field">
          <div className="field-lbl">
            <span>Name</span>
            <span className="field-hint">a-z A-Z 0-9 . _ -</span>
          </div>
          <input
            className="input"
            aria-label="Repo name"
            value={name}
            onChange={event => setName(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') save(); }}
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
              aria-label="Repo path"
              value={workspace.path}
              disabled
              spellCheck={false}
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
              value=""
              disabled
              spellCheck={false}
            />
          </div>
        </div>

        {error && <p className="spaces-error">{error}</p>}
        <div className="wsn-actions">
          <button className="btn sm ghost" onClick={onClose} disabled={saving}>
            {t('spaces.form.cancel')}
          </button>
          <button
            className="btn sm primary"
            data-testid="ws-save"
            onClick={save}
            disabled={saveDisabled}
          >
            {t('coding.workspace.dialog.save')}
          </button>
        </div>
      </div>
    </DialogShell>
  );
}
