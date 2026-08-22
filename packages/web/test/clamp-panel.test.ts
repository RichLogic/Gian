import { describe, expect, it } from 'vitest';
import { clampMiddleRatio, clampPanelValue } from '../src/presentation/panel-layout.js';

describe('clampPanelValue', () => {
  it('clamps to the inclusive min/max window', () => {
    expect(clampPanelValue(10, 20, 40)).toBe(20);
    expect(clampPanelValue(50, 20, 40)).toBe(40);
    expect(clampPanelValue(30, 20, 40)).toBe(30);
  });
});

describe('clampMiddleRatio', () => {
  it('stays between 0.05 and 0.95', () => {
    expect(clampMiddleRatio(0)).toBe(0.05);
    expect(clampMiddleRatio(1)).toBe(0.95);
    expect(clampMiddleRatio(0.4)).toBe(0.4);
  });
});
