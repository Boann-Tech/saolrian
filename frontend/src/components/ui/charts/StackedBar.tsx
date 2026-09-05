/** Horizontal 100%-stacked bars, one row per group.
 *
 * Used for meal distribution, where the question is "what share of the day
 * went where", not "how many calories" — so every row normalises to full
 * width. A row summing to zero renders nothing rather than dividing by zero. */
export function StackedBar({
  rows,
  ariaLabel,
}: {
  rows: { label: string; parts: { label: string; value: number }[] }[];
  ariaLabel: string;
}) {
  const ROW_H = 18;
  const GAP = 6;
  const LABEL_W = 64;
  const W = 320;
  const H = Math.max(1, rows.length * (ROW_H + GAP));
  const barW = W - LABEL_W;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={ariaLabel}>
      {rows.map((row, ri) => {
        const total = row.parts.reduce((s, p) => s + p.value, 0);
        const y = ri * (ROW_H + GAP);
        let x = LABEL_W;
        return (
          <g key={row.label}>
            <text x={0} y={y + ROW_H * 0.72} className="fill-text-faint text-[10px]">
              {row.label}
            </text>
            {total > 0 &&
              row.parts.map((p, pi) => {
                const w = (p.value / total) * barW;
                const rect = (
                  <rect
                    key={p.label}
                    data-part
                    x={x}
                    y={y}
                    width={Math.max(0, w)}
                    height={ROW_H}
                    className="fill-accent"
                    opacity={0.3 + (0.7 * (pi + 1)) / row.parts.length}
                  >
                    <title>{`${p.label}: ${Math.round(p.value)} kcal`}</title>
                  </rect>
                );
                x += w;
                return rect;
              })}
          </g>
        );
      })}
    </svg>
  );
}
