import { useEffect, useSyncExternalStore } from 'react';
import {
  dismissToast,
  getSnapshot,
  resolveConfirm,
  subscribe,
  type ConfirmRecord,
  type ToastKind,
  type ToastRecord,
} from '../feedback.js';
import { useT } from '../i18n/index.js';

// Inline glyphs per kind — kept local so the component has no icon-lib dep.
const KIND_ICON: Record<ToastKind, string> = {
  info: 'M12 8.5v.01 M11 12h1v4h1',
  success: 'M5 12l4 4 10-10',
  warning: 'M12 4l9 16H3z M12 10v4 M12 17v.01',
  error: 'M6 6l12 12 M18 6L6 18',
};

function ToastIcon({ kind }: { kind: ToastKind }) {
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor"
         strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {KIND_ICON[kind].split(' M').map((seg, i) => <path key={i} d={i === 0 ? seg : `M${seg}`} />)}
    </svg>
  );
}

function ToastCard({ toast }: { toast: ToastRecord }) {
  useEffect(() => {
    if (toast.duration <= 0) return;
    const handle = setTimeout(() => dismissToast(toast.id), toast.duration);
    return () => clearTimeout(handle);
  }, [toast.id, toast.duration]);

  return (
    <div className={`toast toast-${toast.kind}`} role="status" aria-live="polite">
      <span className="toast-ico"><ToastIcon kind={toast.kind} /></span>
      <div className="toast-body">
        {toast.title && <div className="toast-title">{toast.title}</div>}
        <div className="toast-msg">{toast.message}</div>
      </div>
      <button type="button" className="toast-x" aria-label="Dismiss" onClick={() => dismissToast(toast.id)}>
        <svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke="currentColor"
             strokeWidth={2.2} strokeLinecap="round"><path d="M6 6l12 12 M18 6L6 18" /></svg>
      </button>
    </div>
  );
}

function ConfirmModal({ record }: { record: ConfirmRecord }) {
  const t = useT();
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); resolveConfirm(record.id, false); }
      else if (e.key === 'Enter') { e.preventDefault(); resolveConfirm(record.id, true); }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [record.id]);

  return (
    <div
      className="confirm-overlay"
      onPointerDown={e => { if (e.target === e.currentTarget) resolveConfirm(record.id, false); }}
    >
      <div className="confirm-modal" role="alertdialog" aria-modal="true"
           aria-label={record.title ?? record.message}>
        {record.title && <div className="confirm-title">{record.title}</div>}
        <div className="confirm-msg">{record.message}</div>
        <div className="confirm-actions">
          <button type="button" className="btn ghost sm" onClick={() => resolveConfirm(record.id, false)}>
            {record.cancelLabel ?? t('common.cancel')}
          </button>
          <button
            type="button"
            className={`btn sm ${record.danger ? 'danger' : 'primary'}`}
            autoFocus
            onClick={() => resolveConfirm(record.id, true)}
          >
            {record.confirmLabel ?? t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Single mount point for app-wide toasts + confirm dialogs. Place once near
 *  the app root; everything else drives it via `toast()` / `confirm()`. */
export function Toaster() {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  // One confirm at a time — show the oldest pending request.
  const activeConfirm = snap.confirms[0] ?? null;
  return (
    <>
      {snap.toasts.length > 0 && (
        <div className="toast-region" aria-live="polite">
          {snap.toasts.map(t => <ToastCard key={t.id} toast={t} />)}
        </div>
      )}
      {activeConfirm && <ConfirmModal record={activeConfirm} />}
    </>
  );
}
