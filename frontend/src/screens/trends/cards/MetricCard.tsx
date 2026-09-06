import { BarChart } from '../../../components/ui';
import { formatInt } from '../../../lib/format';
import { movingAverage, sparseLabels } from '../../../lib/trends';
import type { TrendsPayload } from '../../../lib/types';

/** Water and steps are the same shape — a daily value against a flat target
 * with a rolling average — so they share one component rather than two files
 * that drift apart. */
export function MetricCard({ data, metric }: { data: TrendsPayload; metric: 'water' | 'steps' }) {
  const values = data.days.map((d) => {
    // No separate "recorded" flag for these metrics — the backend zero-fills
    // days with no water/steps row the same as a genuine 0, and `d.logged`
    // tracks food entries only, so it must not be used to gate these values.
    const v = metric === 'water' ? d.water_ml : d.steps;
    return v > 0 ? v : null;
  });
  const target = metric === 'water' ? data.targets.water_ml : data.targets.steps;
  const unit = metric === 'water' ? 'ml' : 'steps';
  const noun = metric === 'water' ? 'water' : 'steps';

  const present = values.filter((v): v is number => v != null);
  const mean = present.length > 0 ? present.reduce((s, v) => s + v, 0) / present.length : 0;
  const avg7 = movingAverage(values, 7).at(-1);

  return (
    <>
      <BarChart
        ariaLabel={metric === 'water' ? 'Water per day' : 'Steps per day'}
        values={values}
        target={target > 0 ? target : null}
        labels={sparseLabels(data.days.map((d) => d.date))}
      />
      <p className="mt-2 text-sm text-text-muted">
        Averaging {formatInt(mean)} {unit} on the {present.length} days you recorded any {noun}
        {target > 0 && (
          <>
            , against a {formatInt(target)} {unit} target
          </>
        )}
        .
      </p>
      {avg7 != null && (
        <p className="mt-1 text-xs text-text-faint">
          Last 7 days: {formatInt(avg7)} {unit}.
        </p>
      )}
    </>
  );
}
