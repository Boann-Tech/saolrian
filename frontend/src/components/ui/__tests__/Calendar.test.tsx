import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Calendar } from '../Calendar';

const props = { value: '2026-09-03', max: '2026-09-05' };

describe('Calendar', () => {
  it('opens on the month of the selected value', () => {
    render(<Calendar {...props} onSelect={() => {}} />);
    expect(screen.getByText('September 2026')).toBeInTheDocument();
  });

  it('calls onSelect with the ISO date of a clicked day', async () => {
    const onSelect = vi.fn();
    render(<Calendar {...props} onSelect={onSelect} />);
    await userEvent.click(screen.getByRole('button', { name: /September 2, 2026/ }));
    expect(onSelect).toHaveBeenCalledWith('2026-09-02');
  });

  it('steps the visible month backward and forward', async () => {
    render(<Calendar {...props} onSelect={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(screen.getByText('August 2026')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Next month' }));
    expect(screen.getByText('September 2026')).toBeInTheDocument();
  });

  it('will not navigate past the month containing max', () => {
    render(<Calendar {...props} onSelect={() => {}} />);
    expect(screen.getByRole('button', { name: 'Next month' })).toBeDisabled();
  });

  it('disables days after max', async () => {
    const onSelect = vi.fn();
    render(<Calendar {...props} onSelect={onSelect} />);
    const future = screen.getByRole('button', { name: /September 6, 2026/ });
    expect(future).toBeDisabled();
    await userEvent.click(future);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('moves the focused day with arrow keys and selects on Enter', async () => {
    const onSelect = vi.fn();
    render(<Calendar {...props} onSelect={onSelect} />);
    screen.getByRole('button', { name: /September 3, 2026/ }).focus();
    await userEvent.keyboard('{ArrowLeft}{Enter}');
    expect(onSelect).toHaveBeenCalledWith('2026-09-02');
  });

  it('marks the selected day with aria-selected', () => {
    render(<Calendar {...props} onSelect={() => {}} />);
    const cell = screen
      .getByRole('button', { name: /September 3, 2026/ })
      .closest('[role="gridcell"]');
    expect(cell).toHaveAttribute('aria-selected', 'true');
  });
});
