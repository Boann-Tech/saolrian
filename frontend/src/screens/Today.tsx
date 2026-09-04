import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp, saolrianSend } from '../state/AppContext';
import type { Summary } from '../lib/types';
import { todayISO, greeting, formatInt } from '../lib/format';
import { getClient } from '../lib/pb';
import { normalizeSummary } from '../lib/normalize';
import { MealGroup } from '../components/MealGroup';
import { Button, Card, CardTitle, Empty, Meter, ProgressBar, Spinner, StatTile, TextInput, useToast } from '../components/ui';
import { cn } from '../lib/cn';

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
  const [savingMetric, setSavingMetric] = useState(false);

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
    if (savingMetric) return;
    setSavingMetric(true);
    const pb = getClient(endpoint);
    try {
      const uid = pb.authStore.record?.id;
      if (!uid) return;
      const list = await pb.collection('daily_metrics').getFullList({
        filter: `user="${uid}" && date~"${todayISO()}"`,
      });
      const next = {
        user: uid,
        date: todayISO(),
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
    } catch (ex) {
      toast(ex instanceof Error ? ex.message : 'Could not update metric', 'err');
    } finally {
      setSavingMetric(false);
    }
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
    <div className="pb-2">
      {/* ── Hero (prototype: brandline, greeting, date, balance) ── */}
      <section className="hero border-b border-border px-6 pb-6 pt-5">
        <div className="flex items-center gap-2 text-xs font-bold tracking-[.02em]">
          <span className="h-2.5 w-2.5 rounded-[3px] bg-accent" />
          SAOLRIAN
        </div>
        <h1 className="mt-3 text-2xl font-bold leading-[1.15] tracking-[-.022em]">
          {greeting()}, <em className="italic text-accent [font-family:'Fraunces','Georgia',serif]">{firstName || 'there'}</em>
        </h1>
        <div className="mt-1.5 text-sm text-text-faint">
          {new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
        </div>

        <Card as="section" className="relative z-10 mt-5 flex items-center justify-between">
          <div>
            <div className="text-2xs font-semibold uppercase tracking-[.05em] text-text-faint">Calories today</div>
            <div className="mt-0.5 text-2xl font-bold tracking-[-.02em]">
              {formatInt(eaten)}{' '}
              <small className="text-base font-medium text-text-muted">
                / {budget != null ? formatInt(budget) : '—'}
              </small>
            </div>
          </div>
          {budget != null && (
            <div
              className={cn(
                'rounded-full px-3 py-1.5 text-right text-sm font-semibold',
                over ? 'bg-warn-soft text-warn' : 'bg-good/12 text-good-ink',
              )}
            >
              {over ? `${formatInt(-remaining!)} over` : `${formatInt(remaining!)} left`}
              <small className="mt-0.5 block text-2xs font-medium text-text-faint">
                {pct}% of budget{over ? ' — over' : ''}
              </small>
            </div>
          )}
        </Card>
      </section>

      {loading && (
        <div className="flex items-center gap-2 px-6 py-5 text-sm text-text-muted">
          <Spinner /> Loading your day…
        </div>
      )}

      {!loading && err && (
        <div className="px-6 pt-5">
          <Card role="alert">
            <p>{err}</p>
            <Button variant="outline" className="mt-2.5" onClick={() => void load()}>
              Retry
            </Button>
          </Card>
        </div>
      )}

      {!loading && summary && (
        <>
          {/* ── Meter (prototype: full-width track + cap row) ── */}
          <div className="px-6 pt-4">
            <Meter value={eaten} max={budget ?? 0} over={over} />
            <div className="mt-2 flex justify-between text-xs font-medium text-text-faint">
              <span>
                <b className="font-semibold text-text">{pct}%</b> used
              </span>
              <span>{budget != null ? `budget ${formatInt(budget)} kcal` : 'no budget set'}</span>
            </div>
          </div>

          {/* ── Macros (prototype .stats tiles with mini bars) ── */}
          <section className="px-6 pt-5">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-md font-bold tracking-[-.01em]">Macros</h2>
              <button
                className="text-sm font-semibold text-accent hover:underline"
                onClick={() => navigate('/profile')}
              >
                Adjust
              </button>
            </div>
            <div className="flex gap-2.5">
              {(
                [
                  ['Protein', summary.totals.protein],
                  ['Carbs', summary.totals.carbs],
                  ['Fat', summary.totals.fat],
                ] as const
              ).map(([label, val]) => (
                <StatTile key={label} label={label} value={`${formatInt(val)}g`} sub="/ 150" progress={(val / 150) * 100} />
              ))}
            </div>
          </section>

          {/* ── Meals (prototype .mealgrp groups) ── */}
          <section className="px-6 pt-5">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-md font-bold tracking-[-.01em]">Today’s meals</h2>
              <button
                className="text-sm font-semibold text-accent hover:underline"
                onClick={() => navigate('/add')}
              >
                + Add food
              </button>
            </div>
            {summary.groups.length === 0 && (
              <Empty align="left">No meal slots yet — add your first below.</Empty>
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

            <div className="mt-3.5 flex gap-2">
              <TextInput
                className="min-w-0 flex-1"
                placeholder="New meal slot name…"
                value={newSlot}
                onChange={(e) => setNewSlot(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void addSlot();
                }}
              />
              <Button
                variant="outline"
                size="sm"
                loading={addingSlot}
                disabled={!newSlot.trim()}
                onClick={() => void addSlot()}
              >
                Add slot
              </Button>
            </div>
          </section>

          {/* ── Hydration + Steps (live per-day) ── */}
          <section className="px-6 pb-6 pt-5">
            <Card>
              <CardTitle>Hydration</CardTitle>
              <div className="flex items-baseline justify-between">
                <span className="text-xl font-bold">
                  {formatInt(waterMl)} <small className="text-sm font-medium text-text-faint">/ {formatInt(2000)} ml</small>
                </span>
                <span className="flex items-center gap-1.5 text-xs font-semibold text-good-ink">
                  <span className="h-[7px] w-[7px] rounded-full bg-good shadow-[0_0_6px_rgba(62,207,142,.8)]" />
                  water
                </span>
              </div>
              <ProgressBar pct={(waterMl / 2000) * 100} tone="good" />
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={savingMetric}
                  onClick={() => void upsertMetric({ water_ml: waterMl + 250 })}
                >
                  +250 ml
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={savingMetric}
                  onClick={() => void upsertMetric({ water_ml: waterMl + 500 })}
                >
                  +500 ml
                </Button>
              </div>
            </Card>

            <Card className="mt-4">
              <CardTitle>Steps</CardTitle>
              <div className="flex items-baseline justify-between">
                <span className="text-xl font-bold">
                  {formatInt(steps)} <small className="text-sm font-medium text-text-faint">/ {formatInt(10000)} steps</small>
                </span>
                <span className="flex items-center gap-1.5 text-xs font-semibold text-good-ink">
                  <span className="h-[7px] w-[7px] rounded-full bg-good shadow-[0_0_6px_rgba(62,207,142,.8)]" />
                  manual
                </span>
              </div>
              <ProgressBar pct={(steps / 10000) * 100} tone="good" />
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={savingMetric}
                  onClick={() => void upsertMetric({ steps: steps + 1000 })}
                >
                  +1,000
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={savingMetric}
                  onClick={() => void upsertMetric({ steps: steps + 5000 })}
                >
                  +5,000
                </Button>
              </div>
            </Card>
          </section>
        </>
      )}
    </div>
  );
}
