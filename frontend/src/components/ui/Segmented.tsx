import { useId } from 'react';
import { cn } from '../../lib/cn';

/** A single-select option group — Goal, Appearance, date range.
 *
 *  Built on native radios: it used to claim role="tablist"/"tab", which
 *  promises arrow-key navigation and a tabpanel that never existed. Radios
 *  give the right announcement and the arrow keys for free. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
  'aria-label': ariaLabel,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  className?: string;
  'aria-label'?: string;
}) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn('flex gap-1.5', className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <label
            key={o.value}
            className={cn(
              'flex flex-1 cursor-pointer items-center justify-center rounded-md border-[1.5px] px-0 py-2.5 text-center text-sm font-semibold transition',
              'min-h-11 focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-accent/40',
              on
                ? 'border-accent bg-accent-soft text-accent-ink'
                : 'border-border bg-raised text-text-muted hover:border-accent-line',
            )}
          >
            <input
              type="radio"
              name={name}
              className="sr-only"
              checked={on}
              onChange={() => onChange(o.value)}
            />
            {o.label}
          </label>
        );
      })}
    </div>
  );
}
