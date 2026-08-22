import { describe, expect, it } from 'vitest';
import { sessionNeedsAttention } from '../src/session-routing.js';

describe('sessionNeedsAttention', () => {
  it('is true while the session is pending', () => {
    expect(sessionNeedsAttention({ status: 'pending', unread: 0 })).toBe(true);
  });

  it('is true for unread done or error turns', () => {
    expect(sessionNeedsAttention({ status: 'done', unread: 1 })).toBe(true);
    expect(sessionNeedsAttention({ status: 'error', unread: 1 })).toBe(true);
  });

  it('is false for read completions and in-flight running turns', () => {
    expect(sessionNeedsAttention({ status: 'done', unread: 0 })).toBe(false);
    expect(sessionNeedsAttention({ status: 'running', unread: 1 })).toBe(false);
    expect(sessionNeedsAttention({ status: 'new', unread: 1 })).toBe(false);
  });
});
