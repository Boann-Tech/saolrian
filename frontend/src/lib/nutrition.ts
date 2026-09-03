import type { ActivityLevel, Goal, Sex, TdeeFormula } from './types';

/**
 * Client-side TDEE + macro math — MUST stay identical to the Go backend's
 * /api/saolrian/summary computation. Both use:
 *   BMR (Mifflin-St Jeor) = 10*kg + 6.25*cm - 5*age + (male: +5, female: -161, other: 0)
 *   BMR (Katch-McArdle)   = 370 + 21.6 * LBM(kg), LBM = kg * (1 - body_fat_pct/100)
 *   TDEE = BMR * activity factor
 *   goal adjustment: lose -500, maintain 0, gain +350
 */

export const ACTIVITY_FACTORS: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  very: 1.725,
  extreme: 1.9,
};

export const GOAL_ADJUSTMENT: Record<Goal, number> = {
  lose: -500,
  maintain: 0,
  gain: 350,
};

export interface ProfileInput {
  height_cm: number | null;
  birth_year: number | null;
  sex: Sex | null;
  activity_level: ActivityLevel | null;
  body_fat_pct: number | null;
  weight_kg: number | null;
  tdee_formula: TdeeFormula | null;
}

export function computeBmr(p: ProfileInput, formula: TdeeFormula = 'mifflin'): number | null {
  if (formula === 'katch') {
    if (p.weight_kg == null || p.body_fat_pct == null) return null;
    const lbm = p.weight_kg * (1 - p.body_fat_pct / 100);
    return 370 + 21.6 * lbm;
  }
  if (p.weight_kg == null || p.height_cm == null || p.birth_year == null || !p.sex) return null;
  const age = new Date().getFullYear() - p.birth_year;
  const base = 10 * p.weight_kg + 6.25 * p.height_cm - 5 * age;
  return base + (p.sex === 'male' ? 5 : p.sex === 'female' ? -161 : 0);
}

export function computeTdee(p: ProfileInput): number | null {
  const formula = p.tdee_formula ?? 'mifflin';
  const bmr = computeBmr(p, formula);
  if (bmr == null) return null;
  const factor = p.activity_level ? ACTIVITY_FACTORS[p.activity_level] : null;
  if (factor == null) return null;
  return bmr * factor;
}

export function computeCalorieTarget(p: ProfileInput, goal: Goal): number | null {
  const tdee = computeTdee(p);
  if (tdee == null) return null;
  return tdee + GOAL_ADJUSTMENT[goal];
}

export const FORMULA_LABEL: Record<TdeeFormula, string> = {
  mifflin: 'Mifflin-St Jeor',
  katch: 'Katch-McArdle',
};

export function macroSplit(target: number, proteinPct: number, fatPct: number) {
  const carbsPct = Math.max(0, 100 - proteinPct - fatPct);
  return {
    carbsPct,
    proteinKcal: Math.round((target * proteinPct) / 100),
    carbsKcal: Math.round((target * carbsPct) / 100),
    fatKcal: Math.round((target * fatPct) / 100),
  };
}

export function foodMath(kcalPer100g: number, protein: number, carbs: number, fat: number, grams: number) {
  const f = grams / 100;
  return {
    kcal: Math.round(kcalPer100g * f),
    protein: Math.round(protein * f * 10) / 10,
    carbs: Math.round(carbs * f * 10) / 10,
    fat: Math.round(fat * f * 10) / 10,
  };
}

export const DEFAULT_MACROS = { protein_pct: 30, carbs_pct: 45, fat_pct: 25 };
