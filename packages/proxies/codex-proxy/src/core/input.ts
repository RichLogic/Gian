import { basename, dirname, resolve } from 'node:path';

import { createAppError } from './errors.js';
import type { InputItem } from './types.js';

export function localFileDirectories(input: unknown, cwd: string): string[] {
  if (!Array.isArray(input)) return [];
  const dirs = input.flatMap(entry => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    if (record.type !== 'localFile' || typeof record.path !== 'string' || !record.path.trim()) return [];
    return [dirname(resolve(cwd, record.path.trim()))];
  });
  return [...new Set(dirs)];
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
      return { type: 'text', text } satisfies InputItem;
    }

    if (record.type === 'localImage') {
      const path = typeof record.path === 'string' ? record.path.trim() : '';
      if (!path) {
        throw createAppError(400, 'INVALID_REQUEST', 'localImage items require a path.');
      }
      return {
        type: 'localImage',
        path: resolve(cwd, path),
      } satisfies InputItem;
    }

    if (record.type === 'localFile') {
      const path = typeof record.path === 'string' ? record.path.trim() : '';
      if (!path) {
        throw createAppError(400, 'INVALID_REQUEST', 'localFile items require a path.');
      }
      const absolutePath = resolve(cwd, path);
      const name = typeof record.name === 'string' && record.name.trim()
        ? record.name.trim()
        : basename(absolutePath);
      return {
        type: 'text',
        text: `[Attached file: ${absolutePath} (${name})]`,
      } satisfies InputItem;
    }

    if (record.type === 'skill') {
      const name = typeof record.name === 'string' ? record.name.trim() : '';
      const path = typeof record.path === 'string' ? record.path.trim() : '';
      if (!name) {
        throw createAppError(400, 'INVALID_REQUEST', 'skill items require a name.');
      }
      if (!path) {
        throw createAppError(400, 'INVALID_REQUEST', 'skill items require a path.');
      }
      return { type: 'skill', name, path } satisfies InputItem;
    }

    throw createAppError(400, 'INVALID_REQUEST', `Unsupported input item type "${String(record.type)}".`);
  });
}
