import { describe, expect, it } from 'vitest';
import {
  NEW_SESSION_DRAFT_KEY_PREFIX,
  newSessionDraftStorageKey,
  screenshotEventMatchesScope,
} from '../src/screenshot-drafts.js';

describe('newSessionDraftStorageKey', () => {
  it('encodes the scope kind and id', () => {
    expect(newSessionDraftStorageKey({ kind: 'workspace', id: 'ws 1' }))
      .toBe(`${NEW_SESSION_DRAFT_KEY_PREFIX}.workspace.${encodeURIComponent('ws 1')}`);
  });
});

describe('screenshotEventMatchesScope', () => {
  const scope = { kind: 'workspace' as const, id: 'ws-1' };

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
