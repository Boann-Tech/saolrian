import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { LineChart } from '../charts/LineChart';

function seriesPaths(container: HTMLElement) {
  return Array.from(container.querySelectorAll('[data-series-path]'));
}

describe('LineChart', () => {
  it('renders a single path when there are no gaps', () => {
    const { container } = render(
      <LineChart series={[{ values: [80, 81, 82] }]} ariaLabel="test" />,
    );
    const paths = seriesPaths(container);
    expect(paths).toHaveLength(1);
    expect(paths[0].getAttribute('d')).not.toMatch(/NaN/);
  });

  it('splits an interior null into two separate path segments, not one bridged line', () => {
    const { container } = render(
      <LineChart series={[{ values: [80, null, 82] }]} ariaLabel="test" />,
    );
    const paths = seriesPaths(container);
    expect(paths).toHaveLength(2);
    for (const p of paths) {
      expect(p.getAttribute('d')).not.toMatch(/NaN/);
    }
  });

  it('drops a leading null without producing a stray empty or malformed path', () => {
    const { container } = render(
      <LineChart series={[{ values: [null, 80, 82] }]} ariaLabel="test" />,
    );
    const paths = seriesPaths(container);
    expect(paths).toHaveLength(1);
    const d = paths[0].getAttribute('d');
    expect(d).not.toBe('');
    expect(d).not.toMatch(/NaN/);
  });

  it('still renders the segment before a trailing null', () => {
    const { container } = render(
      <LineChart series={[{ values: [80, 82, null] }]} ariaLabel="test" />,
    );
    const paths = seriesPaths(container);
    expect(paths).toHaveLength(1);
    const d = paths[0].getAttribute('d');
    expect(d).not.toBe('');
    expect(d).not.toMatch(/NaN/);
  });

  it('treats a NaN value the same as a null, breaking the segment', () => {
    const { container } = render(
      <LineChart series={[{ values: [80, NaN, 82] }]} ariaLabel="test" />,
    );
    const paths = seriesPaths(container);
    expect(paths).toHaveLength(2);
    for (const p of paths) {
      expect(p.getAttribute('d')).not.toMatch(/NaN/);
    }
  });
});
