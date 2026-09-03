/** Client-side CSV export of diary entries (paged fetch upstream, string-building here). */

export interface ExportRow {
  name: string;
  brand?: string | null;
  meal: string;
  grams: number;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  logged_at: string;
}

const HEADERS = [
  'date',
  'meal',
  'name',
  'brand',
  'grams',
  'kcal',
  'protein_g',
  'carbs_g',
  'fat_g',
] as const;

function esc(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: ExportRow[]): string {
  const head = HEADERS.join(',');
  const body = rows.map((r) =>
    [r.logged_at, r.meal, r.name, r.brand ?? '', r.grams, r.kcal, r.protein, r.carbs, r.fat]
      .map(esc)
      .join(','),
  );
  return [head, ...body].join('\n');
}

export function buildExportFilename(date: string): string {
  return `saolrian-diary-${date}.csv`;
}

export function downloadText(filename: string, text: string, mime = 'text/csv'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
