import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp, saolrianSend } from '../state/AppContext';
import type { DailyMetric, ExerciseEntry, Summary } from '../lib/types';
import { dateFromOffset, formatInt, formatNumber, prettyDate, todayISO, weekdayLabel } from '../lib/format';
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

/** How many past workouts the "Recent exercise" list shows. */
const EXERCISE_LIMIT = 10;

export default function History() {
  const { endpoint } = useApp();
  const navigate = useNavigate();
  const [days, setDays] = useState<DaySummary[]>([]);
  const [metrics, setMetrics] = useState<Record<string, DailyMetric>>({});
  const [exercise, setExercise] = useState<ExerciseEntry[]>([]);
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

    // Sleep / body fat live on daily_metrics and exercise on its own
    // collection — both read straight from PocketBase, no custom route.
    const uid = pb.authStore.record?.id;
    if (uid) {
      try {
        const rows = await pb.collection('daily_metrics').getFullList({
          filter: `user="${uid}" && date>="${dates[0]}" && date<="${dates[dates.length - 1]} 23:59:59"`,
        });
        setMetrics(
          Object.fromEntries(
            rows.map((r) => [String(r['date'] ?? '').slice(0, 10), r as unknown as DailyMetric]),
          ),
        );
      } catch {
        setMetrics({});
      }
      try {
        const res = await pb.collection('exercise_entries').getList(1, EXERCISE_LIMIT, {
          filter: `user="${uid}"`,
          sort: '-logged_at',
        });
        setExercise(res.items as unknown as ExerciseEntry[]);
      } catch {
        setExercise([]);
      }
    }

    setLoading(false);
  }, [endpoint]);

  useEffect(() => {
    void load();
  }, [load]);

  const sel = days.find((d) => d.date === selected);
  const remaining = sel && sel.budget != null ? sel.budget - sel.totals.kcal : null;
  const selMetric = sel ? metrics[sel.date] : undefined;
  const oneDp = (n: number) => formatNumber(n, { maximumFractionDigits: 1 });

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
                  <div className="mt-3.5 flex border-t border-border pt-3.5 [&>div+div]:border-l [&>div+div]:border-border [&>div+div]:pl-3.5">
                    <div className="flex-1">
                      <div className="text-2xs font-semibold uppercase tracking-[.05em] text-text-faint">Sleep</div>
                      <div className="mt-0.5 text-xl font-bold tracking-[-.01em]">
                        {selMetric?.sleep_hours == null ? (
                          '—'
                        ) : (
                          <>
                            {oneDp(selMetric.sleep_hours)}{' '}
                            <small className="text-sm font-medium text-text-faint">h</small>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex-1">
                      <div className="text-2xs font-semibold uppercase tracking-[.05em] text-text-faint">Body fat</div>
                      <div className="mt-0.5 text-xl font-bold tracking-[-.01em]">
                        {selMetric?.body_fat_pct == null ? (
                          '—'
                        ) : (
                          <>
                            {oneDp(selMetric.body_fat_pct)}{' '}
                            <small className="text-sm font-medium text-text-faint">%</small>
                          </>
                        )}
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
              <div className="px-6 pt-5">
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

          {/* Exercise — not day-scoped: imported workouts often predate this
              week, so show the most recent ones whenever they happened. */}
          <div className="px-6 pb-6 pt-5">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-md font-bold tracking-[-.01em]">Recent exercise</h2>
            </div>
            {exercise.length === 0 ? (
              <Empty align="left">No exercise logged yet.</Empty>
            ) : (
              <Card padding="none">
                <ul>
                  {exercise.map((e) => (
                    <li
                      key={e.id}
                      className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 last:border-b-0"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold">{e.name}</div>
                        <div className="mt-0.5 text-2xs text-text-faint">
                          {prettyDate(String(e.logged_at).slice(0, 10))}
                          {e.minutes ? ` · ${formatInt(e.minutes)} min` : ''}
                        </div>
                      </div>
                      <div className="shrink-0 text-sm font-bold tracking-[-.01em]">
                        {formatInt(e.kcal)} <small className="text-2xs font-medium text-text-faint">kcal</small>
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
        </>
      )}
    </div>
  );
}
