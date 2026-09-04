import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApp, saolrianSend } from '../state/AppContext';
import { parseLoseItCsv, type LoseItRow } from '../lib/loseit';
import { toCsv, buildExportFilename, downloadText, type ExportRow } from '../lib/export';
import { getClient } from '../lib/pb';
import type { DiaryEntry } from '../lib/types';
import { Button, Card, useToast } from '../components/ui';
import { formatInt } from '../lib/format';

/** Import (Lose It! CSV) + diary CSV export — prototype hairline cards. */

export default function Import() {
  const { endpoint } = useApp();
  const toast = useToast();
  const navigate = useNavigate();
  const [rows, setRows] = useState<LoseItRow[] | null>(null);
  const [fileName, setFileName] = useState('');
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ imported: number; skipped: number } | null>(null);
  const [importErr, setImportErr] = useState('');
  const [exporting, setExporting] = useState(false);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setResult(null);
    setImportErr('');
    try {
      const text = await file.text();
      setRows(parseLoseItCsv(text));
    } catch {
      setImportErr('Could not read that file.');
      setRows(null);
    }
  };

  const doImport = async () => {
    if (!rows || rows.length === 0) return;
    setImporting(true);
    setImportErr('');
    try {
      const pb = getClient(endpoint);
      const res = await saolrianSend<{ imported: number; skipped: number }>(
        pb,
        'POST',
        '/api/saolrian/import/loseit',
        { rows },
      );
      setResult(res);
      toast(`Imported ${res.imported} entr${res.imported === 1 ? 'y' : 'ies'}`);
    } catch (ex) {
      setImportErr(ex instanceof Error ? ex.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  const doExport = async () => {
    setExporting(true);
    try {
      const pb = getClient(endpoint);
      const slotNames = new Map<string, string>();
      const slots = await pb.collection('meal_slots').getFullList({ sort: 'sort_order' });
      slots.forEach((s) => slotNames.set(s.id, s.name));

      const all: ExportRow[] = [];
      let page = 1;
      for (;;) {
        const res = await pb.collection('diary_entries').getList(page, 200, {
          sort: '-logged_at',
        });
        res.items.forEach((it) => {
          const e = it as unknown as DiaryEntry;
          all.push({
            name: e.name_snapshot,
            brand: e.brand_snapshot,
            meal: slotNames.get(e.meal_slot) ?? '',
            grams: e.grams,
            kcal: e.kcal,
            protein: e.protein,
            carbs: e.carbs,
            fat: e.fat,
            logged_at: String(e.logged_at).slice(0, 10),
          });
        });
        if (page >= res.totalPages) break;
        page++;
      }

      const today = new Date().toISOString().slice(0, 10);
      downloadText(buildExportFilename(today), toCsv(all));
      toast(`Exported ${all.length} entr${all.length === 1 ? 'y' : 'ies'}`);
    } catch (ex) {
      toast(ex instanceof Error ? ex.message : 'Export failed', 'err');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="pb-2">
      <div className="flex items-center justify-between px-6 pb-3 pt-4">
        <button
          className="flex h-9 w-9 flex-none items-center justify-center rounded-md border border-border bg-raised text-text"
          onClick={() => navigate('/profile')}
          aria-label="Back to profile"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <h2 className="text-xl font-bold tracking-[-.02em]">Import &amp; export</h2>
        <span className="w-9" />
      </div>

      <div className="px-6 pt-1">
        <Card className="p-4">
          <div className="text-xs font-semibold text-text-muted">Import from Lose It!</div>
          <p className="mt-2 mb-3 text-xs leading-normal text-text-muted">
            Upload a Lose It! CSV export. Columns are detected from the header row, so reordered exports work too.
          </p>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={onFile}
            className="text-sm text-text-muted file:mr-3 file:rounded-md file:border-0 file:bg-accent-soft file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-accent-ink"
          />
          {fileName && <p className="mt-2 text-xs text-text-faint">File: {fileName}</p>}

          {rows && (
            <div className="mt-3.5 border-t border-border pt-3.5">
              <p className="mb-2.5 text-sm text-text-muted">
                <strong>{formatInt(rows.length)}</strong> entr{rows.length === 1 ? 'y' : 'ies'} ready to import.
              </p>
              {rows.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-xs mb-3.5">
                    <thead>
                      <tr>
                        <th className="border-b border-border px-2 py-1.5 text-left text-2xs font-semibold uppercase tracking-[.05em] text-text-faint">Date</th>
                        <th className="border-b border-border px-2 py-1.5 text-left text-2xs font-semibold uppercase tracking-[.05em] text-text-faint">Name</th>
                        <th className="border-b border-border px-2 py-1.5 text-left text-2xs font-semibold uppercase tracking-[.05em] text-text-faint">Meal</th>
                        <th className="border-b border-border px-2 py-1.5 text-left text-2xs font-semibold uppercase tracking-[.05em] text-text-faint">kcal</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.slice(0, 5).map((r, i) => (
                        <tr key={i}>
                          <td className="border-b border-dotted border-border px-2 py-1.5 text-text">{r.date}</td>
                          <td className="border-b border-dotted border-border px-2 py-1.5 text-text">{r.name}</td>
                          <td className="border-b border-dotted border-border px-2 py-1.5 text-text">{r.meal}</td>
                          <td className="border-b border-dotted border-border px-2 py-1.5 text-text">{r.kcal}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {rows.length > 5 && <p className="mb-3 text-xs text-text-faint">…and {formatInt(rows.length - 5)} more</p>}
              <Button loading={importing} disabled={rows.length === 0} onClick={() => void doImport()}>
                {importing ? 'Importing…' : `Import ${formatInt(rows.length)} entries`}
              </Button>
            </div>
          )}

          {result && (
            <div className="mt-3 rounded-md bg-good/12 px-3.5 py-2.5 text-sm font-semibold text-good-ink" role="status">
              Imported {formatInt(result.imported)}, skipped {formatInt(result.skipped)}.
            </div>
          )}
          {importErr && (
            <div className="mt-3 rounded-md border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger" role="alert">
              {importErr}
            </div>
          )}
        </Card>
      </div>

      <div className="px-6 pb-6.5 pt-5">
        <Card className="p-4">
          <div className="text-xs font-semibold text-text-muted">Export diary</div>
          <p className="mt-2 mb-3 text-xs leading-normal text-text-muted">Download every diary entry as a CSV file, newest first.</p>
          <Button variant="outline" loading={exporting} onClick={() => void doExport()}>
            {exporting ? 'Exporting…' : 'Export CSV'}
          </Button>
        </Card>
      </div>

      <div className="px-6 pt-5 pb-6.5">
        <Link
          to="/profile"
          className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-transparent px-3.5 py-3 text-base font-semibold text-accent-ink transition hover:bg-accent-soft active:scale-[.98] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/40"
        >
          ← Back to profile
        </Link>
      </div>
    </div>
  );
}
