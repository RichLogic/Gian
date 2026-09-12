import { createHash } from 'node:crypto';

import { isProxyPluginId, type ProxyPluginId } from '@gian/shared';

import { MAX_PLUGIN_FILE_COUNT } from './limits.js';

const SHA256 = /^[0-9a-f]{64}$/;
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PLATFORM = /^(?:darwin|linux|win32)-(?:arm64|x64)$/;

export const PLUGIN_INSTALL_RECEIPT_FILE = 'install-receipt.json';
export const PLUGIN_INSTALL_RECEIPT_SCHEMA_VERSION = 1 as const;

export interface PluginReceiptFile {
  path: string;
  sha256: string;
  size: number;
}

export interface PluginInstallReceipt {
  schemaVersion: typeof PLUGIN_INSTALL_RECEIPT_SCHEMA_VERSION;
  sourceId: 'gian-official' | 'giandev';
  catalogSequence: number | null;
  pluginId: ProxyPluginId;
  pluginVersion: string;
  platform: string;
  manifestSha256: string;
  archiveSha256: string;
  negotiatedProtocol: string;
  processScope: 'shared' | 'session';
  installedAt: string;
  files: PluginReceiptFile[];
}

export type PluginReceiptParseResult =
  | { ok: true; receipt: PluginInstallReceipt }
  | { ok: false; error: string };

function isCanonicalPath(value: string): boolean {
  return value.length > 0
    && !value.startsWith('/')
    && !value.includes('\\')
    && !value.includes('\0')
    && !value.split('/').some((part) => part === '' || part === '.' || part === '..');
}

export function parsePluginInstallReceipt(value: unknown): PluginReceiptParseResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'PLUGIN_RECEIPT_INVALID' };
  }
  const record = value as Record<string, unknown>;
  const expected = [
    'schemaVersion',
    'sourceId',
    'catalogSequence',
    'pluginId',
    'pluginVersion',
    'platform',
    'manifestSha256',
    'archiveSha256',
    'negotiatedProtocol',
    'processScope',
    'installedAt',
    'files',
  ];
  if (Object.keys(record).length !== expected.length || expected.some((key) => !(key in record))) {
    return { ok: false, error: 'PLUGIN_RECEIPT_INVALID' };
  }
  if (record.schemaVersion !== PLUGIN_INSTALL_RECEIPT_SCHEMA_VERSION) {
    return { ok: false, error: 'PLUGIN_RECEIPT_INVALID' };
  }
  if (record.sourceId !== 'gian-official' && record.sourceId !== 'giandev') {
    return { ok: false, error: 'PLUGIN_RECEIPT_INVALID' };
  }
  if (record.catalogSequence !== null && (
    typeof record.catalogSequence !== 'number'
    || !Number.isSafeInteger(record.catalogSequence)
    || record.catalogSequence < 1
  )) {
    return { ok: false, error: 'PLUGIN_RECEIPT_INVALID' };
  }
  if (!isProxyPluginId(record.pluginId)) {
    return { ok: false, error: 'PLUGIN_RECEIPT_INVALID' };
  }
  if (typeof record.pluginVersion !== 'string' || !SEMVER.test(record.pluginVersion)) {
    return { ok: false, error: 'PLUGIN_RECEIPT_INVALID' };
  }
  if (typeof record.platform !== 'string' || !PLATFORM.test(record.platform)) {
    return { ok: false, error: 'PLUGIN_RECEIPT_INVALID' };
  }
  if (typeof record.manifestSha256 !== 'string' || !SHA256.test(record.manifestSha256)) {
    return { ok: false, error: 'PLUGIN_RECEIPT_INVALID' };
  }
  if (typeof record.archiveSha256 !== 'string' || !SHA256.test(record.archiveSha256)) {
    return { ok: false, error: 'PLUGIN_RECEIPT_INVALID' };
  }
  if (
    typeof record.negotiatedProtocol !== 'string'
    || record.negotiatedProtocol.length === 0
    || record.negotiatedProtocol.length > 32
    || /[\u0000-\u001f\u007f]/.test(record.negotiatedProtocol)
  ) {
    return { ok: false, error: 'PLUGIN_RECEIPT_INVALID' };
  }
  if (record.processScope !== 'shared' && record.processScope !== 'session') {
    return { ok: false, error: 'PLUGIN_RECEIPT_INVALID' };
  }
  if (typeof record.installedAt !== 'string' || Number.isNaN(Date.parse(record.installedAt))) {
    return { ok: false, error: 'PLUGIN_RECEIPT_INVALID' };
  }
  if (
    !Array.isArray(record.files)
    || record.files.length === 0
    || record.files.length > MAX_PLUGIN_FILE_COUNT
  ) {
    return { ok: false, error: 'PLUGIN_RECEIPT_INVALID' };
  }
  const files: PluginReceiptFile[] = [];
  const seen = new Set<string>();
  for (const item of record.files) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, error: 'PLUGIN_RECEIPT_INVALID' };
    }
    const file = item as Record<string, unknown>;
    if (
      typeof file.path !== 'string'
      || !isCanonicalPath(file.path)
      || typeof file.sha256 !== 'string'
      || !SHA256.test(file.sha256)
      || typeof file.size !== 'number'
      || !Number.isSafeInteger(file.size)
      || file.size < 1
    ) {
      return { ok: false, error: 'PLUGIN_RECEIPT_INVALID' };
    }
    if (seen.has(file.path)) return { ok: false, error: 'PLUGIN_RECEIPT_INVALID' };
    seen.add(file.path);
    files.push({ path: file.path, sha256: file.sha256, size: file.size });
  }
  return {
    ok: true,
    receipt: {
      schemaVersion: 1,
      sourceId: record.sourceId,
      catalogSequence: record.catalogSequence,
      pluginId: record.pluginId,
      pluginVersion: record.pluginVersion,
      platform: record.platform,
      manifestSha256: record.manifestSha256,
      archiveSha256: record.archiveSha256,
      negotiatedProtocol: record.negotiatedProtocol,
      processScope: record.processScope,
      installedAt: record.installedAt,
      files,
    },
  };
}

export function receiptFileInventory(files: Map<string, Buffer>): PluginReceiptFile[] {
  return [...files.entries()]
    .filter(([path]) => path !== PLUGIN_INSTALL_RECEIPT_FILE)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, bytes]) => ({
      path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.byteLength,
    }));
}

export function inventoriesEqual(
  left: readonly PluginReceiptFile[],
  right: readonly PluginReceiptFile[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((file, index) => {
    const other = right[index];
    return other !== undefined
      && file.path === other.path
      && file.sha256 === other.sha256
      && file.size === other.size;
  });
}
