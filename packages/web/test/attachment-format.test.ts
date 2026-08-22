import { describe, expect, it } from 'vitest';
import { fmtBytes, isNativeImageMime, servedAttachmentUrl } from '../src/attachments.js';

describe('isNativeImageMime', () => {
  it('accepts the four native image types and rejects others', () => {
    expect(isNativeImageMime('image/png')).toBe(true);
    expect(isNativeImageMime('image/jpeg')).toBe(true);
    expect(isNativeImageMime('image/gif')).toBe(true);
    expect(isNativeImageMime('image/webp')).toBe(true);
    expect(isNativeImageMime('image/svg+xml')).toBe(false);
    expect(isNativeImageMime('application/pdf')).toBe(false);
  });
});

describe('fmtBytes', () => {
  it('formats bytes, kilobytes, and megabytes', () => {
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(1536)).toBe('1.5 KB');
    expect(fmtBytes(2 * 1024 * 1024)).toBe('2.0 MB');
  });
});

describe('servedAttachmentUrl', () => {
  it('uses the basename and encodes session id and filename', () => {
    expect(servedAttachmentUrl('s 1', '/tmp/store/my file.png'))
      .toBe('/api/sessions/s%201/attachments/my%20file.png');
  });
});
