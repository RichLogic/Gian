import { describe, it, expect } from 'vitest';
import { parseApprovalRequested } from '../src/transcript/apply.js';
import type { EventEnvelope } from '../src/types.js';

function envelope(overrides: Record<string, unknown> = {}): EventEnvelope {
  return {
    ts: Date.UTC(2026, 4, 17, 10, 0, 0),
    call_id: 'envelope-1',
    session_id: 'session-1',
    turn: 'turn-1',
    event: 'interaction.approval',
    data: {
      approvalId: 'appr-1',
      category: 'other',
      risk: 'medium',
      title: 'Execute `git status --short`',
      description: '',
      scopeOptions: ['once'],
      nativeOptions: [
        { optionId: 'allow-once', label: 'Yes, proceed', kind: 'allow_once' },
      ],
      ...overrides,
    },
  };
}

describe('parseApprovalRequested', () => {
  it('uses the derived subject as the card cmd', () => {
    const item = parseApprovalRequested(envelope({ subject: 'git status --short' }));
    expect(item?.cmd).toBe('git status --short');
  });

  it('falls back to payload command keys when subject is absent', () => {
    const item = parseApprovalRequested(envelope({
      payload: { rawInput: { command: 'git status --short' } },
    }));
    expect(item?.cmd).toBe('git status --short');
  });

  it('falls back to the title when neither subject nor payload carry a command', () => {
    const item = parseApprovalRequested(envelope());
    expect(item?.cmd).toBe('Execute `git status --short`');
  });

  it('falls back to the title when subject and payload are both absent', () => {
    const item = parseApprovalRequested(envelope({ title: 'Review request' }));
    expect(item?.cmd).toBe('Review request');
  });
});
