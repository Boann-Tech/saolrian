import { BarChart } from '../../../components/ui';
import { formatInt } from '../../../lib/format';
import { intakeSeries, movingAverage, sparseLabels } from '../../../lib/trends';
import type { TrendsPayload } from '../../../lib/types';

/** Daily intake against the budget. Days with nothing logged draw no bar at
 * all — a missing day is missing data, not a zero-calorie day. */
export function IntakeCard({ data }: { data: TrendsPayload }) {
  const { values, budget } = intakeSeries(data);
  const avg7 = movingAverage(values, 7);
  const logged = values.filter((v): v is number => v != null);
  const mean = logged.length > 0 ? logged.reduce((s, v) => s + v, 0) / logged.length : 0;

  return (
    <>
      <BarChart
        ariaLabel="Intake vs budget"
        values={values}
        target={budget}
        labels={sparseLabels(data.days.map((d) => d.date))}
      />
      <p className="mt-2 text-sm text-text-muted">
        Averaging {formatInt(mean)} kcal across {logged.length} logged days
        {budget != null && <> against a {formatInt(budget)} kcal budget</>}.
      </p>
      <p className="mt-1 text-xs text-text-faint">
        7-day average today: {avg7.at(-1) != null ? `${formatInt(avg7.at(-1) as number)} kcal` : '—'}.
      </p>
    </>
  );
}
