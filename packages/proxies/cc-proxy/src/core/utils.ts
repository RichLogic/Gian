import { randomUUID } from 'node:crypto';

export function randomId(prefix: string) {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

export function nowIso() {
  return new Date().toISOString();
}
