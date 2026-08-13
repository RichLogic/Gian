import { useEffect, useMemo, useRef } from 'react';
import type { Task } from '@gian/shared';
import { useT } from '../i18n/index.js';

export function AssignSessionTaskDialog({
  sessionName,
  tasks,
  pending = false,
  error,
  onSelect,
  onCancel,
}: {
  sessionName: string;
  tasks: Task[];
  pending?: boolean;
  error?: string | null;
  onSelect: (taskId: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const dialogRef = useRef<HTMLDivElement>(null);
  const activeTasks = useMemo(
    () => tasks.filter(task => task.status === 'open'),
    [tasks],
  );

  useEffect(() => {
    const activeElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    // Clicking the dropdown item removes it during the same React commit, so
    // focus is often already back on <body> by the time this effect runs.
    const previousFocus = activeElement && activeElement !== document.body
      ? activeElement
      : document.querySelector<HTMLElement>('.path-seg.session');
    const firstButton = dialogRef.current?.querySelector<HTMLElement>('button:not([disabled])');
    (firstButton ?? dialogRef.current)?.focus();
    return () => {
      if (previousFocus?.isConnected) previousFocus.focus();
      else document.querySelector<HTMLElement>('.path-seg.session')?.focus();
    };
  }, []);

  useEffect(() => {
    if (pending) dialogRef.current?.focus();
  }, [pending]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !pending) {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [],
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel, pending]);

  return (
    <div
      className="confirm-overlay"
      data-testid="assign-session-task-overlay"
      onMouseDown={event => {
        if (event.target === event.currentTarget && !pending) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className="confirm-modal assign-session-task-modal"
        role="dialog"
        aria-modal="true"
        aria-busy={pending}
        aria-labelledby="assign-session-task-title"
        aria-describedby="assign-session-task-description"
        tabIndex={-1}
      >
        <h2 className="confirm-title" id="assign-session-task-title">
          {t('session.assignTask.title')}
        </h2>
        <p className="confirm-msg" id="assign-session-task-description">
          {t('session.assignTask.description')}
        </p>
        <p className="assign-session-task-name" title={sessionName}>{sessionName}</p>

        <div
          className="assign-session-task-list"
          data-testid="assign-session-task-list"
          aria-busy={pending}
        >
          {activeTasks.length === 0 ? (
            <p className="assign-session-task-empty">{t('session.assignTask.empty')}</p>
          ) : activeTasks.map(task => (
            <button
              key={task.id}
              type="button"
              className="mp-row"
              data-testid={`assign-session-task-${task.id}`}
              title={task.name}
              disabled={pending}
              onClick={() => onSelect(task.id)}
            >
              <svg
                className="assign-session-task-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              </svg>
              <span className="mp-row-body">
                <span className="mp-row-title">{task.name}</span>
              </span>
            </button>
          ))}
        </div>

        {error && <p className="spaces-error" role="alert">{error}</p>}

        <div className="confirm-actions">
          <button type="button" className="btn ghost" disabled={pending} onClick={onCancel}>
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
