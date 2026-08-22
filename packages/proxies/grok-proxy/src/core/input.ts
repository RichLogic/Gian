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

function inferImageMime(path: string, explicit?: string): string | undefined {
  if (explicit?.startsWith('image/')) return explicit;
  return IMAGE_MIME_BY_EXTENSION[extname(path).toLowerCase()];
}

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

    if (record.type === 'localImage' || record.type === 'localFile') {
      const path = typeof record.path === 'string' ? record.path.trim() : '';
      if (!path) {
        throw createAppError(400, 'INVALID_REQUEST', `${record.type} items require a path.`);
      }
      const name = typeof record.name === 'string' && record.name.trim()
        ? record.name.trim()
        : undefined;
      const rawMime = typeof record.mimeType === 'string' ? record.mimeType : record.mime;
      const mimeType = typeof rawMime === 'string' && rawMime.trim() ? rawMime.trim() : undefined;
      const size = typeof record.size === 'number' && Number.isFinite(record.size) && record.size >= 0
        ? record.size
        : undefined;
      const resolved = resolve(cwd, path);
      if (record.type === 'localImage') {
        const image: Extract<InputItem, { type: 'localImage' }> = { type: 'localImage', path: resolved };
        const inferred = inferImageMime(resolved, mimeType);
        if (inferred) image.mimeType = inferred;
        if (name) image.name = name;
        if (size !== undefined) image.size = size;
        return image;
      }
      return {
        type: 'localFile',
        path: resolved,
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
    if (item.type === 'text') return { type: 'text', text: item.text };
    const name = ('name' in item && item.name)
      ? item.name
      : item.path.split(/[\\/]/).pop() ?? 'attachment';
    if (item.type === 'localImage') {
      const mimeType = inferImageMime(item.path, item.mimeType);
      if (!mimeType) {
        throw createAppError(400, 'INVALID_IMAGE_TYPE', `Cannot infer an image MIME type for ${item.path}.`);
      }
      let bytes: Buffer;
      try {
        bytes = await readFile(item.path);
      } catch (error) {
        throw createAppError(400, 'IMAGE_READ_FAILED', `Could not read local image ${item.path}: ${String(error)}`);
      }
      return { type: 'image', data: bytes.toString('base64'), mimeType };
    }
    return {
      type: 'resource_link',
      uri: pathToFileURL(item.path).href,
      name,
      ...(item.mimeType ? { mimeType: item.mimeType } : {}),
      ...('size' in item && item.size !== undefined ? { size: item.size } : {}),
    };
  }));
}

export function firstText(input: InputItem[]): string {
  return input.find((item): item is Extract<InputItem, { type: 'text' }> => item.type === 'text')?.text ?? '';
}
