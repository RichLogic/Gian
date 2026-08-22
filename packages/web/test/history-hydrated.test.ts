import { describe, expect, it } from 'vitest';
import { historyIsHydrated, type TranscriptHistoryState } from '../src/controllers/use-transcript-hydration.js';

function state(phase: TranscriptHistoryState['phase']): TranscriptHistoryState {
  return {
    phase,
    hasMore: false,
    loading: false,
    loadingOlder: false,
    cursor: null,
    error: null,
  };
}

describe('historyIsHydrated', () => {
  it('is true only for page and complete', () => {
    expect(historyIsHydrated(undefined)).toBe(false);
    expect(historyIsHydrated(state('unloaded'))).toBe(false);
    expect(historyIsHydrated(state('live'))).toBe(false);
    expect(historyIsHydrated(state('page'))).toBe(true);
    expect(historyIsHydrated(state('complete'))).toBe(true);
  });
});
