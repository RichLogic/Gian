/**
 * Message fold for one canonical turn. Mirrors the web transcript reducer
 * for user text and assistant `display.type === 'message'` only.
 * Reasoning, tools, commands, and drafts are not searchable messages.
 */

import type { ComposerDocument, EventEnvelope } from '@gian/shared';
import {
  GIAN_ACTION_CLOSE,
  normalizeComposerDocument,
  projectComposerSearchText,
  projectSearchText,
  stripGianActionBlocks,
  stripGianRolePrefix,
} from '@gian/shared';

export interface FoldedMessage {
  messageId: string;
  messageKind: 'user' | 'assistant';
  turn: number;
  text: string;
  /** Set when the user message stored a composer document. Legacy text stays in `text`. */
  document?: ComposerDocument;
  position: number;
  /** Canonical event time. Session access time does not move old body text. */
  updatedAt: string;
}

/** Index and context revision share this projection. */
export function foldedSearchText(message: Pick<FoldedMessage, 'text' | 'document'>): string {
  return message.document ? projectComposerSearchText(message.document) : projectSearchText(message.text);
}

const ATTACHED_IMAGE_RE = /\[Attached image:\s*([^\]]+?)\s*\]/g;
const IMAGE_EXT_MIME = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'heic']);

export function foldTurnMessages(events: readonly EventEnvelope[]): FoldedMessage[] {
  const rows = new Map<string, FoldedMessage>();
  const order: string[] = [];
  for (const event of events) {
    if (event.event === 'user_message') {
      const text = stripGianRolePrefix(recoverInlineImages(event.data));
      const document = composerDocument(event.data);
      replace(rows, order, `${event.turn}:user:${event.call_id}`, 'user', event.turn, text, event.ts, document);
      continue;
    }
    if (event.display?.type !== 'message') continue;
    const data = event.display.data as unknown as Record<string, unknown>;
    if (data.role === 'user') continue;
    const itemId = String(data.itemId ?? event.call_id);
    const chunk = String(
      data.delta === true
        ? data.text
        : typeof data.delta === 'string'
          ? data.delta
          : (data.text ?? ''),
    );
    if (!chunk) continue;
    const replaceText = data.delta === false;
    append(rows, order, `${event.turn}:assistant:${itemId}`, 'assistant', event.turn, chunk, replaceText, event.ts);
  }
  return order.map(id => rows.get(id)!);
}

function eventTime(ts: number): string {
  return new Date(Number.isFinite(ts) ? ts : 0).toISOString();
}

function composerDocument(data: unknown): ComposerDocument | undefined {
  if (!data || typeof data !== 'object') return undefined;
  return normalizeComposerDocument((data as { composer_document?: unknown }).composer_document) ?? undefined;
}

function replace(
  rows: Map<string, FoldedMessage>,
  order: string[],
  messageId: string,
  messageKind: FoldedMessage['messageKind'],
  turn: number,
  text: string,
  ts: number,
  document?: ComposerDocument,
): void {
  const updatedAt = eventTime(ts);
  const existing = rows.get(messageId);
  if (existing) {
    existing.text = text;
    existing.document = document;
    existing.updatedAt = updatedAt;
    return;
  }
  rows.set(messageId, {
    messageId,
    messageKind,
    turn,
    text,
    ...(document ? { document } : {}),
    position: order.length,
    updatedAt,
  });
  order.push(messageId);
}

function append(
  rows: Map<string, FoldedMessage>,
  order: string[],
  messageId: string,
  messageKind: FoldedMessage['messageKind'],
  turn: number,
  chunk: string,
  replaceText: boolean,
  ts: number,
): void {
  const existing = rows.get(messageId);
  const next = replaceText || !existing ? chunk : existing.text + chunk;
  const text = next.includes(GIAN_ACTION_CLOSE) ? stripGianActionBlocks(next) : next;
  const updatedAt = eventTime(ts);
  if (existing) {
    existing.text = text;
    existing.updatedAt = updatedAt;
    return;
  }
  rows.set(messageId, { messageId, messageKind, turn, text, position: order.length, updatedAt });
  order.push(messageId);
}

function recoverInlineImages(data: Record<string, unknown>): string {
  let text = String(data.text ?? '');
  const attachments = Array.isArray(data.attachments) ? data.attachments : [];
  if (attachments.length > 0) return text;
  text = text.replace(ATTACHED_IMAGE_RE, (whole, rawPath: string) => {
    const match = /\/attachments\/([^/]+)\/([^/?#]+)$/.exec(String(rawPath).trim());
    const filename = match?.[2];
    if (!filename) return whole;
    const extension = filename.toLowerCase().split('.').pop() ?? '';
    return IMAGE_EXT_MIME.has(extension) ? '' : whole;
  });
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
