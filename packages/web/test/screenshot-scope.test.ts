import { describe, expect, it } from 'vitest';
import {
  NEW_SESSION_DRAFT_KEY_PREFIX,
  newSessionDraftStorageKey,
  screenshotEventMatchesScope,
} from '../src/screenshot-drafts.js';

describe('newSessionDraftStorageKey', () => {
  it('isolates equal Task and Repo IDs in different execution environments', () => {
    const scope = { kind: 'task' as const, id: 'same-task' };
    const local = newSessionDraftStorageKey(scope);
    const first = newSessionDraftStorageKey({ ...scope, environmentId: 'remote-a' });
    const second = newSessionDraftStorageKey({ ...scope, environmentId: 'remote-b' });
    expect(new Set([local, first, second]).size).toBe(3);
  });
  it('encodes the scope kind and id', () => {
    expect(newSessionDraftStorageKey({ kind: 'workspace', id: 'ws 1' }))
      .toBe(`${NEW_SESSION_DRAFT_KEY_PREFIX}.workspace.${encodeURIComponent('ws 1')}`);
  });
});

describe('screenshotEventMatchesScope', () => {
  const scope = { kind: 'workspace' as const, id: 'ws-1' };

  it('does not move a late screenshot into a different execution environment', () => {
    const remote = { ...scope, environmentId: 'remote-a' };
    const captured = { scope: remote, attachments: [] };
    expect(screenshotEventMatchesScope(captured, remote)).toBe(true);
    expect(screenshotEventMatchesScope(captured, scope)).toBe(false);
    expect(screenshotEventMatchesScope(captured, { ...scope, environmentId: 'remote-b' })).toBe(false);
  });

  it('accepts a matching scope plus an attachments array', () => {
    expect(screenshotEventMatchesScope({
      scope,
      attachments: [],
    }, scope)).toBe(true);
  });

  it('rejects mismatched scope, missing attachments, or junk', () => {
    expect(screenshotEventMatchesScope({
      scope: { kind: 'workspace', id: 'other' },
      attachments: [],
    }, scope)).toBe(false);
    expect(screenshotEventMatchesScope({ scope }, scope)).toBe(false);
    expect(screenshotEventMatchesScope(null, scope)).toBe(false);
    expect(screenshotEventMatchesScope('x', scope)).toBe(false);
  });
});
