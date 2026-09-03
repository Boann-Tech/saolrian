import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatTile, Meter, ProgressBar } from '../StatTile';

describe('StatTile', () => {
  it('renders label, value and optional sub', () => {
    render(<StatTile label="Protein" value="80g" sub="/ 150" />);
    expect(screen.getByText('Protein')).toBeInTheDocument();
    expect(screen.getByText('80g')).toBeInTheDocument();
    expect(screen.getByText('/ 150')).toBeInTheDocument();
  });

  it('progress renders a bar with clamped width', () => {
    const { container } = render(<StatTile label="Carbs" value="200g" progress={150} />);
    const fill = container.querySelector('[data-fill]') as HTMLElement;
    expect(fill.style.width).toBe('100%');
  });
});

describe('Meter', () => {
  it('computes percentage and flags over', () => {
    const { container } = render(<Meter value={120} max={100} over />);
    const fill = container.querySelector('[data-fill]') as HTMLElement;
    expect(fill.style.width).toBe('100%');
    expect(fill.className).toMatch(/warn/);
  });
});

describe('ProgressBar', () => {
  it('clamps pct to 0..100', () => {
    const { container } = render(<ProgressBar pct={-5} />);
    const fill = container.querySelector('[data-fill]') as HTMLElement;
    expect(fill.style.width).toBe('0%');
  });
});
