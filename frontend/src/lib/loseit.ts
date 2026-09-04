/** Defensive parser for Lose It! CSV exports. Detects the header row by name and
 * maps columns by header text, tolerating reordering, quoting and stray rows. */

export interface LoseItRow {
  date: string;
  name: string;
  quantity: number;
  unit: string;
  meal: string;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

const HEADER_ALIASES: Record<keyof Omit<LoseItRow, 'quantity' | 'unit'> | 'quantity' | 'unit', string[]> = {
  date: ['date'],
  name: ['name', 'food'],
  quantity: ['quantity', 'servings'],
  unit: ['units', 'unit', 'serving name'],
  meal: ['meal'],
  kcal: ['calories', 'cal'],
  fat_g: ['fat (g)', 'fat', 'fat grams'],
  protein_g: ['protein (g)', 'protein', 'protein grams'],
  carbs_g: ['carbohydrates (g)', 'carbohydrates', 'carbs', 'carbs (g)'],
};

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function looksLikeHeader(cells: string[]): boolean {
  const lower = cells.map((c) => c.trim().toLowerCase());
  return lower.includes('date') && lower.some((c) => c.includes('calor') || c.includes('cal'));
}

function mapHeader(cells: string[]): Partial<Record<string, number>> {
  const map: Partial<Record<string, number>> = {};
  cells.forEach((raw, idx) => {
    const h = raw.trim().toLowerCase();
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.includes(h) && map[field] === undefined) {
        map[field] = idx;
      }
    }
  });
  return map;
}

