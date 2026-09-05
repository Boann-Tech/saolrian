/** Shared geometry for the hand-rolled SVG charts.
 *
 * Charts are drawn in a fixed viewBox and scaled by CSS, so they are
 * responsive without measuring the DOM. Colour never appears here — every
 * chart paints with `currentColor` and the Tailwind token variables, which is
 * how accent switching and dark mode work with no per-chart code. */

export const VB = { W: 320, H: 140 } as const;

/** Inset so strokes and labels are not clipped by the viewBox edge. */
export const PAD = { top: 8, right: 4, bottom: 18, left: 30 } as const;

export interface Bounds {
  min: number;
  max: number;
}

/** Pad a data range by 5% so the line never touches the frame, and guarantee a
 * non-zero span so scaleY cannot divide by zero on a flat or empty series. */
export function niceBounds(values: number[]): Bounds {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return { min: 0, max: 1 };

  let min = Math.min(...finite);
  let max = Math.max(...finite);

  if (min === max) {
    const bump = Math.abs(min) * 0.05 || 1;
    return { min: min - bump, max: max + bump };
  }

  const pad = (max - min) * 0.05;
  min -= pad;
  max += pad;
  return { min, max };
}

/** Map a value to a y coordinate. SVG y grows downward, so the maximum maps to
 * `top` and the minimum to `bottom`. */
export function scaleY(v: number, min: number, max: number, top: number, bottom: number): number {
  const span = max - min;
  if (span === 0) return (top + bottom) / 2;
  return bottom - ((v - min) / span) * (bottom - top);
}

/** Map index `i` of `n` points to an x coordinate. A lone point is centred
 * rather than pinned to the left edge. */
export function scaleX(i: number, n: number, left: number, right: number): number {
  if (n <= 1) return (left + right) / 2;
  return left + (i / (n - 1)) * (right - left);
}

export function linePath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return '';
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ');
}
