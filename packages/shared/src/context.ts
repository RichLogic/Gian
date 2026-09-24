import type { GianBrowserElementCapture } from './browser-context.js';

export const MAX_MESSAGE_CONTEXT_ITEMS = 16;
export const MAX_PASTED_TEXT_BYTES = 64 * 1024;
export const MAX_COMPOSER_DOCUMENT_SEGMENTS = 256;
export const MAX_COMPOSER_DOCUMENT_TEXT_BYTES = 256 * 1024;
export const MAX_COMPOSER_REFERENCE_LABEL_CHARS = 200;

export interface ComposerTextSegment {
  type: 'text';
  text: string;
}

export interface ComposerReferenceSegment {
  type: 'reference';
  id: string;
  referenceType: 'attachment' | 'context';
  label: string;
  /** Optional chip discriminator. 'file' marks a working-tree file reference
   *  and 'session' a referenced Gian conversation, so renderers can show a
   *  dedicated glyph instead of the generic '@' mention. */
  kind?: 'file' | 'session';
}

export interface ComposerDocument {
  version: 1;
  segments: Array<ComposerTextSegment | ComposerReferenceSegment>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeReferenceKind(value: unknown): 'file' | 'session' | undefined {
  return value === 'file' || value === 'session' ? value : undefined;
}

/** Closed, bounded message-document parser shared by Web and Host. */
export function normalizeComposerDocument(value: unknown): ComposerDocument | null {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.segments)) return null;
  if (value.segments.length > MAX_COMPOSER_DOCUMENT_SEGMENTS) return null;
  const segments: ComposerDocument['segments'] = [];
  const referencesById = new Map<string, { referenceType: ComposerReferenceSegment['referenceType']; label: string; kind?: 'file' | 'session' }>();
  let textBytes = 0;
  for (const raw of value.segments) {
    if (!isRecord(raw) || typeof raw.type !== 'string') return null;
    if (raw.type === 'text') {
      if (typeof raw.text !== 'string') return null;
      textBytes += new TextEncoder().encode(raw.text).byteLength;
      if (textBytes > MAX_COMPOSER_DOCUMENT_TEXT_BYTES) return null;
      if (!raw.text) continue;
      const previous = segments[segments.length - 1];
      if (previous?.type === 'text') previous.text += raw.text;
      else segments.push({ type: 'text', text: raw.text });
      continue;
    }
    if (
      raw.type !== 'reference'
      || typeof raw.id !== 'string'
      || raw.id.length === 0
      || raw.id.length > 128
      || (raw.referenceType !== 'attachment' && raw.referenceType !== 'context')
      || typeof raw.label !== 'string'
      || (raw.kind !== undefined && raw.kind !== 'file' && raw.kind !== 'session')
    ) return null;
    const label = raw.label.replace(/\s+/g, ' ').trim().slice(0, MAX_COMPOSER_REFERENCE_LABEL_CHARS);
    if (!label) return null;
    const kind = normalizeReferenceKind(raw.kind);
    const existing = referencesById.get(raw.id);
    if (existing && (existing.referenceType !== raw.referenceType || existing.label !== label || existing.kind !== kind)) return null;
    referencesById.set(raw.id, { referenceType: raw.referenceType, label, ...(kind ? { kind } : {}) });
    segments.push({
      type: 'reference',
      id: raw.id,
      referenceType: raw.referenceType,
      label,
      ...(kind ? { kind } : {}),
    });
  }
  return { version: 1, segments };
}

/** Plain fallback used by old renderers and operation correlation. */
export function composerDocumentPlainText(document: ComposerDocument): string {
  return document.segments.map(segment => (
    segment.type === 'text' ? segment.text : `"${segment.label}"`
  )).join('');
}

/** User-authored text only, used for slash filtering and empty-state logic. */
export function composerDocumentUserText(document: ComposerDocument): string {
  return document.segments.flatMap(segment => segment.type === 'text' ? [segment.text] : []).join('');
}

