import { describe, it, expect } from 'vitest';
import {
  kgToLb, lbToKg, cmToFeetInches, feetInchesToCm, mlToFlOz, flOzToMl,
  defaultUnits, weightUnit, volumeUnit, formatWeight, formatVolume,
} from '../units';

describe('unit conversion round-trips', () => {
  it('converts weight both ways', () => {
    expect(kgToLb(100)).toBeCloseTo(220.462, 2);
    expect(lbToKg(220.462)).toBeCloseTo(100, 3);
    expect(lbToKg(kgToLb(72.5))).toBeCloseTo(72.5, 6);
  });

  it('converts height to feet and inches', () => {
    expect(cmToFeetInches(180)).toEqual({ feet: 5, inches: 11 });
    // 152.4 cm is exactly 5'0"
    expect(cmToFeetInches(152.4)).toEqual({ feet: 5, inches: 0 });
  });

  it('rolls 12 inches over into a foot rather than reporting 12', () => {
    // 182.7 cm is 71.93 in — rounds to 72, which is 6'0", not 5'12".
    expect(cmToFeetInches(182.7)).toEqual({ feet: 6, inches: 0 });
  });

  it('converts feet and inches back to cm', () => {
    expect(feetInchesToCm(5, 11)).toBeCloseTo(180.34, 2);
    expect(feetInchesToCm(6, 0)).toBeCloseTo(182.88, 2);
  });

  it('converts volume both ways', () => {
    expect(mlToFlOz(1000)).toBeCloseTo(33.814, 2);
    expect(flOzToMl(33.814)).toBeCloseTo(1000, 1);
  });
});

describe('unit labels', () => {
  it('names the right units for each system', () => {
    expect(weightUnit('metric')).toBe('kg');
    expect(weightUnit('imperial')).toBe('lb');
    expect(volumeUnit('metric')).toBe('ml');
    expect(volumeUnit('imperial')).toBe('fl oz');
  });
});

describe('formatting stored values for display', () => {
  it('shows stored kilograms in the chosen system', () => {
    expect(formatWeight(80, 'metric')).toBe('80 kg');
    expect(formatWeight(80, 'imperial')).toBe('176.4 lb');
  });

  it('shows stored millilitres in the chosen system', () => {
    expect(formatVolume(2000, 'metric')).toBe('2,000 ml');
    expect(formatVolume(2000, 'imperial')).toBe('68 fl oz');
  });
});

describe('defaultUnits', () => {
  it('picks imperial for the locales that use it', () => {
    expect(defaultUnits('en-US')).toBe('imperial');
    expect(defaultUnits('en-GB')).toBe('imperial');
  });

  it('picks metric everywhere else', () => {
    expect(defaultUnits('en-IE')).toBe('metric');
    expect(defaultUnits('de-DE')).toBe('metric');
    expect(defaultUnits(undefined)).toBe('metric');
  });
});
