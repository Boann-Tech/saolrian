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
