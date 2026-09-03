import { cn } from '../../lib/cn';

export function Stepper({
  value,
  onChange,
  step = 1,
  min = -Infinity,
  max = Infinity,
  suffix,
  className,
  'aria-label': ariaLabel,
}: {
  value: number;
  onChange: (n: number) => void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
  className?: string;
  'aria-label'?: string;
}) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  return (
    <div
      className={cn(
        'inline-flex items-center gap-0.5 rounded-md border-[1.5px] border-border bg-raised',
        className,
      )}
      role="group"
      aria-label={ariaLabel}
    >
      <button
        type="button"
        aria-label="decrease"
        className="h-9 w-9 text-md text-text hover:text-accent"
        onClick={() => onChange(clamp(value - step))}
      >
        −
      </button>
      <span className="min-w-[52px] text-center text-sm font-semibold">
        {value}
        {suffix ? ` ${suffix}` : ''}
      </span>
      <button
        type="button"
        aria-label="increase"
        className="h-9 w-9 text-md text-text hover:text-accent"
        onClick={() => onChange(clamp(value + step))}
      >
        +
      </button>
    </div>
  );
}
