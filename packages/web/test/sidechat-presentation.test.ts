/**
 * Side Chat presentation helpers (`src/presentation/sidechat.ts`, proposal
 * §10.5): parent filtering/ordering, chip labels, the four mandated
 * close-confirm clauses (§10.5.4/§15), the parent-delete cascade suffix, and
 * the Composer session adapter (identity from the Side Chat, session config
 * inherited AS-IS from the parent, §10.5.1).
 */
import { describe, expect, it } from 'vitest';
import type { Session, SideChatInfo } from '@gian/shared';

import { EN } from '../src/i18n/en.js';
import { ZH } from '../src/i18n/zh.js';
import {
  sideChatCloseConfirmMessage,
  sideChatComposerSession,
  sideChatLabel,
  sideChatParentCascadeSuffix,
  sideChatsForParent,
} from '../src/presentation/sidechat.js';

const t = (key: string) => EN[key] ?? key;

function sideChat(id: string, createdAt: string, parent = 's-parent'): SideChatInfo {
  return {
    id,
    parent_session_id: parent,
    stream_id: `stream-${id}`,
    state: 'idle',
    status: 'open',
    anchor: { type: 'empty' },
    session_config: {},
    last_error: null,
    uncertain_turn_id: null,
    events: [],
    user_inputs: [],
    created_at: createdAt,
    updated_at: createdAt,
  };
}

describe('sideChatsForParent', () => {
  it('filters to the parent and sorts oldest-first (chip order)', () => {
    const records = sideChatsForParent([
      sideChat('sc-new', '2026-08-20T09:00:00.000Z'),
      sideChat('sc-other', '2026-08-20T07:00:00.000Z', 's-other'),
      sideChat('sc-old', '2026-08-20T08:00:00.000Z'),
    ], 's-parent');
    expect(records.map(entry => entry.id)).toEqual(['sc-old', 'sc-new']);
  });
});

describe('sideChatLabel', () => {
  it('uses the Gian standard name plus a 1-based ordinal — never the provider id', () => {
    expect(sideChatLabel(t, sideChat('sc-1', '2026-08-20T08:00:00.000Z'), 0)).toBe('Side Chat 1');
    expect(sideChatLabel(t, sideChat('sc-2', '2026-08-20T09:00:00.000Z'), 1)).toBe('Side Chat 2');
  });
});

describe('sideChatCloseConfirmMessage (§10.5.4 mandated clauses)', () => {
  it('contains all four clauses: permanent delete, turn stop, no side-effect rollback, provider records', () => {
    const message = sideChatCloseConfirmMessage(t);
    for (const key of [
      'sidechat.closeConfirm.deleted',
      'sidechat.closeConfirm.turnStopped',
      'sidechat.closeConfirm.sideEffects',
      'sidechat.closeConfirm.providerRecords',
    ]) {
      expect(EN[key], `missing en string for ${key}`).toBeTruthy();
      expect(message).toContain(EN[key]!);
    }
    // The provider clause is a caveat, never a deletion claim.
    expect(EN['sidechat.closeConfirm.providerRecords']).toContain('may still keep');
  });

  it('every sidechat.* key exists in BOTH locales (append-only contract)', () => {
    const enKeys = Object.keys(EN).filter(key => key.startsWith('sidechat.'));
    expect(enKeys.length).toBeGreaterThan(0);
    for (const key of enKeys) {
      expect(ZH[key], `zh locale is missing ${key}`).toBeTruthy();
    }
  });
});

describe('sideChatParentCascadeSuffix (§10.5.4 parent close cascade)', () => {
  it('is empty when the parent has no open side chats', () => {
    expect(sideChatParentCascadeSuffix(t, [])).toBe('');
  });

  it('lists the open side chats by their chip labels, oldest first', () => {
    const suffix = sideChatParentCascadeSuffix(t, [
      sideChat('sc-b', '2026-08-20T09:00:00.000Z'),
      sideChat('sc-a', '2026-08-20T08:00:00.000Z'),
    ]);
    expect(suffix).toContain('Side Chat 1');
    expect(suffix).toContain('Side Chat 2');
    expect(suffix.indexOf('Side Chat 1')).toBeLessThan(suffix.indexOf('Side Chat 2'));
    expect(EN['sidechat.parentCloseCascade']).toContain('{names}');
  });
});

describe('sideChatComposerSession', () => {
  const parent = {
    id: 's-parent',
    executor: 'codex',
    model: 'gpt-5.6-sol',
    approval_mode: 'ask',
    thinking_effort: 'high',
    workspace_id: 'w-1',
    worktree_outcome: 'merged',
    completed_at: '2026-08-20T10:00:00.000Z',
    unread: 1,
    status: 'running',
  } as unknown as Session;

  it('takes identity from the Side Chat record, config from the parent (§10.5.1 inheritance)', () => {
    const record = sideChat('sc-1', '2026-08-20T08:00:00.000Z');
    const adapted = sideChatComposerSession(record, parent);
    // Side Chat identity: composer drafts and operation entity keys isolate
    // per Side Chat.
    expect(adapted.id).toBe('sc-1');
    expect(adapted.created_at).toBe(record.created_at);
    // Session-bound config inherited as-is.
    expect(adapted.executor).toBe('codex');
    expect(adapted.model).toBe('gpt-5.6-sol');
    expect(adapted.approval_mode).toBe('ask');
    expect(adapted.thinking_effort).toBe('high');
    expect(adapted.workspace_id).toBe('w-1');
    // A Side Chat is never completed/terminal/unread — the dock drives the
    // composer from the record state + pending store, not these fields.
    expect(adapted.completed_at).toBeNull();
    expect(adapted.worktree_outcome).toBeNull();
    expect(adapted.unread).toBe(0);
    expect(adapted.status).toBe('done');
  });
});
