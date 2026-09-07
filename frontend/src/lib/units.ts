import { formatNumber } from './format';

/** Display units.
 *
 * Storage is always metric — kg, cm, g, ml — so every existing record, the
 * TDEE math and the Go backend are untouched. This module converts only at
 * the edges, where a value is shown to or typed by a person. */

export type Units = 'metric' | 'imperial';

const LB_PER_KG = 2.2046226218;
const CM_PER_INCH = 2.54;
const ML_PER_FL_OZ = 29.5735295625;

export const kgToLb = (kg: number): number => kg * LB_PER_KG;
export const lbToKg = (lb: number): number => lb / LB_PER_KG;
export const mlToFlOz = (ml: number): number => ml / ML_PER_FL_OZ;
export const flOzToMl = (flOz: number): number => flOz * ML_PER_FL_OZ;

/** Height as a foot/inch pair. Rounds to whole inches first, so a value that
 *  rounds up to 12 inches becomes the next foot rather than reading 5'12". */
export function cmToFeetInches(cm: number): { feet: number; inches: number } {
  const totalInches = Math.round(cm / CM_PER_INCH);
  return { feet: Math.floor(totalInches / 12), inches: totalInches % 12 };
}

export function feetInchesToCm(feet: number, inches: number): number {
  return (feet * 12 + inches) * CM_PER_INCH;
}

export const weightUnit = (units: Units): string => (units === 'imperial' ? 'lb' : 'kg');
export const volumeUnit = (units: Units): string => (units === 'imperial' ? 'fl oz' : 'ml');

/** Format a stored value (kg) for display in the user's system. */
export function formatWeight(kg: number, units: Units): string {
  return units === 'imperial'
    ? `${formatNumber(kgToLb(kg), { maximumFractionDigits: 1 })} lb`
    : `${formatNumber(kg, { maximumFractionDigits: 1 })} kg`;
}

/** Format a stored value (ml) for display in the user's system. */
export function formatVolume(ml: number, units: Units): string {
  return units === 'imperial'
    ? `${formatNumber(Math.round(mlToFlOz(ml)))} fl oz`
    : `${formatNumber(Math.round(ml))} ml`;
}

/** Locales that measure bodyweight in pounds. The UK is here deliberately:
 *  metric officially, pounds and stones in practice for bodyweight. */
const IMPERIAL_LOCALES = ['US', 'GB', 'LR', 'MM'];

export function defaultUnits(locale?: string): Units {
  if (!locale) return 'metric';
  const region = locale.split('-')[1]?.toUpperCase();
  return region && IMPERIAL_LOCALES.includes(region) ? 'imperial' : 'metric';
}
