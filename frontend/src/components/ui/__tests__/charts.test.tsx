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