/**
 * Per-message attachment numbering: every attachment reference is numbered
 * 1-based in document order (first appearance per id), counting ALL
 * attachment references — images and files alike. This is exactly the N the
 * Host's compile emits as `[Attached resource N: "label"]`, so UI labels and
 * badges derive from it instead of inventing a second numbering.
 */
export function attachmentReferenceNumbers(document: ComposerDocument): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const segment of document.segments) {
    if (segment.type !== 'reference' || segment.referenceType !== 'attachment') continue;
    if (!numbers.has(segment.id)) numbers.set(segment.id, numbers.size + 1);
  }
  return numbers;
}

/**
 * Send-time label rewrite: image attachment references display as `image<N>`
 * (N from `attachmentReferenceNumbers`) so the chip the user reads matches
 * the `[Attached resource N]` marker in the compiled prompt. Non-image
 * attachments keep their labels. Pure: returns the input unchanged (same
 * reference) when no image reference is present.
 */
export function numberImageAttachmentLabels(
  document: ComposerDocument,
  isImage: (referenceId: string) => boolean,
): ComposerDocument {
  const numbers = attachmentReferenceNumbers(document);
  let changed = false;
  const segments = document.segments.map(segment => {
    if (segment.type !== 'reference' || segment.referenceType !== 'attachment') return segment;
    const n = numbers.get(segment.id);
    if (n === undefined || !isImage(segment.id)) return segment;
    const label = `image${n}`;
    if (segment.label === label) return segment;
    changed = true;
    return { ...segment, label };
  });
  return changed ? { ...document, segments } : document;
}

interface MessageContextItemBase {
  id: string;
}

/** Immutable clipboard text captured separately from the editable prompt. */
export interface PastedTextContextItem extends MessageContextItemBase {
  type: 'pastedText';
  text: string;
  lineCount: number;
  byteSize: number;
  /** 'selection' = quoted from a transcript text selection (renders as
   *  "引用"/Quote rather than "Pasted text"); undefined = clipboard paste. */
  origin?: 'selection';
}

/** Live local-directory reference. The directory contents are never embedded. */
export interface FolderContextItem extends MessageContextItemBase {
  type: 'folder';
  path: string;
  name: string;
}

/** Live working-tree file reference. Unlike `folder`, the Host confines the
 *  resolved real path to the session's working tree and inlines the file's
 *  UTF-8 text content into the compiled prompt (bounded; see the Host's
 *  compile caps). A file that vanishes before compile degrades to a
 *  path-only note. */
export interface FileContextItem extends MessageContextItemBase {
  type: 'file';
  path: string;
  name: string;
}

/** A user-selected, Desktop-sanitized element from Gian's native Browser. */
export interface BrowserElementContextItem extends MessageContextItemBase, GianBrowserElementCapture {
  type: 'browserElement';
}

/** Reference to another Gian session's conversation. The transcript is never
 *  embedded by the client; at send time the Host resolves the session and
 *  inlines a bounded slice of its user/assistant text turns into the compiled
 *  prompt (see the Host's session compile caps). A session that was deleted
 *  before compile degrades to a note — it never fails the send. */
export interface SessionContextItem extends MessageContextItemBase {
  type: 'session';
  sessionId: string;
  title: string;
  /** Display-only workspace label captured when the chip was picked. */
  workspaceName?: string;
}

export type MessageContextItem = PastedTextContextItem | FolderContextItem | FileContextItem | BrowserElementContextItem | SessionContextItem;

export interface PickedFileResource {
  type: 'file';
  name: string;
  mime: string;
  size: number;
  data: Uint8Array;
}

export interface PickedFolderResource {
  type: 'folder';
  name: string;
  path: string;
}

export type PickedComposerResource = PickedFileResource | PickedFolderResource;

export interface PickComposerResourcesResult {
  resources: PickedComposerResource[];
  /** Names of selected files that exceeded the attachment cap or could not
   *  be read after the user confirmed the native panel. */
  rejectedFiles: string[];
}

export interface GianResourcePickerApi {
  pick: () => Promise<PickComposerResourcesResult | null>;
}
