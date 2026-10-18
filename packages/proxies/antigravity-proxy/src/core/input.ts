import type { ContentBlock } from '@agentclientprotocol/sdk';

import { AntigravityProxyError, type AntigravityErrorDetails } from './errors.js';

const ATTACHMENT_KEYS = [
  'data',
  'mime',
  'mimeType',
  'path',
  'resource',
  'size',
  'source',
  'uri',
] as const;

/**
 * Text-only prompt normalization. Non-text blocks and attachment fields are
 * rejected so an image, audio clip, file, or skill is not dropped silently.
 * A second pass over the returned blocks is stable.
 */
export function normalizeInputItems(raw: unknown): ContentBlock[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw inputError(
      'CONFIG_VALUE_INVALID',
      'Prompt input must be a non-empty array of text blocks.',
    );
  }
  return raw.map((entry, index) => normalizeEntry(entry, index));
}

function normalizeEntry(entry: unknown, index: number): ContentBlock {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw inputError(
      'CONFIG_VALUE_INVALID',
      `Prompt input at index ${index} must be an object.`,
      { index: String(index) },
    );
  }
  const record = entry as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : '';
  if (type !== 'text') {
    throw inputError(
      'CAPABILITY_NOT_SUPPORTED',
      `Non-text prompt input "${type || 'unknown'}" is not supported. The attachment was not dropped.`,
      { index: String(index), type: type || 'unknown' },
    );
  }
  const attachment = ATTACHMENT_KEYS.find((key) => record[key] !== undefined);
  if (attachment) {
    throw inputError(
      'CAPABILITY_NOT_SUPPORTED',
      `Text prompt input at index ${index} also carries "${attachment}". Mixed attachments are rejected.`,
      { index: String(index), type: attachment },
    );
  }
  if (typeof record.text !== 'string' || record.text.trim().length === 0) {
    throw inputError(
      'CONFIG_VALUE_INVALID',
      `Text prompt input at index ${index} must be a non-empty string.`,
      { index: String(index) },
    );
  }
  return { type: 'text', text: record.text };
}

function inputError(
  domainCode: 'CONFIG_VALUE_INVALID' | 'CAPABILITY_NOT_SUPPORTED',
  message: string,
  details?: AntigravityErrorDetails,
): AntigravityProxyError {
  return new AntigravityProxyError(domainCode, message, false, details);
}
