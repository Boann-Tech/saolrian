/** Domain types shared across screens. Backend contract lives in the project docs. */

export type Goal = 'lose' | 'maintain' | 'gain';
export type Sex = 'male' | 'female' | 'other';
export type ActivityLevel = 'sedentary' | 'light' | 'moderate' | 'very' | 'extreme';
export type TdeeFormula = 'mifflin' | 'katch';

export interface Profile {
  id: string;
  height_cm: number | null;
  birth_year: number | null;
  sex: Sex | null;
  activity_level: ActivityLevel | null;
  body_fat_pct: number | null;
  tdee_formula: TdeeFormula | null;
  goal: Goal | null;
  calorie_target: number | null;
  protein_pct: number | null;
  carbs_pct: number | null;
  fat_pct: number | null;
  theme_accent: string | null;
  goal_rate: number | null;
  [key: string]: unknown;
}

export interface MealSlot {
  id: string;
  name: string;
  sort_order: number;
  pct_allocation: number | null;
}

export interface Food {
  barcode: string | null;
  name: string;
  brand: string | null;
  kcal_per_100g: number;
  protein_per_100g: number;
  carbs_per_100g: number;
  fat_per_100g: number;
  default_serving_g?: number | null;
  local: boolean;
}

export interface DiaryEntry {
  id: string;
  meal_slot: string;
  name_snapshot: string;
  brand_snapshot?: string | null;
  grams: number;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  logged_at: string;
  source: string;
}

export interface SummaryEntry {
  id: string;
  name: string;
  brand: string | null;
  grams: number;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  logged_at: string;
  source: string;
}

export interface SummaryGroup {
  slot_id: string;
  slot_name: string;
  sort_order: number;
  entries: SummaryEntry[];
}

export interface Summary {
  budget: number | null;
  tdee: number | null;
  goal: string;
  groups: SummaryGroup[];
  totals: { kcal: number; protein: number; carbs: number; fat: number };
}

/** One logged workout — created by the Lose It! import (source "import"). */
export interface ExerciseEntry {
  id: string;
  name: string;
  minutes: number | null;
  kcal: number;
  logged_at: string;
  source?: string;
}

/** Per-user, per-day metrics row. Water/steps are edited on Today; sleep and
 * body fat are currently write-only from the Lose It! import. */
export interface DailyMetric {
  id: string;
  date: string;
  water_ml: number | null;
  steps: number | null;
  sleep_hours: number | null;
  body_fat_pct: number | null;
}

export interface WeightRecord {
  id: string;
  kg: number;
  measured_at: string;
  source?: string;
}

export interface Recipe {
  id: string;
  name: string;
  servings: number;
  total_kcal: number;
  total_protein: number;
  total_carbs: number;
  total_fat: number;
}

export interface RecipeIngredient {
  id: string;
  recipe: string;
  food: string | null;
  name_snapshot: string;
  brand_snapshot?: string | null;
  grams: number;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  sort_order: number;
}
