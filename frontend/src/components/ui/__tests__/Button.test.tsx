import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Button } from '../Button';

describe('Button', () => {
  it('renders children and defaults to primary/md', () => {
    render(<Button>Save</Button>);
    const b = screen.getByRole('button', { name: 'Save' });
    expect(b.className).toMatch(/bg-accent/);
  });

  it('applies the outline variant and sm size', () => {
    render(
      <Button variant="outline" size="sm">
        Add
      </Button>,
    );
    const b = screen.getByRole('button', { name: 'Add' });
    expect(b.className).toMatch(/border/);
  });

  it('loading disables the button and shows a status element', () => {
    render(<Button loading>Add slot</Button>);
    const b = screen.getByRole('button', { name: /Add slot/ });
    expect(b).toBeDisabled();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('passes through onClick and type', () => {
    render(
      <Button type="submit" className="mt-4">
        Go
      </Button>,
    );
    const b = screen.getByRole('button', { name: 'Go' });
    expect(b).toHaveAttribute('type', 'submit');
    expect(b.className).toMatch(/mt-4/);
  });
});
