import { VB, PAD, niceBounds, scaleY } from './scale';

/** Daily bars with an optional target line.
 *
 * A null value draws nothing at all — the distinction between "did not log"
 * and "logged zero calories" is the whole point of the zero-filled payload and
 * must survive into the chart. */
export function BarChart({
  values,
  labels,
  target,
  ariaLabel,
}: {
  values: (number | null)[];
  labels?: string[];
  target?: number | null;
  ariaLabel: string;
}) {
  const present = values.filter((v): v is number => v != null);
  const bounds = niceBounds(target != null ? [0, ...present, target] : [0, ...present]);
  const right = VB.W - PAD.right;
  const bottom = VB.H - PAD.bottom;
  const inner = right - PAD.left;
  const slot = values.length > 0 ? inner / values.length : inner;
  const barW = Math.max(1, slot * 0.7);

  const y = (v: number) => scaleY(v, bounds.min, bounds.max, PAD.top, bottom);
  const zeroY = y(Math.max(bounds.min, 0));

  return (
    <svg viewBox={`0 0 ${VB.W} ${VB.H}`} className="h-auto w-full" role="img" aria-label={ariaLabel}>
      <line x1={PAD.left} y1={bottom} x2={right} y2={bottom} className="stroke-border" strokeWidth={1} />
      <text x={2} y={PAD.top + 8} className="fill-text-faint text-[9px]">{Math.round(bounds.max)}</text>

      {values.map((v, i) => {
        if (v == null) return null;
        const top = y(v);
        return (
          <rect
            key={i}
            data-bar
            x={PAD.left + i * slot + (slot - barW) / 2}
            y={Math.min(top, zeroY)}
            width={barW}
            height={Math.max(1, Math.abs(zeroY - top))}
            rx={1}
            className="fill-accent"
            opacity={0.85}
          />
        );
      })}

      {target != null && (
        <line
          data-target
          x1={PAD.left}
          y1={y(target)}
          x2={right}
          y2={y(target)}
          className="stroke-text-faint"
          strokeWidth={1.2}
          strokeDasharray="4 3"
        />
      )}

      {labels?.map((l, i) =>
        l ? (
          <text key={i} x={PAD.left + i * slot + slot / 2} y={VB.H - 4} textAnchor="middle" className="fill-text-faint text-[9px]">
            {l}
          </text>
        ) : null,
      )}
    </svg>
  );
}
