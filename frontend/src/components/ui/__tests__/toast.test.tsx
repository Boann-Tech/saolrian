/**
 * The toast is the app's only channel for "saved offline", server errors, and
 * (now) undo. It has to wrap long text, announce errors assertively, be
 * dismissible, and be able to carry an action.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider, useToast } from '../feedback';

function Harness({ onReady }: { onReady: (t: ReturnType<typeof useToast>) => void }) {
  const toast = useToast();
  return (
    <button onClick={() => onReady(toast)}>go</button>
  );
}

function renderToast(fire: (t: ReturnType<typeof useToast>) => void) {
  render(
    <ToastProvider>
      <Harness onReady={fire} />
    </ToastProvider>,
  );
  act(() => {
    screen.getByText('go').click();
  });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('toast — errors', () => {
  it('announces errors assertively, not politely', () => {
    renderToast((t) => t('Could not save', 'err'));

    const live = screen.getByText('Could not save').closest('[aria-live]');
    expect(live).toHaveAttribute('aria-live', 'assertive');
  });

  it('announces successes politely', () => {
    renderToast((t) => t('Saved'));

    const live = screen.getByText('Saved').closest('[aria-live]');
    expect(live).toHaveAttribute('aria-live', 'polite');
  });

  it('lets long messages wrap instead of forcing one line', () => {
    renderToast((t) => t('a'.repeat(200), 'err'));

    const bubble = screen.getByText('a'.repeat(200));
    expect(bubble.className).not.toMatch(/whitespace-nowrap/);
  });
});

describe('toast — dismissal', () => {
  it('can be dismissed before it times out', async () => {
    const user = userEvent.setup();
    renderToast((t) => t('Saved'));

    await user.click(screen.getByRole('button', { name: /dismiss/i }));

    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('gives errors longer on screen than successes', () => {
    vi.useFakeTimers();
    renderToast((t) => t('Could not save', 'err'));

    act(() => {
      vi.advanceTimersByTime(3300);
    });
    expect(screen.getByText('Could not save')).toBeInTheDocument();
  });
});

describe('toast — actions', () => {
  it('runs the action and dismisses when the action is tapped', async () => {
    const undo = vi.fn();
    const user = userEvent.setup();
    renderToast((t) => t('Entry deleted', { action: { label: 'Undo', onClick: undo } }));

    await user.click(screen.getByRole('button', { name: 'Undo' }));

    expect(undo).toHaveBeenCalledOnce();
    expect(screen.queryByText('Entry deleted')).not.toBeInTheDocument();
  });

  it('keeps an actionable toast up long enough to act on', () => {
    vi.useFakeTimers();
    renderToast((t) => t('Entry deleted', { action: { label: 'Undo', onClick: () => {} } }));

    act(() => {
      vi.advanceTimersByTime(3300);
    });
    expect(screen.getByText('Entry deleted')).toBeInTheDocument();
  });
});
