import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Card, CardTitle } from '../Card';

describe('Card', () => {
  it('renders a div with raised background and default padding', () => {
    render(<Card>body</Card>);
    const el = screen.getByText('body');
    expect(el.className).toMatch(/bg-raised/);
    expect(el.className).toMatch(/p-4/);
  });

  it('padding="none" drops the padding utility', () => {
    render(<Card padding="none">bare</Card>);
    expect(screen.getByText('bare').className).not.toMatch(/\bp-4\b/);
  });

  it('CardTitle renders a heading and an optional right slot', () => {
    render(<CardTitle right={<span>edit</span>}>Hydration</CardTitle>);
    expect(screen.getByRole('heading', { name: 'Hydration' })).toBeInTheDocument();
    expect(screen.getByText('edit')).toBeInTheDocument();
  });
});
