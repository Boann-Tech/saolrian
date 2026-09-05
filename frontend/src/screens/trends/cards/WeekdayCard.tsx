import { BarChart } from '../../../components/ui';
import { formatInt } from '../../../lib/format';
import { weekdayAverages } from '../../../lib/trends';
import type { TrendsPayload } from '../../../lib/types';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Average intake by day of the week — the card that finds weekend drift. */
export function WeekdayCard({ data }: { data: TrendsPayload }) {
  const avgs = weekdayAverages(data);
  // avgs is already null for a weekday that was never logged; a weekday
  // whose true average is exactly 0 kcal is real data and must still chart —
  // it must not be masked back down to "absent" here.
  const present = avgs.filter((v): v is number => v != null);
  const spread = present.length > 1 ? Math.max(...present) - Math.min(...present) : 0;

  return (
    <>
      <BarChart ariaLabel="Average intake by weekday" values={avgs} target={data.budget} labels={DAYS} />
      <p className="mt-2 text-sm text-text-muted">
        {spread > 0
          ? `${formatInt(spread)} kcal between your heaviest and lightest day of the week.`
          : 'Not enough logged days yet to compare weekdays.'}
      </p>
    </>
  );
}
