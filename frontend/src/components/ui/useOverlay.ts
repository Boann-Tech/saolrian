import { useEffect, useRef } from 'react';

/** Everything an overlay owes a keyboard or screen-reader user, in one place:
 *  Escape to close, focus moved in on open and returned to the trigger on
 *  close, Tab kept inside, and the page behind it held still.
 *
 *  Modal and Sheet both build on this so the two can't drift apart. */

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement || root.contains(el),
  );
}

export function useOverlay(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  // Remember the trigger before the overlay steals focus.
  useEffect(() => {
    if (!open) return;
    restoreTo.current = document.activeElement as HTMLElement | null;
    const node = ref.current;
    if (node) {
      const first = focusable(node)[0];
      (first ?? node).focus();
    }
    return () => {
      // Only pull focus back if it's still inside the overlay — otherwise the
      // user has already moved on and yanking it would be the rude thing.
      const active = document.activeElement;
      if (!active || active === document.body || ref.current?.contains(active)) {
        restoreTo.current?.focus?.();
      }
    };
  }, [open]);

  // Hold the page behind still. Restores whatever was there rather than
  // assuming '', so nested overlays can't clear each other's lock.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const node = ref.current;
      if (!node) return;
      const items = focusable(node);
      if (items.length === 0) {
        e.preventDefault();
        node.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      // Wrap at both ends, and pull focus back in if it has escaped.
      if (!active || !node.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return ref;
}
