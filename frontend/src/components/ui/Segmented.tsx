import { cn } from '../../lib/cn';

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
  return (
    <div role="tablist" aria-label={ariaLabel} className={cn('flex gap-1.5', className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            role="tab"
            type="button"
            aria-selected={on}
            className={cn(
              'flex-1 rounded-md border-[1.5px] px-0 py-2.5 text-sm font-semibold transition',
              on
                ? 'border-accent bg-accent-soft text-accent-ink'
                : 'border-border bg-raised text-text-muted hover:border-accent-line',
            )}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
