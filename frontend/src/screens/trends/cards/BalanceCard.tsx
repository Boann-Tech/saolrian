import { LineChart } from '../../../components/ui';
import { formatInt } from '../../../lib/format';
import { balanceSeries, sparseLabels } from '../../../lib/trends';
import type { TrendsPayload } from '../../../lib/types';

/** Cumulative energy balance, reconciled against the scale.
 *
 * This is the card that makes the rest of the feature checkable: when the
 * predicted change and the actual change agree, the TDEE estimate is doing its
 * job, and the user can see that for themselves instead of trusting a number. */
export function BalanceCard({ data }: { data: TrendsPayload }) {
  const { values, predictedKg, reference, referenceTdee } = balanceSeries(data);

  const firstEma = data.ema[0]?.kg;
  const lastEma = data.ema.at(-1)?.kg;
  const actualKg = firstEma != null && lastEma != null ? lastEma - firstEma : null;

  if (referenceTdee <= 0) {
    return <p className="text-sm text-text-faint">Needs a TDEE to measure against — set your profile details first.</p>;
  }

  return (
    <>
      <LineChart
        ariaLabel="Cumulative energy balance"
        zeroLine
        labels={sparseLabels(data.days.map((d) => d.date))}
        series={[{ values, tone: 'accent' }]}
      />
      <p className="mt-2 text-sm text-text-muted">
        {formatInt(Math.abs(values.at(-1) ?? 0))} kcal {(values.at(-1) ?? 0) < 0 ? 'deficit' : 'surplus'} so far —
        predicted {predictedKg.toFixed(2)} kg.
        {actualKg != null && <> Actual change on the scale: {actualKg.toFixed(2)} kg.</>}
      </p>
      <p className="mt-1 text-xs text-text-faint">
        Measured against your {reference === 'observed' ? 'observed' : 'formula'} TDEE of{' '}
        {formatInt(referenceTdee)} kcal.
      </p>
    </>
  );
}
