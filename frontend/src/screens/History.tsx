import { useCallback, useEffect, useState } from 'react';
import { useApp, saolrianSend } from '../state/AppContext';
import type { Summary } from '../lib/types';
import { dateFromOffset, formatInt, prettyDate, todayISO, weekdayLabel } from '../lib/format';
import { getClient } from '../lib/pb';
import { normalizeSummary } from '../lib/normalize';
import { MealGroup } from '../components/MealGroup';
import { Spinner } from '../components/ui';
import './history.css';

/** History — prototype structure: subhead, 7-day .dpill strip with
 * adherence dots, .daycard summary (Budget/Eaten/Remaining), week stat
 * tiles, meals in shared .mealgrp groups. */

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
      <div className="subhead">
        <h2>History</h2>
        <span className="monthsel" role="presentation">
          {new Date(sel?.date ?? todayISO() + 'T12:00:00').toLocaleDateString('en-GB', {
            month: 'long',
            year: 'numeric',
          })}{' '}
          <span style={{ color: 'var(--faint)' }}>▾</span>
        </span>
      </div>

      {loading ? (
        <div className="history-loading">
          <Spinner /> Loading the week…
        </div>
      ) : (
        <>
          {/* Week strip (prototype .dpill pills with adherence dot) */}
          <div className="weekstrip">
            {days.map((d) => {
              const over = d.budget != null && d.totals.kcal > d.budget;
              return (
                <button
                  key={d.date}
                  className={'dpill' + (d.date === selected ? ' on' : '')}
                  onClick={() => setSelected(d.date)}
                >
                  <div className="dw">{weekdayLabel(d.date)}</div>
                  <div className="dn">{new Date(d.date + 'T12:00:00').getDate()}</div>
                  <span
                    className={'ad' + (d.totals.kcal === 0 ? ' none' : over ? ' over' : '')}
                    title={d.budget == null ? 'No budget set' : over ? 'Over budget' : 'Within budget'}
                  />
                </button>
              );
            })}
          </div>

          {/* Selected day summary (prototype .daycard) */}
          {sel && (
            <>
              <div className="sec" style={{ paddingTop: 4 }}>
                <div className="card daycard" style={{ padding: '18px 20px' }}>
                  <div className="cap">{sel.date === todayISO() ? 'Today' : prettyDate(sel.date)}</div>
                  <div className="daygrid">
                    <div>
                      <div className="lbl2">Budget</div>
                      <div className="v2">{sel.budget == null ? '—' : formatInt(sel.budget)}</div>
                    </div>
                    <div>
                      <div className="lbl2">Eaten</div>
                      <div className="v2">{formatInt(sel.totals.kcal)}</div>
                    </div>
                    <div>
                      <div className="lbl2">Remaining</div>
                      <div className={'v2' + (remaining != null ? (remaining < 0 ? ' bad' : ' good') : '')}>
                        {remaining == null ? '—' : formatInt(remaining)}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Week at a glance (prototype .stats tiles) */}
              <div className="sec">
                <div className="sec-h">
                  <h2>This week</h2>
                </div>
                <div className="stats">
                  <div className="stat">
                    <div className="k">Avg intake</div>
                    <div className="v">{formatInt(days.reduce((s, d) => s + d.totals.kcal, 0) / days.length)}</div>
                  </div>
                  <div className="stat">
                    <div className="k">On target</div>
                    <div className="v">
                      {days.filter((d) => d.budget != null && d.totals.kcal <= d.budget && d.totals.kcal > 0).length}/
                      {days.length}
                    </div>
                  </div>
                  <div className="stat">
                    <div className="k">Logged days</div>
                    <div className="v">{days.filter((d) => d.totals.kcal > 0).length}</div>
                  </div>
                </div>
              </div>

              {/* Meals in prototype mealgrp groups */}
              <div className="sec" style={{ paddingBottom: 24 }}>
                <div className="sec-h">
                  <h2>
                    Meals — <span style={{ color: 'var(--faint)', fontWeight: 600 }}>{prettyDate(sel.date)}</span>
                  </h2>
                </div>
                {sel.groups.length === 0 ? (
                  <p className="empty" style={{ textAlign: 'left', padding: 0 }}>
                    No meal data for this day.
                  </p>
                ) : (
                  sel.groups.map((g) => <MealGroup key={g.slot_id} group={g} addLabel="Add food" />)
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
