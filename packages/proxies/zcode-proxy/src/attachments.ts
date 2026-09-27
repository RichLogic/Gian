/**
 * Local attachment handling for ZCode 0.16.9.
 *
 * Upstream evidence (zai-org/ZCode @ 328c1a0c):
 * - The desktop client passes LOCAL files to `v4/command` `sendText` by
 *   referencing the absolute path directly:
 *   `attachmentRef = { ref: localPath, fileName, mime, bytes }`
 *   (packages/ui/src/v4/composer/useComposerAttachments.ts:643-668
 *   "local zero-copy"; apps/zcode-cli/.../commands/attachment-refs.ts:3-12
 *   documents the two legal ref forms: absolute local path or
 *   `zcode-artifact://` URI).
 * - `mapAttachmentRefsToTurnAttachments` (attachment-refs.ts:61-101) maps a
 *   local-path ref to a core TurnAttachment `{path, type: image|video|pdf|file
 *   by mime}`; unreadable refs keep display metadata and never fail the send.
 * - Limits: 20 MiB per attachment (`attachmentMaxBytes`,
 *   zcode-protocol-v4/core.ts:84); the wire upload transaction is only needed
 *   for REMOTE targets, not for the local app-server this proxy owns.
 * - Guide routing (turn steering) rejects attachments with
 *   `guide.attachmentsUnsupported` (session-flow.ts:259-261).
 *
 * Skill activation mirrors the upstream CLI `/skill` command, which rewrites
 * to a canonical prompt (packages/cli/src/command-center/slash-commands.ts:229
 * `buildManualSkillPrompt`) instructing the model to call the `Skill` tool.
 */

import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { basename, extname, isAbsolute } from 'node:path';

import { ServiceError } from './adapter.js';

/** Hard upstream per-attachment cap (`attachmentMaxBytes`). */
export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

/** Attachment chunk facts are upstream-fixed; the proxy keeps the bound for
 *  validation messages only (it never uploads: local zero-copy by path). */
export const ATTACHMENT_CHUNK_MAX_BYTES = 512 * 1024;

export interface InnerAttachmentRef {
  ref: string;
  fileName: string;
  mime: string;
  bytes: number;
}

/** Extension → MIME map mirrors upstream
 *  packages/ui/src/lib/chatAttachmentMetadata.ts:46-65
 *  (`inferAttachmentMimeType`). */
const MIME_BY_EXTENSION: Record<string, string> = {
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.pdf': 'application/pdf',
};

const IMAGE_MIME_PREFIX = 'image/';

export function inferMimeForPath(path: string): string {
  const ext = extname(path).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith(IMAGE_MIME_PREFIX);
}

export interface ValidatedAttachment {
  ref: InnerAttachmentRef;
  kind: 'image' | 'video' | 'pdf' | 'file';
}

/** Validate one outer localImage/localFile input item and build the exact
 *  upstream AttachmentRef for `sendText`. Every rejection happens BEFORE any
 *  turn starts, so there is nothing to roll back (no staged upload exists on
 *  the local zero-copy path). */
export function validateLocalAttachment(item: {
  type: string;
  path: string;
  name?: string;
  mime?: string;
  size?: number;
}): ValidatedAttachment {
  const rawPath = item.path;
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new ServiceError('INVALID_PARAMS', `${item.type}.path must be a non-empty string.`);
  }
  if (rawPath.includes('\u0000') || rawPath.split('/').includes('..')) {
    throw new ServiceError('INVALID_PARAMS', `${item.type}.path must be a direct absolute path.`);
  }
  const absolute = isAbsolute(rawPath) ? rawPath : '' ;
  if (absolute === '') {
    throw new ServiceError('INVALID_PARAMS', `${item.type}.path must be an absolute Host path.`);
  }
  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    throw new ServiceError(
      'INVALID_PARAMS',
      `${item.type} file is not readable on the Host: ${absolute}`,
    );
  }
  if (stats.isFile() === false) {
    throw new ServiceError('INVALID_PARAMS', `${item.type} path is not a regular file: ${absolute}`);
  }
  if (stats.size > ATTACHMENT_MAX_BYTES) {
    throw new ServiceError(
      'INVALID_PARAMS',
      `${item.type} exceeds the 20MiB ZCode attachment limit (${stats.size} bytes).`,
    );
  }
  const mime = typeof item.mime === 'string' && item.mime.includes('/')
    ? item.mime
    : inferMimeForPath(absolute);
  if (item.type === 'localImage' && isImageMime(mime) === false) {
    throw new ServiceError(
      'CONFIG_VALUE_INVALID',
      `localImage requires an image/* MIME type; inferred "${mime}" for ${absolute}.`,
    );
  }
  const kind: ValidatedAttachment['kind'] = isImageMime(mime)
    ? 'image'
    : mime.startsWith('video/')
      ? 'video'
      : mime === 'application/pdf'
        ? 'pdf'
        : 'file';
  return {
    ref: {
      ref: absolute,
      fileName: typeof item.name === 'string' && item.name !== '' ? item.name : basename(absolute),
      mime,
      bytes: typeof item.size === 'number' ? item.size : stats.size,
    },
    kind,
  };
}

/** Deterministic commandId for v4 commands (upstream retries keep the same
 *  commandId; the CLI command inbox dedups on it). */
export function commandIdFor(parts: unknown[]): string {
  return `gian:${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)}`;
}

/** Exact upstream `/skill` rewrite (buildManualSkillPrompt). */
export function buildManualSkillPrompt(skillName: string, task: string): string {
  const trimmedTask = task.trim();
  const taskBlock = trimmedTask.length > 0
    ? `User request:\n${trimmedTask}`
    : 'No additional user request was provided. Load the skill and respond according to its instructions.';
  return [
    `Use the skill named \`${skillName}\` for this turn.`,
    `First call the \`Skill\` tool with name \`${skillName}\` before doing the task.`,
    'After the skill content is loaded, follow its instructions and continue.',
    '',
    taskBlock,
  ].join('\n');
}
