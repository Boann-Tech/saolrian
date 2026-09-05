import { VB, PAD, niceBounds, scaleX, scaleY, linePath } from './scale';

export interface LineSeries {
  /** One value per x position; null leaves a gap rather than drawing zero. */
  values: (number | null)[];
  /** 'accent' follows the user's accent colour; 'muted' is the faint variant. */
  tone?: 'accent' | 'muted';
  dashed?: boolean;
  /** Draw a dot at each non-null value — used for raw weigh-ins. */
  dots?: boolean;
}

/** A minimal multi-series line chart.
 *
 * Every series shares one y scale, which is what lets the weight card overlay
 * the raw weigh-ins, the EMA line and the fitted regression segment and have
 * them line up. */
export function LineChart({
  series,
  labels,
  zeroLine = false,
  ariaLabel,
}: {
  series: LineSeries[];
  /** Sparse x labels, e.g. ['Jun', '', '', 'Jul', ...]. */
  labels?: string[];
  /** Draw a baseline at y=0 — used by the cumulative energy-balance card. */
  zeroLine?: boolean;
  ariaLabel: string;
}) {
  const all = series.flatMap((s) => s.values.filter((v): v is number => v != null));
  const bounds = niceBounds(zeroLine ? [...all, 0] : all);
  const n = Math.max(...series.map((s) => s.values.length), 1);
  const right = VB.W - PAD.right;
  const bottom = VB.H - PAD.bottom;

  const y = (v: number) => scaleY(v, bounds.min, bounds.max, PAD.top, bottom);

  return (
    <svg viewBox={`0 0 ${VB.W} ${VB.H}`} className="h-auto w-full" role="img" aria-label={ariaLabel}>
      {/* axis frame */}
      <line x1={PAD.left} y1={bottom} x2={right} y2={bottom} className="stroke-border" strokeWidth={1} />
      {zeroLine && bounds.min < 0 && bounds.max > 0 && (
        <line x1={PAD.left} y1={y(0)} x2={right} y2={y(0)} className="stroke-border" strokeWidth={1} strokeDasharray="3 3" />
      )}

      {/* y bounds as text, cheaper and clearer than a full axis */}
      <text x={2} y={PAD.top + 8} className="fill-text-faint text-[9px]">{Math.round(bounds.max)}</text>
      <text x={2} y={bottom} className="fill-text-faint text-[9px]">{Math.round(bounds.min)}</text>

      {series.map((s, si) => {
        // Split on nulls so a gap is a gap, not a straight line through it.
        const segments: { x: number; y: number }[][] = [];
        let current: { x: number; y: number }[] = [];
        s.values.forEach((v, i) => {
          if (v == null || !Number.isFinite(v)) {
            if (current.length) segments.push(current);
            current = [];
            return;
          }
          current.push({ x: scaleX(i, n, PAD.left, right), y: y(v) });
        });
        if (current.length) segments.push(current);

        const stroke = s.tone === 'muted' ? 'stroke-text-faint' : 'stroke-accent';
        return (
          <g key={si}>
            {segments.map((seg, gi) => (
              <path
                key={gi}
                data-series-path=""
                d={linePath(seg)}
                fill="none"
                className={stroke}
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray={s.dashed ? '4 3' : undefined}
              />
            ))}
            {s.dots &&
              segments.flat().map((p, pi) => (
                <circle key={pi} cx={p.x} cy={p.y} r={1.8} className={s.tone === 'muted' ? 'fill-text-faint' : 'fill-accent'} />
              ))}
          </g>
        );
      })}

      {labels?.map((l, i) =>
        l ? (
          <text
            key={i}
            x={scaleX(i, n, PAD.left, right)}
            y={VB.H - 4}
            textAnchor="middle"
            className="fill-text-faint text-[9px]"
          >
            {l}
          </text>
        ) : null,
      )}
    </svg>
  );
}
