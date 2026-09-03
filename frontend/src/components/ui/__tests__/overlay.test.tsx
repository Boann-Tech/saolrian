import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal } from '../Modal';
import { Sheet } from '../Sheet';
import { Spinner, Empty, ToastProvider, useToast } from '../feedback';

describe('Modal', () => {
  it('renders when open and closes on Escape', async () => {
    const onClose = vi.fn();
    render(
      <Modal open title="Barcode" onClose={onClose}>
        <p>body</p>
      </Modal>,
    );
    expect(screen.getByRole('dialog', { name: 'Barcode' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('renders nothing when closed', () => {
    render(
      <Modal open={false} title="X" onClose={() => {}}>
        <p>body</p>
      </Modal>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('Sheet', () => {
  it('shows the title and fires onClose from the scrim', async () => {
    const onClose = vi.fn();
    render(
      <Sheet open title="Theme" onClose={onClose}>
        <p>swatches</p>
      </Sheet>,
    );
    expect(screen.getByText('Theme')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('sheet-scrim'));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('feedback', () => {
  it('Spinner exposes a status role', () => {
    render(<Spinner />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('Empty renders its message', () => {
    render(<Empty>Nothing here</Empty>);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
  });

  it('useToast pushes a message that auto-dismisses', () => {
    vi.useFakeTimers();
    function T() {
      const toast = useToast();
      return <button onClick={() => toast('Saved')}>go</button>;
    }
    render(
      <ToastProvider>
        <T />
      </ToastProvider>,
    );
    act(() => {
      screen.getByText('go').click();
    });
    expect(screen.getByText('Saved')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3300);
    });
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    vi.useRealTimers();
  });
});
