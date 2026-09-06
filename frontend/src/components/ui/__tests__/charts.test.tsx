import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { BarChart } from '../charts/BarChart';
import { Heatmap } from '../charts/Heatmap';
import { StackedBar } from '../charts/StackedBar';

afterEach(cleanup);

describe('BarChart', () => {
  it('renders one bar per value', () => {
    const { container } = render(<BarChart values={[1, 2, 3]} ariaLabel="Test" />);
    expect(container.querySelectorAll('rect[data-bar]')).toHaveLength(3);
  });

  it('omits a bar for a null value rather than drawing zero', () => {
    const { container } = render(<BarChart values={[1, null, 3]} ariaLabel="Test" />);
    expect(container.querySelectorAll('rect[data-bar]')).toHaveLength(2);
  });

  it('draws a target line when given one', () => {
    const { container } = render(<BarChart values={[1, 2]} target={1.5} ariaLabel="Test" />);
    expect(container.querySelector('line[data-target]')).not.toBeNull();
  });

  it('is labelled for screen readers', () => {
    render(<BarChart values={[1]} ariaLabel="Intake vs budget" />);
    expect(screen.getByRole('img', { name: 'Intake vs budget' })).toBeTruthy();
  });

  it('survives an empty series', () => {
    const { container } = render(<BarChart values={[]} ariaLabel="Test" />);
    expect(container.querySelectorAll('rect[data-bar]')).toHaveLength(0);
  });
});

describe('Heatmap', () => {
  it('renders one cell per day', () => {
    const cells = [
      { date: '2026-01-01', level: 0 as const },
      { date: '2026-01-02', level: 3 as const },
    ];
    const { container } = render(<Heatmap cells={cells} ariaLabel="Consistency" />);
    expect(container.querySelectorAll('rect[data-cell]')).toHaveLength(2);
  });

  it('maps each level to its own fill class and opacity, not a transposed or off-by-one mapping', () => {
    const cells = [
      { date: '2026-01-01', level: 0 as const },
      { date: '2026-01-02', level: 1 as const },
      { date: '2026-01-03', level: 2 as const },
      { date: '2026-01-04', level: 3 as const },
    ];
    const { container } = render(<Heatmap cells={cells} ariaLabel="Consistency" />);
    const rects = Array.from(container.querySelectorAll('rect[data-cell]'));
    expect(rects).toHaveLength(4);

    // level 0: unlogged day — empty surface, fully opaque so the gap itself is visible
    expect(rects[0].getAttribute('class')).toContain('fill-surface');
    expect(rects[0].getAttribute('opacity')).toBe('1');

    // levels 1-3: increasing logging completeness, same accent fill, rising opacity
    expect(rects[1].getAttribute('class')).toContain('fill-accent');
    expect(rects[1].getAttribute('opacity')).toBe('0.35');

    expect(rects[2].getAttribute('class')).toContain('fill-accent');
    expect(rects[2].getAttribute('opacity')).toBe('0.65');

    expect(rects[3].getAttribute('class')).toContain('fill-accent');
    expect(rects[3].getAttribute('opacity')).toBe('1');
  });

  it('lays out cells in week columns: the 8th cell starts a new column at the top row', () => {
    const cells = Array.from({ length: 8 }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      level: 0 as const,
    }));
    const { container } = render(<Heatmap cells={cells} ariaLabel="Consistency" />);
    const rects = Array.from(container.querySelectorAll('rect[data-cell]'));
    expect(rects).toHaveLength(8);

    const first = rects[0];
    const eighth = rects[7];

    // First cell sits at the top-left of the grid.
    expect(first.getAttribute('x')).toBe('0');
    expect(first.getAttribute('y')).toBe('0');

    // The 8th cell (index 7, one past a full 7-row column) wraps to a new
    // column: same top row (y back to 0), x advanced by exactly one column
    // step. A row/column swap would instead put it at y > 0, x === 0.
    const cellStep = Number(first.getAttribute('width')) + 2; // CELL + GAP
    expect(Number(eighth.getAttribute('x'))).toBeCloseTo(Number(first.getAttribute('x')) + cellStep);
    expect(eighth.getAttribute('y')).toBe('0');
  });

  it('renders no cells and a valid non-degenerate viewBox for zero cells', () => {
    const { container } = render(<Heatmap cells={[]} ariaLabel="Consistency" />);
    expect(container.querySelectorAll('rect[data-cell]')).toHaveLength(0);

    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    const viewBox = svg!.getAttribute('viewBox') ?? '';
    expect(viewBox).not.toContain('NaN');
    const [, , w, h] = viewBox.split(' ').map(Number);
    expect(w).toBeGreaterThan(0);
    expect(h).toBeGreaterThan(0);
  });
});

describe('StackedBar', () => {
  it('renders a segment per part', () => {
    const rows = [{ label: 'Mon', parts: [{ label: 'Breakfast', value: 300 }, { label: 'Lunch', value: 700 }] }];
    const { container } = render(<StackedBar rows={rows} ariaLabel="Meals" />);
    expect(container.querySelectorAll('rect[data-part]')).toHaveLength(2);
  });

  it('ignores a row whose parts sum to zero without dividing by zero', () => {
    const rows = [{ label: 'Mon', parts: [{ label: 'Breakfast', value: 0 }] }];
    const { container } = render(<StackedBar rows={rows} ariaLabel="Meals" />);
    expect(container.querySelectorAll('rect[data-part]')).toHaveLength(0);
  });
});
