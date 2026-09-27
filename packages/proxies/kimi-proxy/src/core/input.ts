/**
 * Outer gian input items → Kimi prompt content blocks.
 *
 * Upstream facts (kap-server OpenAPI 2.1.1):
 * - `image` parts carry a `source` union; `kind:"path"` references a LOCAL
 *   absolute path the server reads itself (no proxy-side base64 inline).
 * - `file` parts carry `{path?, name?, media_type?, size?}`.
 * - Prompt-level `skills: [{name, args?}]` is the native per-turn skill
 *   activation (the REST analogue of the `/<skill>` slash command).
 * Every rejection happens BEFORE the prompt is submitted, so there is no
 * rollback work.
 */

import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { KimiProtocolError } from '../transport/protocol.js';
import type { KimiContentPart, KimiMediaSource } from './types.js';

export interface OuterInputItem {
  type: string;
  text?: unknown;
  path?: unknown;
  name?: unknown;
  mime?: unknown;
  mimeType?: unknown;
  size?: unknown;
  args?: unknown;
  [key: string]: unknown;
}

export interface BuiltPromptInput {
  content: KimiContentPart[];
  skills: Array<{ name: string; args?: string }>;
}

function invalid(message: string): KimiProtocolError {
  return new KimiProtocolError('INVALID_PARAMS', message);
}

function requireLocalPath(item: OuterInputItem): string {
  const path = item.path;
  if (typeof path !== 'string' || path.length === 0) {
    throw invalid(`${item.type}.path must be a non-empty string.`);
  }
  if (!isAbsolute(path) || path.split('/').includes('..')) {
    throw invalid(`${item.type}.path must be a direct absolute path.`);
  }
  try {
    const stats = statSync(path);
    if (!stats.isFile()) throw new Error('not a regular file');
  } catch {
    throw invalid(`${item.type} file is not readable on the Host: ${path}`);
  }
  return path;
}

function mimeOf(item: OuterInputItem): string | undefined {
  const mime = item.mime ?? item.mimeType;
  return typeof mime === 'string' && mime.includes('/') ? mime : undefined;
}

/** Build the prompt payload pieces from outer input items. */
export function buildPromptInput(items: OuterInputItem[]): BuiltPromptInput {
  const content: KimiContentPart[] = [];
  const skills: Array<{ name: string; args?: string }> = [];
  for (const item of items) {
    switch (item.type) {
      case 'text': {
        if (typeof item.text !== 'string' || item.text.length === 0) {
          throw invalid('text input requires a non-empty text field.');
        }
        content.push({ type: 'text', text: item.text });
        continue;
      }
      case 'localImage': {
        const path = requireLocalPath(item);
        const source: KimiMediaSource = { kind: 'path', path };
        content.push({
          type: 'image',
          source,
          ...(typeof item.name === 'string' && item.name !== '' ? { name: item.name } : {}),
        });
        continue;
      }
      case 'localFile': {
        const path = requireLocalPath(item);
        const mediaType = mimeOf(item);
        content.push({
          type: 'file',
          path,
          ...(typeof item.name === 'string' && item.name !== '' ? { name: item.name } : {}),
          ...(mediaType !== undefined ? { media_type: mediaType } : {}),
        });
        continue;
      }
      case 'skill': {
        const name = item.name;
        if (typeof name !== 'string' || name.length === 0) {
          throw invalid('skill input requires a name.');
        }
        skills.push({
          name,
          ...(typeof item.args === 'string' && item.args !== '' ? { args: item.args } : {}),
        });
        continue;
      }
      default:
        throw invalid(`Unsupported input type for Kimi: ${item.type || 'unknown'}.`);
    }
  }
  if (content.length === 0 && skills.length === 0) {
    throw invalid('Turn input resolved to neither content nor skills.');
  }
  return { content, skills };
}
