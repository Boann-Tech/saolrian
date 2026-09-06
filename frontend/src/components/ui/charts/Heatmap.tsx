/** Calendar heatmap of logging consistency, laid out in week columns.
 *
 * Level 0 is "nothing logged" and renders as an empty cell, so a gap in the
 * grid reads as a gap in the data — the same honesty rule the charts follow. */
export function Heatmap({
  cells,
  ariaLabel,
}: {
  cells: { date: string; level: 0 | 1 | 2 | 3 }[];
  ariaLabel: string;
}) {
  const CELL = 11;
  const GAP = 2;
  const rows = 7;
  const cols = Math.ceil(cells.length / rows) || 1;
  const w = cols * (CELL + GAP);
  const h = rows * (CELL + GAP);

  const fill = ['fill-surface', 'fill-accent', 'fill-accent', 'fill-accent'] as const;
  const opacity = [1, 0.35, 0.65, 1] as const;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-auto w-full" role="img" aria-label={ariaLabel}>
      {cells.map((c, i) => (
        <rect
          key={c.date}
          data-cell
          x={Math.floor(i / rows) * (CELL + GAP)}
          y={(i % rows) * (CELL + GAP)}
          width={CELL}
          height={CELL}
          rx={2}
          className={fill[c.level]}
          opacity={opacity[c.level]}
          stroke="currentColor"
          strokeOpacity={0.08}
        >
          <title>{c.date}</title>
        </rect>
      ))}
    </svg>
  );
}
