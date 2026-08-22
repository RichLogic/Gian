/**
 * Session Fork presentation helpers (`src/presentation/fork.ts`).
 * Copy must name a new session from a parent history boundary — never a
 * rewind, git branch, worktree, snapshot, or rollback.
 */
import { describe, expect, it } from 'vitest';
import type { SessionOrigin } from '@gian/shared';

import { EN } from '../src/i18n/en.js';
import { ZH } from '../src/i18n/zh.js';
import { forkOriginParentLabel, forkOriginText } from '../src/presentation/fork.js';

const t = (key: string) => EN[key] ?? key;

function origin(overrides: Partial<SessionOrigin> = {}): SessionOrigin {
  return {
    kind: 'fork',
    session_id: 'parent-session-abcdef',
    turn_id: '',
    source_turn_id: '',
    ...overrides,
  };
}

describe('forkOriginParentLabel', () => {
  it('uses the resolved parent name when present', () => {
    expect(forkOriginParentLabel(origin(), 'Design review')).toBe('Design review');
  });

  it('falls back to the first 8 characters of session_id', () => {
    expect(forkOriginParentLabel(origin({ session_id: 's-parent-abcdef' }))).toBe('s-parent');
  });
});

describe('forkOriginText', () => {
  it('head forks use fork.origin.from and omit a turn id', () => {
    const text = forkOriginText(t, origin(), 'Parent');
    expect(text).toBe(EN['fork.origin.from']!.replace('{name}', 'Parent'));
    expect(text).not.toMatch(/turn/i);
  });

  it('atTurn forks insert the Host turn id verbatim', () => {
    const text = forkOriginText(t, origin({ turn_id: 't_boundary_9', source_turn_id: 'prov-9' }), 'Parent');
    expect(text).toBe(
      EN['fork.origin.fromTurn']!
        .replace('{name}', 'Parent')
        .replace('{turn}', 't_boundary_9'),
    );
    expect(text).toContain('t_boundary_9');
  });

  it('fork copy never describes rewind / git branch / worktree / snapshot / rollback', () => {
    const banned = /rewind|\bgit\b|\bbranch|worktree|snapshot|rollback|roll back/iu;
    const from = forkOriginText(t, origin(), 'Alpha');
    const fromTurn = forkOriginText(t, origin({ turn_id: 't_1' }), 'Alpha');
    expect(banned.test(from)).toBe(false);
    expect(banned.test(fromTurn)).toBe(false);
    expect(banned.test(EN['fork.origin.from']!)).toBe(false);
    expect(banned.test(EN['fork.origin.fromTurn']!)).toBe(false);
    expect(banned.test(ZH['fork.origin.from']!)).toBe(false);
    expect(banned.test(ZH['fork.origin.fromTurn']!)).toBe(false);
  });
});
