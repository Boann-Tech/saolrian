import { Heatmap } from '../../../components/ui';
import { consistencyCells } from '../../../lib/trends';
import type { TrendsPayload } from '../../../lib/types';

/** Which days were logged. Doubles as the honesty check for the TDEE card:
 * a sparse grid is exactly why an estimate gets withheld. */
export function ConsistencyCard({ data }: { data: TrendsPayload }) {
  const cells = consistencyCells(data);
  const logged = cells.filter((c) => c.level > 0).length;

  return (
    <>
      <Heatmap cells={cells} ariaLabel="Logging consistency" />
      <p className="mt-2 text-sm text-text-muted">
        Logged {logged} of {cells.length} days.
      </p>
      <p className="mt-1 text-xs text-text-faint">
        Darker cells are fuller days. Gaps are days with nothing recorded — those are excluded
        from the TDEE estimate rather than counted as zero.
      </p>
    </>
  );
}
