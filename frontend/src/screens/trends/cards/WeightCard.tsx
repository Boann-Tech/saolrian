import { LineChart } from '../../../components/ui';
import { regressionOverlay, sparseLabels } from '../../../lib/trends';
import type { TrendsPayload } from '../../../lib/types';

/** Raw weigh-ins, the EMA trend line, and the fitted regression segment over
 * the estimate window — so the user can see the exact line the TDEE number
 * was derived from rather than taking it on faith. */
export function WeightCard({ data }: { data: TrendsPayload }) {
  const byDate = new Map(data.weights.map((w) => [w.date, w.kg]));
  const emaByDate = new Map(data.ema.map((e) => [e.date, e.kg]));

  const raw = data.days.map((d) => byDate.get(d.date) ?? null);
  const ema = data.days.map((d) => emaByDate.get(d.date) ?? null);
  const fit = regressionOverlay(data);

  if (data.weights.length === 0) {
    return <p className="text-sm text-text-faint">No weigh-ins in this range. Log a weight from Profile.</p>;
  }

  return (
    <>
      <LineChart
        ariaLabel="Weight trend"
        labels={sparseLabels(data.days.map((d) => d.date))}
        series={[
          { values: raw, tone: 'muted', dots: true },
          { values: ema, tone: 'accent' },
          { values: fit, tone: 'accent', dashed: true },
        ]}
      />
      <p className="mt-2 text-xs text-text-faint">
        Dots are weigh-ins, the solid line is the smoothed trend, and the dashed line is the
        fitted rate over the last {data.estimate.window_days} days.
      </p>
    </>
  );
}
