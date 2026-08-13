import type { GianScreenshotCapture, Session } from '@gian/shared';
import type { UploadedAttachment } from './api.js';
import { injectComposerAttachment } from './components/Composer.js';
import { storeNewSessionScreenshot } from './screenshot-drafts.js';

export type ScreenshotRouteResult =
  | { ok: true; kind: 'session' | 'new-session' }
  | { ok: false; reason: 'missing-target' | 'upload-failed' };

export interface ScreenshotRouteDeps {
  findSession: (sessionId: string) => Session | null;
  onSelectSession: (session: Session) => void;
  upload: (sessionId: string, blob: Blob, filename: string) => Promise<UploadedAttachment>;
  inject?: (sessionId: string, attachment: UploadedAttachment) => void;
  storeNew?: typeof storeNewSessionScreenshot;
}

/** Route exclusively by the target snapshotted at capture start. */
export async function routeScreenshotCapture(
  capture: GianScreenshotCapture,
  deps: ScreenshotRouteDeps,
): Promise<ScreenshotRouteResult> {
  if (capture.target.kind === 'new-session') {
    await (deps.storeNew ?? storeNewSessionScreenshot)(capture.target.scope, capture);
    return { ok: true, kind: 'new-session' };
  }

  const session = deps.findSession(capture.target.sessionId);
  if (!session || session.archived === 1) return { ok: false, reason: 'missing-target' };
  const bytes = new Uint8Array(capture.bytes);
  let uploaded: UploadedAttachment;
  try {
    uploaded = await deps.upload(
      session.id,
      new Blob([bytes.slice().buffer], { type: capture.mime }),
      capture.filename,
    );
  } catch {
    return { ok: false, reason: 'upload-failed' };
  }

  // The target may have been deleted while the upload was in flight. Never
  // redirect to whichever Session happens to be active now.
  const stillExists = deps.findSession(session.id);
  if (!stillExists || stillExists.archived === 1) {
    return { ok: false, reason: 'missing-target' };
  }
  (deps.inject ?? injectComposerAttachment)(session.id, uploaded);
  deps.onSelectSession(stillExists);
  return { ok: true, kind: 'session' };
}
