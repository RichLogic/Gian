import type { Executor, InputItem, MessageAttachment } from '@gian/shared';
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { mimeForAttachment, resolveAttachmentPath } from '../storage/attachments.js';

export function kimiContentText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const content = value as { type?: unknown; text?: unknown };
  return content.type === 'text' && typeof content.text === 'string'
    ? content.text
    : '';
}

export function translateItemsForExecutor(executor: Executor, items: InputItem[]): InputItem[] {
  if (executor === 'codex') return items;
  return items.map(item => item.type === 'skill'
    ? { type: 'text' as const, text: `/${item.name}` }
    : item);
}

export function buildAttachmentsFromItems(
  sessionId: string,
  items: InputItem[] | undefined,
): MessageAttachment[] {
  const attachments: MessageAttachment[] = [];
  for (const item of items ?? []) {
    if (item.type !== 'localImage' && item.type !== 'localFile') continue;
    const filename = basename(item.path);
    attachments.push({
      name: item.name ?? filename,
      mime: item.mime ?? mimeForAttachment(filename),
      url: `/api/sessions/${sessionId}/attachments/${filename}`,
      ...(typeof item.size === 'number' ? { size: item.size } : {}),
    });
  }
  return attachments;
}

export function assertLocalFilesBelongToSession(
  sessionId: string,
  items: InputItem[] | undefined,
): void {
  for (const item of items ?? []) {
    if (item.type !== 'localFile') continue;
    const expected = resolveAttachmentPath(sessionId, basename(item.path));
    if (!expected || resolve(item.path) !== expected || !existsSync(expected)) {
      throw new Error(`invalid local file attachment for session ${sessionId}`);
    }
  }
}
