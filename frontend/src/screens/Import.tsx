import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApp, saolrianSend } from '../state/AppContext';
import { parseLoseItZip, type LoseItCategoryPreview, type LoseItImportCategories } from '../lib/loseitZip';
import { ensurePushSubscription } from '../lib/push';
import { toCsv, buildExportFilename, downloadText, type ExportRow } from '../lib/export';
import { getClient } from '../lib/pb';
import type { DiaryEntry } from '../lib/types';
import { Button, Card, useToast } from '../components/ui';
import { formatInt } from '../lib/format';

/** Import (Lose It! zip, async job + realtime status) + diary CSV export. */

interface ImportJobRecord {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  counts: Record<string, { imported: number; skipped: number }>;
  error?: string;
}

export default function Import() {
  const { endpoint } = useApp();
  const toast = useToast();
  const navigate = useNavigate();

  const [fileName, setFileName] = useState('');
  const [categories, setCategories] = useState<LoseItImportCategories | null>(null);
  const [previews, setPreviews] = useState<LoseItCategoryPreview[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [parseErr, setParseErr] = useState('');
  const [job, setJob] = useState<ImportJobRecord | null>(null);
  const [liveStatusUnavailable, setLiveStatusUnavailable] = useState(false);
  const [starting, setStarting] = useState(false);
  const [exporting, setExporting] = useState(false);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setParseErr('');
    setJob(null);
    try {
      const { categories: cats, previews: prevs } = await parseLoseItZip(file);
      if (prevs.length === 0) {
        setParseErr('No importable Lose It! data found in this file.');
        setCategories(null);
        setPreviews([]);
        return;
      }
      setCategories(cats);
      setPreviews(prevs);
      setSelected(new Set(prevs.filter((p) => p.defaultSelected).map((p) => p.key)));
    } catch {
      setParseErr('Could not read that file — is it a Lose It! export zip?');
      setCategories(null);
      setPreviews([]);
    }
  };

  const toggle = (key: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const startImport = async () => {
    if (!categories || selected.size === 0) return;
    setStarting(true);
    setLiveStatusUnavailable(false);
    try {
      const pb = getClient(endpoint);
      const payload: Record<string, unknown> = {};
      for (const key of selected) {
        payload[key] = (categories as Record<string, unknown>)[key];
      }

      void ensurePushSubscription(endpoint);

      const res = await saolrianSend<{ job_id: string }>(pb, 'POST', '/api/saolrian/import/loseit', {
        categories: payload,
      });

      setJob({ id: res.job_id, status: 'queued', counts: {} });

      // Reports a terminal job status (done/failed) exactly once: updates the
      // UI state and shows the completion toast. Shared between the ongoing
      // realtime subscription and the one-shot reconciliation fetch below, so
      // a job that finishes between "subscribe() resolves" and "the socket is
      // actually listening" is still reported instead of leaving the UI stuck
      // on "Importing…" forever. `reported` guards against both paths seeing
      // the same terminal update and double-toasting.
      let reported = false;
      const handleTerminal = (rec: ImportJobRecord) => {
        setJob(rec);
        if (rec.status !== 'done' && rec.status !== 'failed') return;
        if (reported) return;
        reported = true;
        void pb.collection('import_jobs').unsubscribe(res.job_id);
        if (rec.status === 'done') {
          const totals = Object.values(rec.counts).reduce(
            (acc, c) => ({ imported: acc.imported + c.imported, skipped: acc.skipped + c.skipped }),
            { imported: 0, skipped: 0 },
          );
          toast(`Imported ${formatInt(totals.imported)}, skipped ${formatInt(totals.skipped)}.`);
        } else {
          toast(rec.error || 'Import failed', 'err');
        }
      };

      // The import has genuinely started server-side at this point (we have
      // a real job_id), so a failure to subscribe (websocket/auth hiccup)
      // must not be reported as an import-start failure — that would be
      // false — and must not leave the UI stuck showing "Importing…" with
      // no way for it to ever resolve. Give it its own try/catch.
      try {
        await pb.collection('import_jobs').subscribe<ImportJobRecord>(res.job_id, (e) => {
          handleTerminal(e.record);
        });
      } catch (ex) {
        console.error('Failed to subscribe to import job status:', ex);
        setLiveStatusUnavailable(true);
        toast('Import started — live status is unavailable right now, check back later.');
        return;
      }

      // The subscription is live at this point, but the job may have already
      // reached a terminal state server-side before it was fully established
      // (e.g. a small, fast import) — in which case the realtime `update`
      // event already fired with nobody listening. Reconcile with one fetch
      // so that case is still reported instead of leaving the UI stuck. This
      // is a separate try/catch from the subscribe() above: a working
      // subscription must not be reported as "unavailable" just because this
      // one-off reconciliation fetch happened to fail — the subscription
      // will still catch the update if the job hasn't finished yet.
      try {
        const current = await pb.collection('import_jobs').getOne<ImportJobRecord>(res.job_id);
        handleTerminal(current);
      } catch (ex) {
        console.error('Failed to fetch current import job status:', ex);
      }
    } catch (ex) {
      toast(ex instanceof Error ? ex.message : 'Import failed to start', 'err');
    } finally {
      setStarting(false);
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
            Upload your Lose It! export zip (Settings → Export Data in the Lose It! app), then pick which parts to
            bring in.
          </p>
          <input
            type="file"
            accept=".zip,application/zip"
            onChange={(e) => void onFile(e)}
            aria-label="Upload Lose It export zip"
            className="text-sm text-text-muted file:mr-3 file:rounded-md file:border-0 file:bg-accent-soft file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-accent-ink"
          />
          {fileName && <p className="mt-2 text-xs text-text-faint">File: {fileName}</p>}
          {parseErr && (
            <div className="mt-3 rounded-md border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger" role="alert">
              {parseErr}
            </div>
          )}

          {previews.length > 0 && !job && (
            <div className="mt-3.5 border-t border-border pt-3.5">
              <ul className="mb-3 flex flex-col gap-2">
                {previews.map((p) => (
                  <li key={p.key}>
                    <label className="flex items-center gap-2 text-sm text-text">
                      <input
                        type="checkbox"
                        checked={selected.has(p.key)}
                        onChange={() => toggle(p.key)}
                        className="h-4 w-4 rounded border-border accent-accent"
                      />
                      {p.label} — {formatInt(p.count)} {p.count === 1 ? 'entry' : 'entries'}
                    </label>
                  </li>
                ))}
              </ul>
              <Button loading={starting} disabled={selected.size === 0} onClick={() => void startImport()}>
                {starting ? 'Starting…' : `Import ${selected.size} selected`}
              </Button>
            </div>
          )}

          {job && (
            <div
              className={
                job.status === 'failed'
                  ? 'mt-3 rounded-md border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger'
                  : 'mt-3 rounded-md bg-good/12 px-3.5 py-2.5 text-sm font-semibold text-good-ink'
              }
              role={job.status === 'failed' ? 'alert' : 'status'}
            >
              {liveStatusUnavailable ? (
                'Import started, but live status could not be loaded — check back later.'
              ) : job.status === 'queued' || job.status === 'running' ? (
                "Importing… you can leave this page, you'll be notified when it's done."
              ) : job.status === 'done' ? (
                <>
                  Import complete.
                  <ul className="mt-1.5 flex flex-col gap-0.5 text-xs font-normal text-good-ink">
                    {Object.entries(job.counts)
                      .filter(([, c]) => c.imported > 0 || c.skipped > 0)
                      .map(([key, c]) => (
                        <li key={key}>
                          {previews.find((p) => p.key === key)?.label ?? key} — {formatInt(c.imported)} imported
                          {c.skipped > 0 && `, ${formatInt(c.skipped)} skipped`}
                        </li>
                      ))}
                  </ul>
                </>
              ) : (
                `Import failed: ${job.error ?? 'unknown error'}`
              )}
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
