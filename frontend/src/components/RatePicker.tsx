import type { Goal } from '../lib/types';
import { cn } from '../lib/cn';

/** Weekly weight-change rate — the control that actually drives the calorie
 *  target (see lib/nutrition.ts `rateAdjustment`). Native radios keep it
 *  keyboard- and screen-reader-operable; the chips are the visible skin. */

export const LOSE_RATES = [-1, -0.75, -0.5, -0.25] as const;
export const GAIN_RATES = [0.25, 0.5, 0.75, 1] as const;

export function ratesFor(goal: Goal): readonly number[] {
  return goal === 'lose' ? LOSE_RATES : GAIN_RATES;
}

export function RatePicker({
  goal,
  value,
  onChange,
  name = 'goal-rate',
}: {
  goal: Goal;
  /** Signed rate in kg/week — negative for loss. */
  value: number;
  onChange: (rate: number) => void;
  name?: string;
}) {
  if (goal === 'maintain') return null;
  return (
    <fieldset className="mb-[18px] mt-1 border-0 p-0">
      <legend className="mb-2 text-xs font-semibold text-text-muted">
        {goal === 'lose' ? 'Weekly loss target' : 'Weekly gain target'}
      </legend>
      <div className="flex flex-wrap gap-2">
        {ratesFor(goal).map((r) => {
          const on = value === r;
          return (
            <label
              key={r}
              className={cn(
                'cursor-pointer rounded-full border border-border bg-raised px-3.5 py-1.5 text-sm font-semibold text-text-muted transition',
                'focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-accent/40',
                on && 'border-accent-line bg-accent-soft text-accent-ink',
              )}
            >
              <input
                type="radio"
                name={name}
                className="sr-only"
                checked={on}
                onChange={() => onChange(r)}
              />
              {Math.abs(r)} kg/wk
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
