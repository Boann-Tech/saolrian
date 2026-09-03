import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp, saolrianSend } from '../state/AppContext';
import type { Summary } from '../lib/types';
import { dateFromOffset, formatInt, prettyDate, todayISO, weekdayLabel } from '../lib/format';
import { getClient } from '../lib/pb';
import { normalizeSummary } from '../lib/normalize';
import { MealGroup } from '../components/MealGroup';
import { Card, Empty, Spinner, StatTile, useToast } from '../components/ui';
import { cn } from '../lib/cn';

/** History — prototype structure: subhead, 7-day day-pill strip with
 * adherence dots, day summary card (Budget/Eaten/Remaining), week stat
 * tiles, meals in shared MealGroup groups. */

interface DaySummary extends Summary {
  date: string;
}

export default function History() {
  const { endpoint } = useApp();
  const navigate = useNavigate();
  const [days, setDays] = useState<DaySummary[]>([]);
  const [selected, setSelected] = useState<string>(todayISO());
  const [loading, setLoading] = useState(true);
  const toast = useToast();

  const destroyEntry = async (entryId: string) => {
    const pb = getClient(endpoint);
    try {
      await pb.collection('diary_entries').delete(entryId);
      await load();
      toast('Entry deleted');
    } catch (ex) {
      toast(ex instanceof Error ? ex.message : 'Could not delete entry', 'err');
    }
  };

  const load = useCallback(async () => {
    if (!endpoint) return;
    setLoading(true);
    const pb = getClient(endpoint);
    const dates = Array.from({ length: 7 }, (_, i) => dateFromOffset(i - 6));
    const results = await Promise.all(
      dates.map(async (date) => {
        try {
          const raw = await saolrianSend<Record<string, unknown>>(pb, 'GET', `/api/saolrian/summary?date=${date}`);
          return { ...normalizeSummary(raw), date } as DaySummary;
        } catch {
          return {
            date,
            budget: null,
            tdee: null,
            goal: 'maintain',
            groups: [],
            totals: { kcal: 0, protein: 0, carbs: 0, fat: 0 },
          } as DaySummary;
        }
      }),
    );
    setDays(results);
    setLoading(false);
  }, [endpoint]);

  useEffect(() => {
    void load();
  }, [load]);

  const sel = days.find((d) => d.date === selected);
  const remaining = sel && sel.budget != null ? sel.budget - sel.totals.kcal : null;

  return (
    <div>
      <div className="flex items-center justify-between px-6 pb-3 pt-4">
        <h2 className="text-xl font-bold tracking-[-.02em]">History</h2>
        <span
          role="presentation"
          className="flex items-center gap-1.5 rounded-full border border-border bg-raised px-3.5 py-2 text-xs font-semibold text-text"
        >
          {new Date(sel?.date ?? todayISO() + 'T12:00:00').toLocaleDateString('en-GB', {
            month: 'long',
            year: 'numeric',
          })}{' '}
          <span className="text-text-faint">▾</span>
        </span>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 px-6 py-5 text-sm text-text-muted">
          <Spinner /> Loading the week…
        </div>
      ) : (
        <>
          {/* Week strip — day pills with an adherence dot */}
          <div className="flex gap-1.5 px-6 pb-3">
            {days.map((d) => {
              const over = d.budget != null && d.totals.kcal > d.budget;
              return (
                <button
                  key={d.date}
                  className={cn(
                    'flex-1 min-w-0 cursor-pointer rounded-lg border bg-raised py-2 text-center transition',
                    d.date === selected
                      ? 'border-accent bg-accent-soft'
                      : 'border-border hover:border-accent-line',
                  )}
                  onClick={() => setSelected(d.date)}
                >
                  <div className="text-[10px] font-semibold uppercase tracking-[.05em] text-text-faint">
                    {weekdayLabel(d.date)}
                  </div>
                  <div className="mt-0.5 text-sm font-bold">{new Date(d.date + 'T12:00:00').getDate()}</div>
                  <span
                    className={cn(
                      'mx-auto mt-1 h-[5px] w-[5px] rounded-full',
                      d.totals.kcal === 0 ? 'bg-border' : over ? 'bg-warn' : 'bg-good',
                    )}
                    title={d.budget == null ? 'No budget set' : over ? 'Over budget' : 'Within budget'}
                  />
                </button>
              );
            })}
          </div>

          {/* Selected day summary */}
          {sel && (
            <>
              <div className="px-6 pt-5">
                <Card className="p-5">
                  <div className="text-xs font-semibold uppercase tracking-[.05em] text-text-faint">
                    {sel.date === todayISO() ? 'Today' : prettyDate(sel.date)}
                  </div>
                  <div className="mt-2.5 flex [&>div+div]:border-l [&>div+div]:border-border [&>div+div]:pl-3.5">
                    <div className="flex-1">
                      <div className="text-2xs font-semibold uppercase tracking-[.05em] text-text-faint">Budget</div>
                      <div className="mt-0.5 text-xl font-bold tracking-[-.01em]">
                        {sel.budget == null ? '—' : formatInt(sel.budget)}
                      </div>
                    </div>
                    <div className="flex-1">
                      <div className="text-2xs font-semibold uppercase tracking-[.05em] text-text-faint">Eaten</div>
                      <div className="mt-0.5 text-xl font-bold tracking-[-.01em]">{formatInt(sel.totals.kcal)}</div>
                    </div>
                    <div className="flex-1">
                      <div className="text-2xs font-semibold uppercase tracking-[.05em] text-text-faint">Remaining</div>
                      <div
                        className={cn(
                          'mt-0.5 text-xl font-bold tracking-[-.01em]',
                          remaining != null && (remaining < 0 ? 'text-warn' : 'text-good-ink'),
                        )}
                      >
                        {remaining == null ? '—' : formatInt(remaining)}
                      </div>
                    </div>
                  </div>
                </Card>
              </div>

              {/* Week at a glance */}
              <div className="px-6 pt-5">
                <div className="mb-3 flex items-baseline justify-between">
                  <h2 className="text-md font-bold tracking-[-.01em]">This week</h2>
                </div>
                <div className="flex gap-2.5">
                  <StatTile
                    label="Avg intake"
                    value={formatInt(days.reduce((s, d) => s + d.totals.kcal, 0) / days.length)}
                  />
                  <StatTile
                    label="On target"
                    value={`${days.filter((d) => d.budget != null && d.totals.kcal <= d.budget && d.totals.kcal > 0).length}/${days.length}`}
                  />
                  <StatTile label="Logged days" value={days.filter((d) => d.totals.kcal > 0).length} />
                </div>
              </div>

              {/* Meals in shared MealGroup groups */}
              <div className="px-6 pb-6 pt-5">
                <div className="mb-3 flex items-baseline justify-between">
                  <h2 className="text-md font-bold tracking-[-.01em]">
                    Meals — <span className="font-semibold text-text-faint">{prettyDate(sel.date)}</span>
                  </h2>
                </div>
                {sel.groups.length === 0 ? (
                  <Empty align="left">No meal data for this day.</Empty>
                ) : (
                  sel.groups.map((g) => (
                    <MealGroup
                      key={g.slot_id}
                      group={g}
                      addLabel="Add food"
                      onDelete={(id) => void destroyEntry(id)}
                      onEdit={(id) => navigate(`/edit/${id}`)}
                    />
                  ))
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
