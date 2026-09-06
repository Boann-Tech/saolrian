import { useState } from 'react';
import { BarChart, Segmented } from '../../../components/ui';
import { formatInt } from '../../../lib/format';
import { sparseLabels } from '../../../lib/trends';
import type { TrendsPayload } from '../../../lib/types';

type Macro = 'protein' | 'carbs' | 'fat';

const LABEL: Record<Macro, string> = { protein: 'Protein', carbs: 'Carbs', fat: 'Fat' };

/** Grams per day for one macro at a time, against its target.
 *
 * Absolute grams rather than a percentage split, because a percentage hides
 * the number people actually chase — you cannot tell whether 30% protein was
 * 90 g or 190 g without also knowing the day's calories. */
export function MacrosCard({ data }: { data: TrendsPayload }) {
  const [macro, setMacro] = useState<Macro>('protein');

  const values = data.days.map((d) => (d.logged ? d[macro] : null));
  const target = { protein: data.targets.protein_g, carbs: data.targets.carbs_g, fat: data.targets.fat_g }[macro];
  const logged = values.filter((v): v is number => v != null);
  const mean = logged.length > 0 ? logged.reduce((s, v) => s + v, 0) / logged.length : 0;

  return (
    <>
      <Segmented
        className="mb-3"
        aria-label="Macro"
        value={macro}
        onChange={(v) => setMacro(v)}
        options={[
          { value: 'protein' as const, label: 'Protein' },
          { value: 'carbs' as const, label: 'Carbs' },
          { value: 'fat' as const, label: 'Fat' },
        ]}
      />
      <BarChart
        ariaLabel={`${LABEL[macro]} per day`}
        values={values}
        target={target > 0 ? target : null}
        labels={sparseLabels(data.days.map((d) => d.date))}
      />
      <p className="mt-2 text-sm text-text-muted">
        Averaging {formatInt(mean)} g of {LABEL[macro].toLowerCase()} per logged day
        {target > 0 && <> against a {formatInt(target)} g target</>}.
      </p>
    </>
  );
}
