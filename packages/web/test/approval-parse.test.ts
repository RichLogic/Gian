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

  it('passes through gian.proxy/2.0 actions and inputs', () => {
    const item = parseApprovalRequested(envelope({
      subject: 'git status --short',
      actions: [
        { id: 'allow_once', label: 'Allow once', style: 'primary' },
        { id: 'reject_once', label: 'Reject', style: 'danger' },
      ],
      inputs: [{
        id: 'reason',
        type: 'text',
        label: 'Reason',
        required: true,
      }],
    }));
    expect(item?.actions).toEqual([
      { id: 'allow_once', label: 'Allow once', style: 'primary' },
      { id: 'reject_once', label: 'Reject', style: 'danger' },
    ]);
    expect(item?.inputs).toEqual([{
      id: 'reason',
      type: 'text',
      label: 'Reason',
      required: true,
    }]);
  });

  it('passes through gian.proxy/2.0 interactionKind and tone', () => {
    const item = parseApprovalRequested(envelope({
      interactionKind: 'confirmation',
      tone: 'danger',
    }));
    expect(item?.interactionKind).toBe('confirmation');
    expect(item?.tone).toBe('danger');
  });

  it('passes through a validated external interaction URL', () => {
    const item = parseApprovalRequested(envelope({
      externalUrl: 'https://chatgpt.com/apps/linear',
    }));
    expect(item?.externalUrl).toBe('https://chatgpt.com/apps/linear');
  });

  it('drops unknown interactionKind and tone values', () => {
    const item = parseApprovalRequested(envelope({
      interactionKind: 'widget',
      tone: 'blink',
    }));
    expect(item && 'interactionKind' in item).toBe(false);
    expect(item && 'tone' in item).toBe(false);
    expect(item?.interactionKind).toBeUndefined();
    expect(item?.tone).toBeUndefined();
  });

  it('marks items whose cmd came from a context subject', () => {
    const withSubject = parseApprovalRequested(envelope({ subject: 'Bash\nnpm install' }));
    expect(withSubject?.hasSubject).toBe(true);
    expect(withSubject?.cmd).toBe('Bash\nnpm install');

    const withoutSubject = parseApprovalRequested(envelope({}));
    expect(withoutSubject && 'hasSubject' in withoutSubject).toBe(false);
  });
});
