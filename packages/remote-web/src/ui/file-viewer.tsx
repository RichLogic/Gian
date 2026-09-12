/**
 * Read-only file/attachment viewer (B8, §12.3). Only controller-issued opaque
 * handles; display labels never leak an absolute Host path. No edit, save,
 * write-back, or "open locally" surface exists. Layout tier is the caller's
 * job (wide = right panel, mid = full main panel, narrow = full page).
 */

import { mutationsEnabled } from '../controller/types.js';
import { useT } from '../i18n/index.js';
import { useRemoteActions, useRemoteState } from './controller-context.js';
import { Icon } from './icons.js';

export function FileViewerBody() {
  const t = useT();
  const state = useRemoteState();
  const actions = useRemoteActions();
  const viewer = state.fileViewer;
  if (!viewer) return null;
  const handle = viewer.handle;

  const download = state.fileDownload;
  const canDownload =
    mutationsEnabled(state.connection) &&
    state.capabilities['file.download']?.state === 'supported' &&
    download.status !== 'downloading';

  return (
    <div className="rw-file" data-file-status={viewer.status}>
      <div className="sheet-path-row">
        <span className="sheet-path">
          {handle.dirLabel && <span className="sheet-path-dir">{handle.dirLabel}</span>}
          <span className="sheet-path-file">{handle.label}</span>
        </span>
        <span className="sheet-content-actions">
          <span className="rw-sheet-head-note">{t('file.readonly')}</span>
          <button
            type="button"
            className="sb-iconbtn"
            title={t('file.download')}
            aria-label={t('file.download')}
            disabled={!canDownload}
            onClick={() => actions.downloadFile()}
          >
            <Icon name="download" size={14} />
          </button>
          <button
            type="button"
            className="sb-iconbtn"
            title={t('file.close')}
            aria-label={t('file.close')}
            onClick={() => actions.closeFile()}
          >
            <Icon name="close" size={14} />
          </button>
        </span>
      </div>

      {download.status === 'downloading' && (
        <div className="session-banner rw-info" role="status">
          <span className="spinner" role="status" aria-label={t('file.download')} />
          <span>{t('file.downloading', { pct: download.pct })}</span>
        </div>
      )}
      {download.status === 'error' && (
        <div className="session-banner rw-danger" role="alert">
          <Icon name="warning" size={13} />
          <span>{t('file.downloadError', { message: download.message })}</span>
        </div>
      )}

      {viewer.status === 'loading' && (
        <div className="rw-file-state" role="status">
          <span className="spinner" aria-label={t('file.loading')} />
          {t('file.loading')}
        </div>
      )}
      {viewer.status === 'ready' && (
        <pre className="sheet-text" data-testid="file-content">{viewer.text}</pre>
      )}
      {viewer.status === 'image' && (
        <div className="rw-file-image-wrap">
          <img className="rw-file-image" src={viewer.dataUrl} alt={handle.label} />
        </div>
      )}
      {viewer.status === 'binary' && (
        <div className="rw-file-state" role="status">{t('file.binary')}</div>
      )}
      {viewer.status === 'changed' && (
        <>
          <div className="session-banner rw-warn" role="status">
            <Icon name="warning" size={13} />
            <span>{t('file.changed')}</span>
            <span className="session-banner-spacer" />
            <button type="button" className="btn xs secondary" onClick={() => actions.reloadFile()}>
              {t('file.reload')}
            </button>
          </div>
          <pre className="sheet-text">{viewer.text}</pre>
        </>
      )}
      {viewer.status === 'expired' && (
        <div className="rw-file-state" role="alert">{t('file.expired')}</div>
      )}
      {viewer.status === 'too_large' && (
        <div className="rw-file-state" role="status">{t('file.tooLarge', { limit: viewer.limitLabel })}</div>
      )}
      {viewer.status === 'error' && (
        <div className="rw-file-state" role="alert">{viewer.message}</div>
      )}
    </div>
  );
}

/** Wide layout: right-side sheet panel (mockup F2). */
export function FileSheetPanel() {
  return (
    <div className="sheet rw-file-sheet">
      <div className="sheet-group">
        <FileViewerBody />
      </div>
    </div>
  );
}

/** Mid layout: replaces chat as the full main panel (mockup F16). */
export function FileMainPanel() {
  const t = useT();
  const actions = useRemoteActions();
  return (
    <main className="main" style={{ minWidth: 0 }}>
      <div className="main-head">
        <div className="main-head-l" style={{ gap: 6 }}>
          <button
            type="button"
            className="sb-iconbtn"
            title={t('file.backToChat')}
            aria-label={t('file.backToChat')}
            onClick={() => actions.closeFile()}
          >
            <Icon name="back" size={15} />
          </button>
          <span>{t('file.backToChat')}</span>
        </div>
      </div>
      <div className="main-scroll" style={{ padding: '10px 0' }}>
        <FileViewerBody />
      </div>
    </main>
  );
}

/** Narrow layout: full page with a back button (mockup F5). */
export function FilePage() {
  const t = useT();
  const actions = useRemoteActions();
  return (
    <main className="main">
      <div className="main-head">
        <div className="main-head-l" style={{ gap: 6 }}>
          <button
            type="button"
            className="sb-iconbtn"
            title={t('file.back')}
            aria-label={t('file.back')}
            onClick={() => actions.closeFile()}
          >
            <Icon name="back" size={15} />
          </button>
        </div>
      </div>
      <div className="main-scroll" style={{ padding: '10px 0' }}>
        <FileViewerBody />
      </div>
    </main>
  );
}
