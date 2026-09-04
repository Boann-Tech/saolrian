import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

const clamp = (n: number) => Math.min(100, Math.max(0, n));

export function ProgressBar({ pct, tone = 'accent' }: { pct: number; tone?: 'accent' | 'good' }) {
  return (
    <div className="mt-2 h-[3px] overflow-hidden rounded-full bg-border">
      <div
        data-fill
        className={cn(
          'h-full rounded-full transition-[width] duration-500 ease-out',
          tone === 'good' ? 'bg-good' : 'bg-accent',
        )}
        style={{ width: `${clamp(pct)}%` }}
      />
    </div>
  );
}

export function StatTile({
  label,
  value,
  sub,
  progress,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  progress?: number;
}) {
  return (
    <div className="min-w-0 flex-1 rounded-lg border border-border bg-surface p-3.5 transition hover:shadow-pop">
      <div className="text-2xs font-semibold uppercase tracking-[.04em] text-text-faint">{label}</div>
      <div className="mt-1 truncate text-lg font-bold tracking-[-.01em]">
        {value} {sub && <small className="text-2xs font-medium text-text-faint">{sub}</small>}
      </div>
      {progress != null && <ProgressBar pct={progress} />}
    </div>
  );
}

export function Meter({ value, max, over }: { value: number; max: number; over?: boolean }) {
  const pct = max > 0 ? clamp(Math.round((value / max) * 100)) : 0;
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-accent-soft">
      <div
        data-fill
        className={cn(
          'h-full rounded-full transition-[width] duration-500 ease-out',
          over ? 'bg-warn' : 'bg-accent',
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
