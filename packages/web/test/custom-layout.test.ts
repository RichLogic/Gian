// Custom page detail layout (Issue #50): the detail sheet is a real second
// track of the content column — side-by-side while the two minimum tracks
// fit, swapped in as the whole column (with a back affordance) below that.

import { describe, expect, it } from 'vitest';
import {
  CUSTOM_DETAIL_MIN_PX,
  CUSTOM_MAIN_MIN_PX,
  CUSTOM_TRACK_GUTTER_PX,
  customDetailLayout,
} from '../src/presentation/custom-layout.js';

const THRESHOLD = CUSTOM_MAIN_MIN_PX + CUSTOM_DETAIL_MIN_PX + CUSTOM_TRACK_GUTTER_PX;

describe('customDetailLayout', () => {
  it('stays on the wide track when the content width is unmeasurable (0 / jsdom)', () => {
    expect(customDetailLayout(0)).toBe('side');
  });

  it('lays the list and detail side by side at and above the two-track minimum', () => {
    expect(customDetailLayout(THRESHOLD)).toBe('side');
    expect(customDetailLayout(1280)).toBe('side');
  });

  it('swaps the detail in as the content column below the two-track minimum', () => {
    expect(customDetailLayout(THRESHOLD - 1)).toBe('swap');
    expect(customDetailLayout(400)).toBe('swap');
  });
});
