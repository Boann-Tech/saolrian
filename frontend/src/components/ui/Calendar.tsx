import { useEffect, useRef, useState } from 'react';
import { addMonths, dateFromOffset, monthGrid, monthTitle, todayISO } from '../../lib/format';
import { cn } from '../../lib/cn';

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

const dayLabel = (iso: string) =>
  new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(iso + 'T12:00:00'));

const monthOf = (iso: string) => iso.slice(0, 7);

/** Month-grid date picker. `value` is the selected ISO day; `onSelect`
 * fires with an ISO day; days after `max` (default today) are disabled.
 * Escape handling is left to the surrounding overlay. */
export function Calendar({
  value,
  onSelect,
  max = todayISO(),
}: {
  value: string;
  onSelect: (iso: string) => void;
  max?: string;
}) {
  const [cursor, setCursor] = useState(() => value.slice(0, 8) + '01');
  const [focused, setFocused] = useState(value);
  const gridRef = useRef<HTMLDivElement>(null);

  // Follow the selection when the parent changes it.
  useEffect(() => {
    setCursor(value.slice(0, 8) + '01');
    setFocused(value);
  }, [value]);

  // Move DOM focus to the focused day, but only once the grid already
  // owns focus — don't steal it when the picker first mounts.
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || !grid.contains(document.activeElement)) return;
    grid.querySelector<HTMLButtonElement>(`[data-date="${focused}"]`)?.focus();
  }, [focused]);

  const moveFocus = (iso: string) => {
    if (iso > max) return;
    setFocused(iso);
    if (monthOf(iso) !== monthOf(cursor)) setCursor(iso.slice(0, 8) + '01');
  };

  // Header arrows: page the month AND pull the focused day into view so
  // the grid keeps a tabbable cell after keyboard navigation.
  const goMonth = (delta: number) => {
    setCursor(addMonths(cursor, delta));
    const day = addMonths(focused, delta);
    setFocused(day > max ? max : day);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    if (e.key in step) {
      e.preventDefault();
      moveFocus(dateFromOffset(step[e.key], focused));
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      moveFocus(addMonths(focused, -1));
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      moveFocus(addMonths(focused, 1));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (focused <= max) onSelect(focused);
    }
  };

  const canGoNext = monthOf(addMonths(cursor, 1)) <= monthOf(max);
  const today = todayISO();

  return (
    <div className="select-none">
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          aria-label="Previous month"
          className="rounded-md p-1.5 text-text-muted hover:bg-surface hover:text-text"
          onClick={() => goMonth(-1)}
        >
          ‹
        </button>
        <span className="text-sm font-bold tracking-[-.01em]">{monthTitle(cursor)}</span>
        <button
          type="button"
          aria-label="Next month"
          disabled={!canGoNext}
          className="rounded-md p-1.5 text-text-muted hover:bg-surface hover:text-text disabled:pointer-events-none disabled:opacity-30"
          onClick={() => goMonth(1)}
        >
          ›
        </button>
      </div>

      <div className="mb-1 grid grid-cols-7 text-center text-2xs font-semibold uppercase tracking-[.05em] text-text-faint">
        {WEEKDAYS.map((d, i) => (
          <span key={i}>{d}</span>
        ))}
      </div>

      <div ref={gridRef} role="grid" onKeyDown={onKeyDown} className="flex flex-col gap-1">
        {monthGrid(cursor).map((week) => (
          <div key={week[0]} role="row" className="grid grid-cols-7 gap-1">
            {week.map((iso) => {
              const inMonth = monthOf(iso) === monthOf(cursor);
              const disabled = iso > max;
              const selected = iso === value;
              return (
                <div key={iso} role="gridcell" aria-selected={selected}>
                  <button
                    type="button"
                    data-date={iso}
                    aria-label={dayLabel(iso)}
                    aria-current={iso === today ? 'date' : undefined}
                    disabled={disabled}
                    tabIndex={iso === focused ? 0 : -1}
                    onClick={() => {
                      setFocused(iso);
                      onSelect(iso);
                    }}
                    className={cn(
                      'aspect-square w-full rounded-lg text-sm font-semibold transition',
                      !inMonth && 'text-text-faint',
                      disabled && 'pointer-events-none opacity-30',
                      selected
                        ? 'bg-accent text-accent-ink'
                        : cn('hover:bg-surface', iso === today && 'ring-1 ring-inset ring-accent-line'),
                    )}
                  >
                    {new Date(iso + 'T12:00:00').getDate()}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
