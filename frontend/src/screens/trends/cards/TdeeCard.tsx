import { useState } from 'react';
import { useApp } from '../../../state/AppContext';
import { getClient } from '../../../lib/pb';
import { formatInt } from '../../../lib/format';
import { Button, useToast } from '../../../components/ui';
import type { TrendsPayload } from '../../../lib/types';

const REASONS: Record<string, (e: TrendsPayload['estimate']) => string> = {
  no_data: () => 'Nothing logged yet in this window.',
  sparse_logging: (e) =>
    `Needs ${Math.ceil(e.window_days * 0.8)} logged days in the last ${e.window_days} — you have ${e.qualifying_days}.`,
  few_weigh_ins: (e) => `Needs 8 weigh-ins in the last ${e.window_days} days — you have ${e.weigh_ins}.`,
  short_span: (e) =>
    `Your weigh-ins only span ${e.span_days} days. Spread them over at least 21 so the trend means something.`,
};

/** Days after which an accepted target is worth rechecking. Roughly half the
 * estimate window: long enough not to nag, short enough that a target set
 * before a real change in body weight gets questioned. */
const STALE_AFTER_DAYS = 14;

/** Whole days between an ISO-ish timestamp and now; null when unparseable. */
function daysSince(raw: string): number | null {
  if (!raw) return null;
  const t = Date.parse(raw.replace(' ', 'T'));
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86400_000);
}

/** The suggestion. Never applies itself: a stretch of half-logged days must
 * not be able to quietly cut someone's target. */
export function TdeeCard({ data, onAccepted }: { data: TrendsPayload; onAccepted: () => void }) {
  const { endpoint } = useApp();
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const est = data.estimate;

  const fromEstimate = data.target_source === 'observed';
  const age = fromEstimate ? daysSince(data.target_set_at) : null;
  const stale = age != null && age >= STALE_AFTER_DAYS;

  /** Write to the single profile row. Both actions need this, and the profile
   * id is not in the payload, so it is looked up once here. */
  const patchProfile = async (patch: Record<string, unknown>, ok: string) => {
    if (!endpoint) return;
    setSaving(true);
    const pb = getClient(endpoint);
    try {
      const profiles = await pb.collection('profiles').getFullList();
      const id = (profiles[0] as { id?: string } | undefined)?.id;
      if (!id) throw new Error('No profile found');
      await pb.collection('profiles').update(id, patch);
      toast(ok);
      onAccepted();
    } catch (ex) {
      toast(ex instanceof Error ? ex.message : 'Could not update your budget', 'err');
    } finally {
      setSaving(false);
    }
  };

  /** Clearing calorie_target hands the budget back to the formula, since
   * userBudget only takes the override branch when the target is > 0. */
  const revert = () =>
    patchProfile(
      { calorie_target: null, calorie_target_source: '', calorie_target_set_at: null },
      'Back to the formula estimate',
    );

  if (!est.sufficient) {
    const explain = REASONS[est.reason] ?? (() => 'Not enough data yet.');
    return (
      <>
        <p className="text-sm text-text-faint">{explain(est)}</p>
        <p className="mt-2 text-xs text-text-faint">
          Until then your budget comes from the Mifflin-St Jeor estimate in your profile.
        </p>
        {/* Someone who accepted an estimate and then let their logging lapse
            still needs a way back to the formula. */}
        {fromEstimate && (
          <div className="mt-3">
            <Button variant="outline" onClick={() => void revert()} disabled={saving}>
              Use the formula instead
            </Button>
          </div>
        )}
      </>
    );
  }

  const apply = () =>
    patchProfile(
      {
        calorie_target: est.suggested_target,
        calorie_target_source: 'observed',
        calorie_target_set_at: new Date().toISOString(),
      },
      'Budget updated from your own data',
    );

  return (
    <>
      <p className="text-2xl font-bold tracking-[-.02em]">
        {formatInt(est.observed_tdee)}{' '}
        <span className="text-sm font-medium text-text-faint">± {formatInt(est.margin)} kcal/day</span>
      </p>
      <p className="mt-1 text-sm text-text-muted">
        Your formula estimate is {data.formula_tdee != null ? formatInt(data.formula_tdee) : '—'} kcal.
        Based on {est.qualifying_days} logged days and {est.weigh_ins} weigh-ins over the last{' '}
        {est.window_days} days, changing {est.slope_kg_per_week.toFixed(2)} kg/week.
      </p>

      {stale && (
        <p className="mt-2 text-sm text-warn">
          Your budget was set from an estimate {age} days ago. Worth a recheck.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button onClick={() => void apply()} disabled={saving}>
          Apply {formatInt(est.suggested_target)} kcal
        </Button>
        {fromEstimate && (
          <Button variant="outline" onClick={() => void revert()} disabled={saving}>
            Use the formula instead
          </Button>
        )}
      </div>

      <p className="mt-2 text-xs text-text-faint">
        Always measured over {est.window_days} days, whatever range the charts are showing.
      </p>
    </>
  );
}
