import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ContentBlock } from '@agentclientprotocol/sdk';

import { createAppError } from './errors.js';
import type { InputItem } from './types.js';

const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export function normalizeInputItems(input: unknown, cwd: string): InputItem[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw createAppError(400, 'INVALID_REQUEST', 'input must be a non-empty array.');
  }

  return input.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      throw createAppError(400, 'INVALID_REQUEST', 'Each input item must be an object.');
    }

    const record = entry as Record<string, unknown>;
    if (record.type === 'text') {
      const text = typeof record.text === 'string' ? record.text : '';
      if (!text.trim()) {
        throw createAppError(400, 'INVALID_REQUEST', 'text input items require non-empty text.');
      }
      return { type: 'text', text };
    }

    if (record.type === 'localImage') {
      const path = typeof record.path === 'string' ? record.path.trim() : '';
      if (!path) {
        throw createAppError(400, 'INVALID_REQUEST', 'localImage items require a path.');
      }
      const mimeType = typeof record.mimeType === 'string' && record.mimeType.startsWith('image/')
        ? record.mimeType
        : undefined;
      return {
        type: 'localImage',
        path: resolve(cwd, path),
        ...(mimeType ? { mimeType } : {}),
      };
    }

    if (record.type === 'localFile') {
      const path = typeof record.path === 'string' ? record.path.trim() : '';
      if (!path) {
        throw createAppError(400, 'INVALID_REQUEST', 'localFile items require a path.');
      }
      const name = typeof record.name === 'string' && record.name.trim()
        ? record.name.trim()
        : undefined;
      const mimeType = typeof record.mime === 'string' && record.mime.trim()
        ? record.mime.trim()
        : undefined;
      const size = typeof record.size === 'number' && Number.isFinite(record.size) && record.size >= 0
        ? record.size
        : undefined;
      return {
        type: 'localFile',
        path: resolve(cwd, path),
        ...(name ? { name } : {}),
        ...(mimeType ? { mimeType } : {}),
        ...(size !== undefined ? { size } : {}),
      };
    }

    throw createAppError(
      400,
      'INVALID_REQUEST',
      `Unsupported input item type "${String(record.type)}".`,
    );
  });
}

export async function toPromptBlocks(input: InputItem[]): Promise<ContentBlock[]> {
  return Promise.all(input.map(async (item): Promise<ContentBlock> => {
    if (item.type === 'text') {
      return { type: 'text', text: item.text };
    }

    if (item.type === 'localFile') {
      return {
        type: 'resource_link',
        uri: pathToFileURL(item.path).href,
        name: item.name ?? item.path.split(/[\\/]/).pop() ?? 'attachment',
        ...(item.mimeType ? { mimeType: item.mimeType } : {}),
        ...(item.size !== undefined ? { size: item.size } : {}),
      };
    }

    const mimeType = item.mimeType
      ?? IMAGE_MIME_BY_EXTENSION[extname(item.path).toLowerCase()];
    if (!mimeType) {
      throw createAppError(
        400,
        'INVALID_IMAGE_TYPE',
        `Cannot infer an image MIME type for ${item.path}.`,
      );
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(item.path);
    } catch (error) {
      throw createAppError(
        400,
        'IMAGE_READ_FAILED',
        `Could not read local image ${item.path}: ${String(error)}`,
      );
    }

    return {
      type: 'image',
      data: bytes.toString('base64'),
      mimeType,
    };
  }));
}
