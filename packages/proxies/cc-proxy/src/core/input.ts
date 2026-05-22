import { resolve } from 'node:path';
import { createAppError } from './errors.js';
import type { InputItem } from './types.js';

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

    throw createAppError(400, 'INVALID_REQUEST', `Unsupported input item type "${String(record.type)}".`);
  });
}
