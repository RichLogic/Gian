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
}

export interface ComposerDocument {
  version: 1;
  segments: Array<ComposerTextSegment | ComposerReferenceSegment>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Closed, bounded message-document parser shared by Web and Host. */
export function normalizeComposerDocument(value: unknown): ComposerDocument | null {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.segments)) return null;
  if (value.segments.length > MAX_COMPOSER_DOCUMENT_SEGMENTS) return null;
  const segments: ComposerDocument['segments'] = [];
  const referencesById = new Map<string, { referenceType: ComposerReferenceSegment['referenceType']; label: string }>();
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
    ) return null;
    const label = raw.label.replace(/\s+/g, ' ').trim().slice(0, MAX_COMPOSER_REFERENCE_LABEL_CHARS);
    if (!label) return null;
    const existing = referencesById.get(raw.id);
    if (existing && (existing.referenceType !== raw.referenceType || existing.label !== label)) return null;
    referencesById.set(raw.id, { referenceType: raw.referenceType, label });
    segments.push({
      type: 'reference',
      id: raw.id,
      referenceType: raw.referenceType,
      label,
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

/** A user-selected, Desktop-sanitized element from Gian's native Browser. */
export interface BrowserElementContextItem extends MessageContextItemBase, GianBrowserElementCapture {
  type: 'browserElement';
}

export type MessageContextItem = PastedTextContextItem | FolderContextItem | BrowserElementContextItem;

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