function num(s: string | undefined): number {
  if (!s) return 0;
  const n = parseFloat(s.replace(/[^\d.+-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** Converts a LoseIt `MM/DD/YYYY` date to `YYYY-MM-DD`. Passes through an
 * already-ISO date unchanged. The backend parses every date with Go's
 * `time.Parse("2006-01-02", ...)`, so every LoseIt date must go through
 * this before being sent. */
export function toIsoDate(raw: string): string {
  const trimmed = raw.trim();
  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (!mdy) return trimmed;
  const [, mm, dd, yyyy] = mdy;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

export function parseLoseItCsv(text: string): LoseItRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  let headerIdx = lines.findIndex((l) => looksLikeHeader(splitCsvLine(l)));
  if (headerIdx === -1) {
    // No recognizable header — refuse to guess column order.
    return [];
  }
  const colMap = mapHeader(splitCsvLine(lines[headerIdx]));

  const rows: LoseItRow[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const pick = (field: string): string => {
      const idx = colMap[field];
      return idx === undefined ? '' : (cells[idx] ?? '').trim();
    };
    const name = pick('name');
    const date = pick('date');
    if (!name) continue;
    rows.push({
      date: toIsoDate(date),
      name,
      quantity: num(pick('quantity')) || 1,
      unit: pick('unit'),
      meal: pick('meal'),
      kcal: num(pick('kcal')),
      protein_g: num(pick('protein_g')),
      carbs_g: num(pick('carbs_g')),
      fat_g: num(pick('fat_g')),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------
// steps / water-intake / body-fat / sleep-hours (shared Date,Value shape)
// ---------------------------------------------------------------------

export interface DateValueRow {
  date: string;
  value: number;
}

function looksLikeDateValueHeader(cells: string[]): boolean {
  const lower = cells.map((c) => c.trim().toLowerCase());
  return lower[0] === 'date' && lower.includes('value');
}

export function parseDateValueCsv(text: string): DateValueRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const headerIdx = lines.findIndex((l) => looksLikeDateValueHeader(splitCsvLine(l)));
  if (headerIdx === -1) return [];
  const header = splitCsvLine(lines[headerIdx]).map((c) => c.trim().toLowerCase());
  const dateIdx = header.indexOf('date');
  const valueIdx = header.indexOf('value');

  const rows: DateValueRow[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const date = (cells[dateIdx] ?? '').trim();
    if (!date) continue;
    rows.push({ date: toIsoDate(date), value: num(cells[valueIdx]) });
  }
  return rows;
}

// ---------------------------------------------------------------------
// weights.csv
// ---------------------------------------------------------------------

export interface LoseItWeightRow {
  date: string;
  kg: number;
}

function looksLikeWeightHeader(cells: string[]): boolean {
  const lower = cells.map((c) => c.trim().toLowerCase());
  return lower[0] === 'date' && lower.includes('weight');
}

export function parseLoseItWeightCsv(text: string): LoseItWeightRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const headerIdx = lines.findIndex((l) => looksLikeWeightHeader(splitCsvLine(l)));
  if (headerIdx === -1) return [];
  const header = splitCsvLine(lines[headerIdx]).map((c) => c.trim().toLowerCase());
  const dateIdx = header.indexOf('date');
  const weightIdx = header.indexOf('weight');
  const deletedIdx = header.indexOf('deleted');

  const rows: LoseItWeightRow[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    if (deletedIdx !== -1 && (cells[deletedIdx] ?? '').trim().toLowerCase() === 'true') continue;
    const date = (cells[dateIdx] ?? '').trim();
    const kg = num(cells[weightIdx]);
    if (!date || kg <= 0) continue;
    rows.push({ date: toIsoDate(date), kg });
  }
  return rows;
}

// ---------------------------------------------------------------------
// exercise-logs.csv
// ---------------------------------------------------------------------

export interface LoseItExerciseRow {
  date: string;
  name: string;
  minutes: number;
  kcal: number;
}

function looksLikeExerciseHeader(cells: string[]): boolean {
  const lower = cells.map((c) => c.trim().toLowerCase());
  return lower.includes('date') && lower.includes('name') && lower.some((c) => c.includes('calor'));
}

export function parseLoseItExerciseCsv(text: string): LoseItExerciseRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const headerIdx = lines.findIndex((l) => looksLikeExerciseHeader(splitCsvLine(l)));
  if (headerIdx === -1) return [];
  const header = splitCsvLine(lines[headerIdx]).map((c) => c.trim().toLowerCase());
  const dateIdx = header.indexOf('date');
  const nameIdx = header.indexOf('name');
  const qtyIdx = header.indexOf('quantity');
  const unitsIdx = header.indexOf('units');
  const kcalIdx = header.indexOf('calories');
  const deletedIdx = header.indexOf('deleted');

  const rows: LoseItExerciseRow[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    if (deletedIdx !== -1 && (cells[deletedIdx] ?? '').trim() === '1') continue;
    const date = (cells[dateIdx] ?? '').trim();
    const name = (cells[nameIdx] ?? '').trim();
    if (!date || !name) continue;
    const isMinutes = unitsIdx !== -1 && (cells[unitsIdx] ?? '').trim().toLowerCase() === 'minutes';
    rows.push({
      date: toIsoDate(date),
      name,
      minutes: isMinutes ? num(cells[qtyIdx]) : 0,
      kcal: num(cells[kcalIdx]),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------
// custom-foods.csv / recipes.csv (shared shape)
// ---------------------------------------------------------------------

export interface LoseItFoodCatalogRow {
  name: string;
  unique_id: string;
  brand: string;
  quantity: number;
  measure: string;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

function looksLikeFoodCatalogHeader(cells: string[]): boolean {
  const lower = cells.map((c) => c.trim().toLowerCase());
  return lower.includes('uniqueid') && lower.includes('measure');
}

export function parseLoseItFoodCatalogCsv(text: string): LoseItFoodCatalogRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const headerIdx = lines.findIndex((l) => looksLikeFoodCatalogHeader(splitCsvLine(l)));
  if (headerIdx === -1) return [];
  const header = splitCsvLine(lines[headerIdx]).map((c) => c.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const nameIdx = col('name');
  const uidIdx = col('uniqueid');
  const brandIdx = col('brand');
  const qtyIdx = col('quantity');
  const measureIdx = col('measure');
  const kcalIdx = col('calories');
  const fatIdx = col('fat (g)');
  const proteinIdx = col('protein (g)');
  const carbsIdx = col('carbohydrates (g)');

  const rows: LoseItFoodCatalogRow[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const name = (cells[nameIdx] ?? '').trim();
    const uniqueId = (cells[uidIdx] ?? '').trim();
    const quantity = num(cells[qtyIdx]);
    if (!name || !uniqueId || quantity <= 0) continue;
    rows.push({
      name,
      unique_id: uniqueId,
      brand: brandIdx !== -1 ? (cells[brandIdx] ?? '').trim() : '',
      quantity,
      measure: (cells[measureIdx] ?? '').trim(),
      kcal: num(cells[kcalIdx]),
      protein_g: num(cells[proteinIdx]),
      carbs_g: num(cells[carbsIdx]),
      fat_g: num(cells[fatIdx]),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------
// profile.csv
// ---------------------------------------------------------------------

export interface LoseItProfileSnapshot {
  birth_year?: number;
  sex?: 'male' | 'female' | 'other';
  height_cm?: number;
  calorie_target?: number;
  goal?: 'lose' | 'maintain' | 'gain';
  activity_level?: 'sedentary' | 'light' | 'moderate' | 'very' | 'extreme';
}

function mapActivityLevel(raw: string): LoseItProfileSnapshot['activity_level'] {
  const v = raw.toLowerCase();
  if (v.includes('sedentary')) return 'sedentary';
  if (v.includes('extrem')) return 'extreme';
  if (v.includes('very')) return 'very';
  if (v.includes('light')) return 'light';
  return 'moderate';
}

export function parseLoseItProfileCsv(text: string): LoseItProfileSnapshot {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const values: Record<string, string> = {};
  for (const line of lines) {
    const cells = splitCsvLine(line);
    if (cells.length < 2) continue;
    values[cells[0].trim()] = cells[1].trim();
  }

  const snap: LoseItProfileSnapshot = {};

  const birthday = values['Birthday'];
  if (birthday) {
    const year = Number(toIsoDate(birthday).slice(0, 4));
    if (Number.isFinite(year) && year > 1900) snap.birth_year = year;
  }

  const gender = (values['Gender'] ?? '').toLowerCase();
  if (gender === 'male' || gender === 'female') snap.sex = gender;
  else if (gender) snap.sex = 'other';

  const height = num(values['Height']);
  if (height > 0) snap.height_cm = height;

  const eer = num(values['Current EER']);
  const adjustment = num(values['Calorie Adjustment']);
  if (eer > 0 && adjustment !== 0) snap.calorie_target = eer + adjustment;

  const plan = (values['Plan'] ?? '').toLowerCase();
  if (plan === 'lose' || plan === 'maintain' || plan === 'gain') snap.goal = plan;

  const activity = values['Activity Level'];
  if (activity) snap.activity_level = mapActivityLevel(activity);

  return snap;
}
