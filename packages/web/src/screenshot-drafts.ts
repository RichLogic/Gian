import type {
  GianScreenshotCapture,
  GianScreenshotTarget,
} from '@gian/shared';

export type NewSessionScreenshotScope = Extract<
  GianScreenshotTarget,
  { kind: 'new-session' }
>['scope'];

export interface NewSessionScreenshotDraftAttachment {
  id: string;
  name: string;
  mime: 'image/png';
  size: number;
}

export const NEW_SESSION_DRAFT_KEY_PREFIX = 'gian.new-session.draft.v2';
export const NEW_SESSION_SCREENSHOT_EVENT = 'gian:new-session-screenshot';

export function newSessionDraftStorageKey(scope: NewSessionScreenshotScope): string {
  return `${NEW_SESSION_DRAFT_KEY_PREFIX}.${scope.kind}.${encodeURIComponent(scope.id)}`;
}

function scopeKey(scope: NewSessionScreenshotScope): string {
  return `${scope.kind}:${scope.id}`;
}

function blobKey(scope: NewSessionScreenshotScope, id: string): string {
  return `${scopeKey(scope)}:${id}`;
}

function sameScope(a: NewSessionScreenshotScope, b: NewSessionScreenshotScope): boolean {
  return a.kind === b.kind && a.id === b.id;
}

function readDraftRecord(scope: NewSessionScreenshotScope): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(newSessionDraftStorageKey(scope));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function draftAttachments(record: Record<string, unknown>): NewSessionScreenshotDraftAttachment[] {
  if (!Array.isArray(record['screenshotAttachments'])) return [];
  return record['screenshotAttachments'].filter((item): item is NewSessionScreenshotDraftAttachment => {
    if (!item || typeof item !== 'object') return false;
    const candidate = item as Partial<NewSessionScreenshotDraftAttachment>;
    return typeof candidate.id === 'string'
      && typeof candidate.name === 'string'
      && candidate.mime === 'image/png'
      && typeof candidate.size === 'number';
  });
}

function writeDraftAttachments(
  scope: NewSessionScreenshotScope,
  attachments: NewSessionScreenshotDraftAttachment[],
): void {
  try {
    const record = readDraftRecord(scope);
    if (attachments.length > 0) record['screenshotAttachments'] = attachments;
    else delete record['screenshotAttachments'];
    localStorage.setItem(newSessionDraftStorageKey(scope), JSON.stringify(record));
  } catch {
    // Draft persistence is best-effort when browser storage is unavailable.
  }
}

const memoryBlobs = new Map<string, Blob>();
const DB_NAME = 'gian-screenshot-drafts-v1';
const DB_VERSION = 1;
const BLOB_STORE = 'blobs';

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise(resolve => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BLOB_STORE)) db.createObjectStore(BLOB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

async function putBlob(key: string, blob: Blob): Promise<void> {
  memoryBlobs.set(key, blob);
  const db = await openDb();
  if (!db) return;
  await new Promise<void>(resolve => {
    const tx = db.transaction(BLOB_STORE, 'readwrite');
    tx.objectStore(BLOB_STORE).put(blob, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
  db.close();
}

async function getBlob(key: string): Promise<Blob | null> {
  const memory = memoryBlobs.get(key);
  if (memory) return memory;
  const db = await openDb();
  if (!db) return null;
  const value = await new Promise<unknown>(resolve => {
    const tx = db.transaction(BLOB_STORE, 'readonly');
    const request = tx.objectStore(BLOB_STORE).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
  db.close();
  return value instanceof Blob ? value : null;
}

async function deleteBlob(key: string): Promise<void> {
  memoryBlobs.delete(key);
  const db = await openDb();
  if (!db) return;
  await new Promise<void>(resolve => {
    const tx = db.transaction(BLOB_STORE, 'readwrite');
    tx.objectStore(BLOB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
  db.close();
}

export function readNewSessionScreenshotAttachments(
  scope: NewSessionScreenshotScope,
): NewSessionScreenshotDraftAttachment[] {
  return draftAttachments(readDraftRecord(scope));
}

export async function storeNewSessionScreenshot(
  scope: NewSessionScreenshotScope,
  capture: GianScreenshotCapture,
): Promise<NewSessionScreenshotDraftAttachment> {
  const bytes = new Uint8Array(capture.bytes);
  const blob = new Blob([bytes.slice().buffer], { type: capture.mime });
  const attachment: NewSessionScreenshotDraftAttachment = {
    id: capture.id,
    name: capture.filename,
    mime: capture.mime,
    size: blob.size,
  };
  await putBlob(blobKey(scope, attachment.id), blob);
  const existing = readNewSessionScreenshotAttachments(scope);
  const next = [
    ...existing.filter(item => item.id !== attachment.id),
    attachment,
  ];
  writeDraftAttachments(scope, next);
  try {
    window.dispatchEvent(new CustomEvent(NEW_SESSION_SCREENSHOT_EVENT, {
      detail: { scope, attachments: next },
    }));
  } catch {
    // The durable draft is enough for the next mount in non-DOM contexts.
  }
  return attachment;
}

export function loadNewSessionScreenshotBlob(
  scope: NewSessionScreenshotScope,
  id: string,
): Promise<Blob | null> {
  return getBlob(blobKey(scope, id));
}

export async function removeNewSessionScreenshot(
  scope: NewSessionScreenshotScope,
  id: string,
): Promise<void> {
  const next = readNewSessionScreenshotAttachments(scope).filter(item => item.id !== id);
  writeDraftAttachments(scope, next);
  await deleteBlob(blobKey(scope, id));
}

export function clearNewSessionDraftStorage(scope: NewSessionScreenshotScope): void {
  const attachments = readNewSessionScreenshotAttachments(scope);
  try { localStorage.removeItem(newSessionDraftStorageKey(scope)); } catch { /* best-effort */ }
  for (const attachment of attachments) {
    void deleteBlob(blobKey(scope, attachment.id));
  }
}

export function screenshotEventMatchesScope(
  detail: unknown,
  scope: NewSessionScreenshotScope,
): detail is {
  scope: NewSessionScreenshotScope;
  attachments: NewSessionScreenshotDraftAttachment[];
} {
  if (!detail || typeof detail !== 'object') return false;
  const candidate = detail as {
    scope?: NewSessionScreenshotScope;
    attachments?: NewSessionScreenshotDraftAttachment[];
  };
  return !!candidate.scope
    && sameScope(candidate.scope, scope)
    && Array.isArray(candidate.attachments);
}
