import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp, saolrianSend } from '../state/AppContext';
import type { Summary } from '../lib/types';
import { todayISO, greeting, formatInt } from '../lib/format';
import { getClient } from '../lib/pb';
import { normalizeSummary } from '../lib/normalize';
import { MealGroup } from '../components/MealGroup';
import { Button, Card, CardTitle, Empty, Spinner, useToast } from '../components/ui';
import './today.css';

/** Today dashboard: calorie hero, macro tiles, meal groups, move card. */

export default function Today() {
  const { endpoint, slots, refreshSlots } = useApp();
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

  return (
    <div className="today">
      <h1 className="today-hello">
        {greeting()}
        <span className="today-date">{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</span>
      </h1>

      {loading && (
        <div className="today-loading">
          <Spinner /> Loading your day…
        </div>
      )}

      {!loading && err && (
        <Card className="today-err">
          <p>{err}</p>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            Retry
          </Button>
        </Card>
      )}

      {!loading && summary && (
        <>
          {/* Calorie hero */}
          <Card className="hero">
            <div className="hero-row">
              <div>
                <div className="hero-label">Calories today</div>
                <div className="hero-big">
                  {formatInt(eaten)}
                  <span className="hero-unit"> kcal</span>
                </div>
                <div className="hero-sub">
                  {budget == null
                    ? 'Set a calorie target in Profile to see your budget'
                    : over
                      ? `${formatInt(-remaining!)} over budget`
                      : `${formatInt(remaining!)} kcal left of ${formatInt(budget)}`}
                </div>
              </div>
              {budget != null && (
                <div className={`hero-pct ${over ? 'hero-over' : ''}`}>{pct}%</div>
              )}
            </div>
            {budget != null && (
              <div className="hero-bar">
                <div
                  className={over ? 'hero-fill hero-fill-over' : 'hero-fill'}
                  style={{ width: `${pct}%` }}
                />
              </div>
            )}
          </Card>

          {/* Macro tiles */}
          <div className="macros">
            {(
              [
                ['Protein', summary.totals.protein, 'g'],
                ['Carbs', summary.totals.carbs, 'g'],
                ['Fat', summary.totals.fat, 'g'],
              ] as const
            ).map(([label, val, unit]) => (
              <Card key={label} className="macro">
                <div className="macro-label">{label}</div>
                <div className="macro-val">
                  {formatInt(val)}
                  <span className="macro-unit"> {unit}</span>
                </div>
                <div className="macro-bar">
                  <div className="macro-fill" style={{ width: `${Math.min(100, (val / 150) * 100)}%` }} />
                </div>
              </Card>
            ))}
          </div>

          {/* Meals */}
          <Card>
            <CardTitle
              right={
                <Button variant="ghost" size="sm" onClick={() => navigate('/add')}>
                  + Add food
                </Button>
              }
            >
              Meals
            </CardTitle>
            {summary.groups.length === 0 && <Empty>No meal slots yet — add your first below.</Empty>}
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
              <Button size="sm" onClick={() => void addSlot()} disabled={addingSlot || !newSlot.trim()}>
                Add slot
              </Button>
            </div>
          </Card>

          {/* Move card (static v2 placeholder) */}
          <Card className="move">
            <CardTitle>Move</CardTitle>
            <div className="move-row">
              <div className="move-ring" aria-hidden>
                <svg viewBox="0 0 72 72">
                  <circle cx="36" cy="36" r="30" className="move-track" />
                  <circle
                    cx="36"
                    cy="36"
                    r="30"
                    className="move-progress"
                    strokeDasharray={`${(8340 / 10000) * 188.5} 188.5`}
                  />
                </svg>
                <span className="move-pct">83%</span>
              </div>
              <div className="move-info">
                <div className="move-steps">
                  {formatInt(8340)}
                  <span className="move-unit"> / {formatInt(10000)} steps</span>
                </div>
                <div className="move-sub">Step tracking arrives in v2 — this card is a preview.</div>
              </div>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
