import { describe, expect, it } from 'vitest';
import { formatElapsed } from '../src/transcript/items.js';
import { formatTime } from '../src/utils/format.js';
import { relTime, statusGlyphShown } from '../src/views/session-list-status.js';

describe('formatElapsed', () => {
  it('uses seconds under a minute and mm ss after', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(8_000)).toBe('8s');
    expect(formatElapsed(63_000)).toBe('1m 03s');
    expect(formatElapsed(-50)).toBe('0s');
  });
});

describe('formatTime', () => {
  it('returns HH:MM from a timestamp', () => {
    const ts = Date.parse('2026-08-20T15:04:00');
    expect(formatTime(ts)).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe('relTime', () => {
  it('returns now for the current instant and empty for invalid input', () => {
    expect(relTime(new Date().toISOString())).toBe('now');
    expect(relTime('not-a-date')).toBe('');
  });

  it('uses minute/hour buckets', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    expect(relTime(twoHoursAgo)).toBe('2h');
  });
});

describe('statusGlyphShown', () => {
  it('shows running/pending/error always and done only when unread', () => {
    expect(statusGlyphShown('running', false)).toBe(true);
    expect(statusGlyphShown('pending', false)).toBe(true);
    expect(statusGlyphShown('error', false)).toBe(true);
    expect(statusGlyphShown('done', true)).toBe(true);
    expect(statusGlyphShown('done', false)).toBe(false);
    expect(statusGlyphShown('new', true)).toBe(false);
  });
});
