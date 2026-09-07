/**
 * Modal and Sheet back every overlay in the app — the slot-delete
 * confirmation, Quick add, the scanner, the theme picker, the trends
 * customiser, the date picker. They handled Escape and a scrim click and
 * nothing else: focus could tab out into the covered page behind them.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal } from '../Modal';
import { Sheet } from '../Sheet';

function Harness({ kind }: { kind: 'modal' | 'sheet' }) {
  const [open, setOpen] = useState(false);
  const Overlay = kind === 'modal' ? Modal : Sheet;
  return (
    <div>
      <button onClick={() => setOpen(true)}>open the overlay</button>
      <button>outside button</button>
      <Overlay open={open} onClose={() => setOpen(false)} title="A dialog">
        <button>first inside</button>
        <button>second inside</button>
      </Overlay>
    </div>
  );
}

afterEach(() => cleanup());

describe.each(['modal', 'sheet'] as const)('%s — focus management', (kind) => {
  it('marks itself as a modal dialog', async () => {
    const user = userEvent.setup();
    render(<Harness kind={kind} />);
    await user.click(screen.getByText('open the overlay'));

    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
  });

  it('moves focus inside when it opens', async () => {
    const user = userEvent.setup();
    render(<Harness kind={kind} />);
    await user.click(screen.getByText('open the overlay'));

    await waitFor(() => {
      expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    });
  });

  it('keeps Tab inside the overlay', async () => {
    const user = userEvent.setup();
    render(<Harness kind={kind} />);
    await user.click(screen.getByText('open the overlay'));
    await waitFor(() => expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true));

    // Walk past the end — focus must wrap, never reach the covered page.
    for (let i = 0; i < 8; i++) {
      await user.tab();
      expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    }
  });

  it('wraps backwards too', async () => {
    const user = userEvent.setup();
    render(<Harness kind={kind} />);
    await user.click(screen.getByText('open the overlay'));
    await waitFor(() => expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true));

    for (let i = 0; i < 5; i++) {
      await user.tab({ shift: true });
      expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    }
  });

  it('returns focus to the control that opened it', async () => {
    const user = userEvent.setup();
    render(<Harness kind={kind} />);
    const trigger = screen.getByText('open the overlay');
    await user.click(trigger);
    await waitFor(() => expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true));

    await user.keyboard('{Escape}');

    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('locks the page behind it from scrolling', async () => {
    const user = userEvent.setup();
    render(<Harness kind={kind} />);
    await user.click(screen.getByText('open the overlay'));

    await waitFor(() => expect(document.body.style.overflow).toBe('hidden'));

    await user.keyboard('{Escape}');
    await waitFor(() => expect(document.body.style.overflow).not.toBe('hidden'));
  });
});
