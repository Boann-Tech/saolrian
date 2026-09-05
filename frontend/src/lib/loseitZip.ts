/** Unzips a LoseIt export client-side and parses every supported category
 * found in it. Unrecognized files (achievements, fasting, etc. — see the
 * design spec's skip list) are simply never looked up, so they're read
 * into memory by unzipSync but never surfaced or acted on. */
import { unzipSync, strFromU8 } from 'fflate';
import {
  parseLoseItCsv,
  parseDateValueCsv,
  parseLoseItWeightCsv,
  parseLoseItExerciseCsv,
  parseLoseItFoodCatalogCsv,
  parseLoseItProfileCsv,
  type LoseItRow,
  type DateValueRow,
  type LoseItWeightRow,
  type LoseItExerciseRow,
  type LoseItFoodCatalogRow,
  type LoseItProfileSnapshot,
} from './loseit';

// Water intake (water-intake.csv, via parseDateValueCsv) has the same
// unknown-unit problem as weight — LoseIt likely reports it in fl oz or
// cups for imperial accounts rather than ml — but the only sample export
// available while building this fix is a metric one, so there's no way to
// confirm the imperial column's actual unit (or even whether it's fl oz
// vs. cups) without guessing blind. Left unconverted; the picker label
// below still flags the assumption. See issue #2.

export interface LoseItImportCategories {
  diary?: LoseItRow[];
  weight?: LoseItWeightRow[];
  exercise?: LoseItExerciseRow[];
  foods?: LoseItFoodCatalogRow[];
  recipes?: LoseItFoodCatalogRow[];
  steps?: DateValueRow[];
  water?: DateValueRow[];
  body_fat?: DateValueRow[];
  sleep?: DateValueRow[];
  profile?: LoseItProfileSnapshot;
}

export interface LoseItCategoryPreview {
  key: keyof LoseItImportCategories;
  label: string;
  count: number;
  defaultSelected: boolean;
}

const CATEGORY_META: Record<keyof LoseItImportCategories, { file: string; label: string; defaultSelected: boolean }> = {
  diary: { file: 'food-logs.csv', label: 'Food logs', defaultSelected: true },
  // Overwritten dynamically when unit detection finds imperial with
  // reasonable confidence — see the `weight` handling in parseLoseItZip.
  weight: { file: 'weights.csv', label: 'Weight (imported as kg)', defaultSelected: true },
  exercise: { file: 'exercise-logs.csv', label: 'Exercise', defaultSelected: true },
  foods: { file: 'custom-foods.csv', label: 'Custom foods', defaultSelected: true },
  recipes: { file: 'recipes.csv', label: 'Recipes', defaultSelected: true },
  steps: { file: 'steps.csv', label: 'Steps', defaultSelected: true },
  water: { file: 'water-intake.csv', label: 'Water (imported as ml)', defaultSelected: true },
  body_fat: { file: 'body-fat.csv', label: 'Body fat', defaultSelected: true },
  sleep: { file: 'sleep-hours.csv', label: 'Sleep', defaultSelected: true },
  profile: { file: 'profile.csv', label: 'Profile & goals', defaultSelected: false },
};

export async function parseLoseItZip(
  file: File,
): Promise<{ categories: LoseItImportCategories; previews: LoseItCategoryPreview[] }> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const entries = unzipSync(buf);

  const text = (name: string): string | null => {
    const data = entries[name];
    return data ? strFromU8(data) : null;
  };

  const categories: LoseItImportCategories = {};
  const previews: LoseItCategoryPreview[] = [];

  function add<K extends keyof LoseItImportCategories>(key: K, rows: LoseItImportCategories[K] | null): void {
    if (!rows) return;
    const count = Array.isArray(rows) ? rows.length : 1;
    if (count === 0) return;
    categories[key] = rows;
    previews.push({ key, label: CATEGORY_META[key].label, count, defaultSelected: CATEGORY_META[key].defaultSelected });
  }

  // Parsed ahead of weight so its Height field can feed the unit-detection
  // heuristic below (LoseIt exports don't otherwise say which units an
  // account uses).
  const profileText = text(CATEGORY_META.profile.file);
  const profileSnap = profileText ? parseLoseItProfileCsv(profileText) : null;

  const diaryText = text(CATEGORY_META.diary.file);
  add('diary', diaryText ? parseLoseItCsv(diaryText) : null);

  const weightText = text(CATEGORY_META.weight.file);
  if (weightText) {
    const { rows, unitSystem } = parseLoseItWeightCsv(weightText, profileSnap ?? undefined);
    add('weight', rows);
    if (unitSystem === 'imperial') {
      const preview = previews.find((p) => p.key === 'weight');
      if (preview) preview.label = 'Weight (converted from lbs)';
    }
  }

  const exerciseText = text(CATEGORY_META.exercise.file);
  add('exercise', exerciseText ? parseLoseItExerciseCsv(exerciseText) : null);

  const foodsText = text(CATEGORY_META.foods.file);
  add('foods', foodsText ? parseLoseItFoodCatalogCsv(foodsText) : null);

  const recipesText = text(CATEGORY_META.recipes.file);
  add('recipes', recipesText ? parseLoseItFoodCatalogCsv(recipesText) : null);

  const stepsText = text(CATEGORY_META.steps.file);
  add('steps', stepsText ? parseDateValueCsv(stepsText) : null);

  const waterText = text(CATEGORY_META.water.file);
  add('water', waterText ? parseDateValueCsv(waterText) : null);

  const bodyFatText = text(CATEGORY_META.body_fat.file);
  add('body_fat', bodyFatText ? parseDateValueCsv(bodyFatText) : null);

  const sleepText = text(CATEGORY_META.sleep.file);
  add('sleep', sleepText ? parseDateValueCsv(sleepText) : null);

  if (profileSnap && Object.keys(profileSnap).length > 0) {
    categories.profile = profileSnap;
    previews.push({ key: 'profile', label: CATEGORY_META.profile.label, count: 1, defaultSelected: false });
  }

  return { categories, previews };
}
