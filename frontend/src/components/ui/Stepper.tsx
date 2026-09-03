import { useEffect, useState } from 'react';
import { cn } from '../../lib/cn';

export function Stepper({
  value,
  onChange,
  step = 1,
  min = -Infinity,
  max = Infinity,
  suffix,
  inputMode = 'numeric',
  className,
  'aria-label': ariaLabel,
}: {
  value: number;
  onChange: (n: number) => void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
  /** Character set the editable field accepts. Default 'numeric' (digits only). */
  inputMode?: 'numeric' | 'decimal';
  className?: string;
  'aria-label'?: string;
}) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  const strip = inputMode === 'decimal' ? /[^\d.]/g : /\D/g;

  /* The middle value is directly editable — type an exact quantity (e.g. 137 g).
   * `draft` holds what the user sees while typing; it re-syncs whenever the
   * `value` prop changes to something the draft doesn't already represent
   * (± buttons, parent resets). */
  const [draft, setDraft] = useState(() => String(value));
  useEffect(() => {
    setDraft((d) => (Number(d) === value ? d : String(value)));
  }, [value]);

  const handleChange = (raw: string) => {
    const cleaned = raw.replace(strip, '');
    setDraft(cleaned);
    if (cleaned === '' || cleaned === '.') return;
    const parsed = Number(cleaned);
    if (Number.isFinite(parsed)) onChange(clamp(parsed));
  };

  const commit = () => {
    const parsed = Number(draft.replace(strip, ''));
    const next = clamp(Number.isFinite(parsed) ? parsed : value);
    onChange(next);
    setDraft(String(next));
  };

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
      <span className="inline-flex min-w-[52px] items-center justify-center text-sm font-semibold">
        <input
          type="text"
          inputMode={inputMode}
          aria-label={ariaLabel}
          className="w-[3ch] min-w-0 flex-none bg-transparent text-center text-sm font-semibold text-text outline-none"
          value={draft}
          onChange={(e) => handleChange(e.target.value)}
          onBlur={commit}
        />
        {suffix ? <span className="pl-0.5">{suffix}</span> : null}
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
