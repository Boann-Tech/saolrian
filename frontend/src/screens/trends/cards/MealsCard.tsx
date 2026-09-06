import { StackedBar } from '../../../components/ui';
import { mealRows } from '../../../lib/trends';
import type { TrendsPayload } from '../../../lib/types';

/** How an average day's calories spread across the user's own meal slots,
 * next to the pct_allocation targets those slots already carry. */
export function MealsCard({ data }: { data: TrendsPayload }) {
  const rows = mealRows(data);

  // data.slots.length === 0 is reachable (tested at line 481 of Trends.test.tsx).
  // rows.length === 0 happens only when loggedDays === 0, which the screen's
  // minDays gate now intercepts — it shows a stub instead of this card when
  // logged days < 7. Defensive-only, but worth keeping to guard against
  // direct component use or future gate changes.
  if (data.slots.length === 0 || rows.length === 0) {
    return <p className="text-sm text-text-faint">No meals to compare yet — add meal slots in Profile and log to them.</p>;
  }

  const total = rows[0].parts.reduce((s, p) => s + p.value, 0);

  return (
    <>
      <StackedBar rows={rows} ariaLabel="Meal distribution" />
      <ul className="mt-3 flex flex-col gap-1">
        {rows[0].parts.map((p, i) => {
          const share = total > 0 ? (p.value / total) * 100 : 0;
          const target = data.slots[i]?.pct_allocation ?? 0;
          return (
            <li key={p.label} className="flex justify-between text-xs">
              <span className="text-text-muted">{p.label}</span>
              <span className="text-text-faint">
                {share.toFixed(0)}%{target > 0 && <> of a {target}% target</>}
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}
