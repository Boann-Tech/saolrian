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

export interface TrendDay {
  date: string;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  entries: number;
  /** The user recorded something this day. Distinct from "ate zero calories". */
  logged: boolean;
  water_ml: number;
  steps: number;
  by_slot: Record<string, number>;
}

export interface TrendWeight {
  date: string;
  kg: number;
}

export interface TrendEma {
  date: string;
  kg: number;
  /** Carried forward from the previous day; not a measurement. */
  interpolated: boolean;
}

export interface TrendEstimate {
  sufficient: boolean;
  reason: string;
  window_days: number;
  observed_tdee: number;
  margin: number;
  slope_kg_per_week: number;
  mean_intake: number;
  /** Days whose kcal cleared the qualifying floor — not the same as `logged`. */
  qualifying_days: number;
  weigh_ins: number;
  span_days: number;
  suggested_target: number;
}

export interface TrendSlot {
  id: string;
  name: string;
  sort_order: number;
  pct_allocation: number;
}

export interface TrendsPayload {
  range: { from: string; to: string; days: number };
  days: TrendDay[];
  weights: TrendWeight[];
  ema: TrendEma[];
  budget: number | null;
  budget_message?: string;
  formula_tdee: number | null;
  goal: string;
  goal_rate: number;
  /** '' | 'manual' | 'observed' — where the current calorie_target came from. */
  target_source: string;
  /** When it was set; '' when never. */
  target_set_at: string;
  targets: { protein_g: number; carbs_g: number; fat_g: number; water_ml: number; steps: number };
  slots: TrendSlot[];
  estimate: TrendEstimate;
}
