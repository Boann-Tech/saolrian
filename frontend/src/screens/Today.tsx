import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp, saolrianSend } from '../state/AppContext';
import type { Summary } from '../lib/types';
import { todayISO, greeting, formatInt } from '../lib/format';
import { getClient } from '../lib/pb';
import { normalizeSummary } from '../lib/normalize';
import { MealGroup } from '../components/MealGroup';
import { Spinner, useToast } from '../components/ui';
import './today.css';

/** Today dashboard — prototype structure: brandline hero with balance card,
 * meter, macro stat tiles, collapsible meal groups, movement card. */

export default function Today() {
  const { endpoint, slots, refreshSlots, profile } = useApp();
  const navigate = useNavigate();
  const toast = useToast();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [newSlot, setNewSlot] = useState('');
  const [addingSlot, setAddingSlot] = useState(false);
  const [waterMl, setWaterMl] = useState<number>(0);
  const [steps, setSteps] = useState<number>(0);

  const load = useCallback(async () => {
    if (!endpoint) return;
    setLoading(true);
    setErr('');
    try {
      const pb = getClient(endpoint);
      const raw = await saolrianSend<Record<string, unknown>>(pb, 'GET', `/api/saolrian/summary?date=${todayISO()}`);
      setSummary(normalizeSummary(raw));
      await loadMetrics(pb);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Failed to load summary');
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => {
    void load();
  }, [load]);

  const addSlot = async () => {
    const name = newSlot.trim();
    if (!name) return;
    setAddingSlot(true);
    const pb = getClient(endpoint);
    try {
      await pb.collection('meal_slots').create({
        user: pb.authStore.record?.id,
        name,
        sort_order: slots.length + 1,
      });
      setNewSlot('');
      await refreshSlots();
      await load();
      toast(`Added “${name}”`);
    } catch (ex) {
      toast(ex instanceof Error ? ex.message : 'Could not add meal slot', 'err');
    } finally {
      setAddingSlot(false);
    }
  };

  const budget = summary?.budget ?? null;
  const eaten = summary?.totals.kcal ?? 0;
  const pct = budget && budget > 0 ? Math.min(100, Math.round((eaten / budget) * 100)) : 0;
  const remaining = budget != null ? budget - eaten : null;
  const over = remaining != null && remaining < 0;
  const firstName = (profile?.['name'] as string | undefined) ?? '';

  const loadMetrics = async (pb: ReturnType<typeof getClient>) => {
    try {
      const uid = pb.authStore.record?.id;
      if (!uid) return;
      const list = await pb.collection('daily_metrics').getFullList({
        filter: `user="${uid}" && date~"${todayISO()}"`,
      });
      const row = list[0];
      setWaterMl(row?.['water_ml'] ?? 0);
      setSteps(row?.['steps'] ?? 0);
    } catch {
      /* ignore — defaults shown */
    }
  };

  const upsertMetric = async (patchObj: { water_ml?: number; steps?: number }) => {
    const pb = getClient(endpoint);
    const uid = pb.authStore.record?.id;
    if (!uid) return;
    const list = await pb.collection('daily_metrics').getFullList({
      filter: `user="${uid}" && date~"${todayISO()}"`,
    });
    const next = {
      user: uid,
      date: new Date().toISOString(),
      source: 'manual',
      ...(list[0] ? {} : { water_ml: waterMl, steps }),
      ...patchObj,
    };
    if (list[0]) {
      await pb.collection('daily_metrics').update(list[0].id, patchObj);
    } else {
      await pb.collection('daily_metrics').create(next);
    }
    await loadMetrics(pb);
  };

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

  return (
    <div className="today">
      {/* ── Hero (prototype: brandline, greeting, date, balance) ── */}
      <section className="hero">
        <div className="brandline">
          <span className="dot" />
          SAOLRIAN
        </div>
        <h1>
          {greeting()}, <em>{firstName || 'there'}</em>
        </h1>
        <div className="date">
          {new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
        </div>
        <div className="balance">
          <div className="l">
            <div className="cap">Calories today</div>
            <div className="v">
              {formatInt(eaten)} <small>/ {budget != null ? formatInt(budget) : '—'}</small>
            </div>
          </div>
          {budget != null && (
            <div className={`delta${over ? ' over' : ''}`}>
              {over ? `${formatInt(-remaining!)} over` : `${formatInt(remaining!)} left`}
              <small>
                {pct}% of budget{over ? ' — over' : ''}
              </small>
            </div>
          )}
        </div>
      </section>

      {loading && (
        <div className="today-loading">
          <Spinner /> Loading your day…
        </div>
      )}

      {!loading && err && (
        <div className="sec">
          <div className="card" style={{ padding: '16px 18px' }} role="alert">
            <p>{err}</p>
            <button className="btn outline" style={{ marginTop: 10 }} onClick={() => void load()}>
              Retry
            </button>
          </div>
        </div>
      )}

      {!loading && summary && (
        <>
          {/* ── Meter (prototype: full-width track + cap row) ── */}
          <div className="meter">
            <div className="track">
              <div
                className={`fill${over ? ' over' : ''}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="cap">
              <span>
                <b>{pct}%</b> used
              </span>
              <span>{budget != null ? `budget ${formatInt(budget)} kcal` : 'no budget set'}</span>
            </div>
          </div>

          {/* ── Macros (prototype .stats tiles with mini bars) ── */}
          <div className="sec">
            <div className="sec-h">
              <h2>Macros</h2>
              <button className="a" onClick={() => navigate('/profile')}>
                Adjust
              </button>
            </div>
            <div className="stats">
              {(
                [
                  ['Protein', summary.totals.protein, 'g'],
                  ['Carbs', summary.totals.carbs, 'g'],
                  ['Fat', summary.totals.fat, 'g'],
                ] as const
              ).map(([label, val, unit]) => (
                <div key={label} className="stat">
                  <div className="k">{label}</div>
                  <div className="v">
                    {formatInt(val)}
                    {unit} <small>/ 150</small>
                  </div>
                  <div className="mini">
                    <i style={{ width: `${Math.min(100, Math.round((val / 150) * 100))}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ── Meals (prototype .mealgrp groups) ── */}
          <div className="sec">
            <div className="sec-h">
              <h2>Today’s meals</h2>
              <button className="a" onClick={() => navigate('/add')}>
                + Add food
              </button>
            </div>
            {summary.groups.length === 0 && (
              <p className="empty" style={{ textAlign: 'left', padding: '0 2px 12px' }}>
                No meal slots yet — add your first below.
              </p>
            )}
            {summary.groups.map((g) => (
              <MealGroup
                key={g.slot_id}
                group={g}
                onAddFood={() => navigate('/add')}
                onDelete={(id) => void destroyEntry(id)}
                onEdit={(id) => navigate(`/edit/${id}`)}
              />
            ))}

            <div className="add-slot">
              <input
                className="add-slot-input"
                placeholder="New meal slot name…"
                value={newSlot}
                onChange={(e) => setNewSlot(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void addSlot();
                }}
              />
              <button className="btn outline sm" onClick={() => void addSlot()} disabled={addingSlot || !newSlot.trim()}>
                Add slot
              </button>
            </div>
          </div>

          {/* ── Hydration + Steps (live per-day) ── */}
          <div className="sec" style={{ paddingBottom: 24 }}>
            <div className="sec-h">
              <h2>Hydration</h2>
            </div>
            <div className="card" style={{ padding: '16px 18px' }}>
              <div className="row">
                <span className="v" style={{ fontSize: 20, fontWeight: 700 }}>
                  {formatInt(waterMl)} <small>/ {formatInt(2000)} ml</small>
                </span>
                <span className="sync">
                  <span className="led" />
                  water
                </span>
              </div>
              <div className="movebar"><i style={{ width: `${Math.min(100, (waterMl / 2000) * 100)}%` }} /></div>
              <div className="addmeals">
                <button className="btn outline sm" onClick={() => void upsertMetric({ water_ml: waterMl + 250 })}>+250 ml</button>
                <button className="btn outline sm" onClick={() => void upsertMetric({ water_ml: waterMl + 500 })}>+500 ml</button>
              </div>
            </div>

            <div className="sec-h" style={{ marginTop: 16 }}>
              <h2>Steps</h2>
            </div>
            <div className="card" style={{ padding: '16px 18px' }}>
              <div className="row">
                <span className="v" style={{ fontSize: 20, fontWeight: 700 }}>
                  {formatInt(steps)} <small>/ {formatInt(10000)} steps</small>
                </span>
                <span className="sync"><span className="led" /> manual</span>
              </div>
              <div className="movebar"><i style={{ width: `${Math.min(100, (steps / 10000) * 100)}%` }} /></div>
              <div className="addmeals">
                <button className="btn outline sm" onClick={() => void upsertMetric({ steps: steps + 1000 })}>+1,000</button>
                <button className="btn outline sm" onClick={() => void upsertMetric({ steps: steps + 5000 })}>+5,000</button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
