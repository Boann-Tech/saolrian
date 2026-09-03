import { useCallback, useEffect, useState } from 'react';
import { useApp, saolrianSend } from '../state/AppContext';
import type { Summary } from '../lib/types';
import { dateFromOffset, formatInt, prettyDate, todayISO, weekdayLabel } from '../lib/format';
import { getClient } from '../lib/pb';
import { normalizeSummary } from '../lib/normalize';
import { MealGroup } from '../components/MealGroup';
import { Card, CardTitle, Empty, Spinner } from '../components/ui';
import './history.css';

/** History: 7-day strip with adherence dots + selected-day breakdown. */

interface DaySummary extends Summary {
  date: string;
}

export default function History() {
  const { endpoint } = useApp();
  const [days, setDays] = useState<DaySummary[]>([]);
  const [selected, setSelected] = useState<string>(todayISO());
  const [loading, setLoading] = useState(true);

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
    <div className="history">
      <h1 className="page-title">History</h1>

      {loading ? (
        <div className="history-loading">
          <Spinner /> Loading the week…
        </div>
      ) : (
        <>
          {/* Week strip */}
          <div className="week-strip">
            {days.map((d) => {
              const over = d.budget != null && d.totals.kcal > d.budget;
              const isToday = d.date === todayISO();
              return (
                <button
                  key={d.date}
                  className={
                    'day-pill' +
                    (d.date === selected ? ' day-pill-active' : '') +
                    (isToday ? ' day-pill-today' : '')
                  }
                  onClick={() => setSelected(d.date)}
                >
                  <span className="day-pill-dow">{weekdayLabel(d.date)}</span>
                  <span
                    className={
                      'day-dot' + (d.totals.kcal === 0 ? ' day-dot-none' : over ? ' day-dot-over' : ' day-dot-good')
                    }
                    title={d.budget == null ? 'No budget set' : over ? 'Over budget' : 'Within budget'}
                  />
                  <span className="day-pill-date">{prettyDate(d.date)}</span>
                </button>
              );
            })}
          </div>

          {/* Selected day summary */}
          {sel && (
            <>
              <Card>
                <CardTitle>{sel.date === todayISO() ? 'Today' : prettyDate(sel.date)}</CardTitle>
                <div className="hist-stats">
                  <div>
                    <span className="hs-label">Budget</span>
                    <span className="hs-val">{sel.budget == null ? '—' : formatInt(sel.budget)}</span>
                  </div>
                  <div>
                    <span className="hs-label">Eaten</span>
                    <span className="hs-val">{formatInt(sel.totals.kcal)}</span>
                  </div>
                  <div>
                    <span className="hs-label">Remaining</span>
                    <span className={'hs-val' + (remaining != null && remaining < 0 ? ' hs-over' : '')}>
                      {remaining == null ? '—' : formatInt(remaining)}
                    </span>
                  </div>
                </div>
              </Card>

              <Card>
                <CardTitle>Meals</CardTitle>
                {sel.groups.length === 0 ? (
                  <Empty>No meal data for this day.</Empty>
                ) : (
                  sel.groups.map((g) => <MealGroup key={g.slot_id} group={g} addLabel="Add food for this day" />)
                )}
              </Card>
            </>
          )}
        </>
      )}
    </div>
  );
}
