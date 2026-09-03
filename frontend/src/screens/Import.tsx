import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApp, saolrianSend } from '../state/AppContext';
import { parseLoseItCsv, type LoseItRow } from '../lib/loseit';
import { toCsv, buildExportFilename, downloadText, type ExportRow } from '../lib/export';
import { getClient } from '../lib/pb';
import type { DiaryEntry } from '../lib/types';
import { useToast } from '../components/ui';
import { formatInt } from '../lib/format';
import './import.css';

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
    <div className="import">
      <div className="subhead">
        <button className="backbtn" onClick={() => navigate('/profile')} aria-label="Back to profile">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <h2>Import &amp; export</h2>
        <span style={{ width: 36 }} />
      </div>

      <div className="sec" style={{ paddingTop: 4 }}>
        <div className="card" style={{ padding: '16px 18px' }}>
          <div className="lbl2">Import from Lose It!</div>
          <p className="import-hint">
            Upload a Lose It! CSV export. Columns are detected from the header row, so reordered exports work too.
          </p>
          <input type="file" accept=".csv,text/csv" onChange={onFile} className="file-input" />
          {fileName && <p className="import-file">File: {fileName}</p>}

          {rows && (
            <div className="import-preview">
              <p>
                <strong>{formatInt(rows.length)}</strong> entr{rows.length === 1 ? 'y' : 'ies'} ready to import.
              </p>
              {rows.length > 0 && (
                <table className="preview-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Name</th>
                      <th>Meal</th>
                      <th>kcal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 5).map((r, i) => (
                      <tr key={i}>
                        <td>{r.date}</td>
                        <td>{r.name}</td>
                        <td>{r.meal}</td>
                        <td>{r.kcal}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {rows.length > 5 && <p className="preview-more">…and {formatInt(rows.length - 5)} more</p>}
              <button className="btn" onClick={() => void doImport()} disabled={importing || rows.length === 0}>
                {importing ? 'Importing…' : `Import ${formatInt(rows.length)} entries`}
              </button>
            </div>
          )}

          {result && (
            <div className="import-result" role="status">
              Imported {formatInt(result.imported)}, skipped {formatInt(result.skipped)}.
            </div>
          )}
          {importErr && (
            <div className="import-err" role="alert">
              {importErr}
            </div>
          )}
        </div>
      </div>

      <div className="sec" style={{ paddingBottom: 26 }}>
        <div className="card" style={{ padding: '16px 18px' }}>
          <div className="lbl2">Export diary</div>
          <p className="import-hint">Download every diary entry as a CSV file, newest first.</p>
          <button className="btn outline" onClick={() => void doExport()} disabled={exporting}>
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
        </div>
      </div>

      <div className="sec" style={{ paddingBottom: 26 }}>
        <Link to="/profile" className="btn ghost" style={{ width: '100%', textAlign: 'center' }}>
          ← Back to profile
        </Link>
      </div>
    </div>
  );
}
