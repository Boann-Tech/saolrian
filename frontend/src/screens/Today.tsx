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

  const load = useCallback(async () => {
    if (!endpoint) return;
    setLoading(true);
    setErr('');
    try {
      const pb = getClient(endpoint);
      const raw = await saolrianSend<Record<string, unknown>>(pb, 'GET', `/api/saolrian/summary?date=${todayISO()}`);
      setSummary(normalizeSummary(raw));
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
              <MealGroup key={g.slot_id} group={g} onAddFood={() => navigate('/add')} />
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

          {/* ── Movement (prototype .move card, static v2 preview) ── */}
          <div className="sec" style={{ paddingBottom: 24 }}>
            <div className="move">
              <div className="cap">Movement</div>
              <div className="row">
                <div className="v">
                  {formatInt(8340)} <small>/ {formatInt(10000)} steps</small>
                </div>
                <div className="sync">
                  <span className="led" />
                  v2 preview
                </div>
              </div>
              <div className="movebar">
                <i />
              </div>
              <div className="move-sync-note">Step tracking arrives in v2 — this card is a preview.</div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
