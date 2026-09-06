import { describe, it, expect } from 'vitest';
import { niceBounds, scaleX, scaleY, linePath } from './scale';

describe('niceBounds', () => {
  it('pads a normal range so the line does not touch the frame', () => {
    const { min, max } = niceBounds([80, 84]);
    expect(min).toBeLessThan(80);
    expect(max).toBeGreaterThan(84);
  });

  it('gives a flat series a non-zero span so scaleY cannot divide by zero', () => {
    const { min, max } = niceBounds([80, 80, 80]);
    expect(max).toBeGreaterThan(min);
  });

  it('handles an empty series without producing NaN', () => {
    const { min, max } = niceBounds([]);
    expect(Number.isFinite(min)).toBe(true);
    expect(Number.isFinite(max)).toBe(true);
    expect(max).toBeGreaterThan(min);
  });
});

describe('scaleY', () => {
  it('maps the maximum to the top and the minimum to the bottom', () => {
    // SVG y grows downward, so the max must produce the smaller number.
    expect(scaleY(10, 0, 10, 0, 100)).toBeCloseTo(0);
    expect(scaleY(0, 0, 10, 0, 100)).toBeCloseTo(100);
    expect(scaleY(5, 0, 10, 0, 100)).toBeCloseTo(50);
  });

  it('returns the midpoint rather than NaN for a zero span', () => {
    expect(scaleY(5, 5, 5, 0, 100)).toBeCloseTo(50);
  });
});

describe('scaleX', () => {
  it('spreads points across the full width', () => {
    expect(scaleX(0, 5, 0, 100)).toBeCloseTo(0);
    expect(scaleX(4, 5, 0, 100)).toBeCloseTo(100);
  });

  it('centres a single point', () => {
    expect(scaleX(0, 1, 0, 100)).toBeCloseTo(50);
  });
});

describe('linePath', () => {
  it('builds an SVG path', () => {
    expect(linePath([{ x: 0, y: 0 }, { x: 10, y: 5 }])).toBe('M0 0 L10 5');
  });

  it('returns an empty string for no points', () => {
    expect(linePath([])).toBe('');
  });
});
