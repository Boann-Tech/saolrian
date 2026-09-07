import type { ReactNode } from 'react';
import { useOverlay } from './useOverlay';

export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}) {
  const ref = useOverlay(open, onClose);

  return (
    <>
      <div
        data-testid="sheet-scrim"
        className={`sheet-scrim${open ? ' open' : ''}`}
        onClick={onClose}
      />
      <div
        ref={ref}
        tabIndex={-1}
        className={`sheet${open ? ' open' : ''} outline-none`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-hidden={!open}
        inert={!open ? true : undefined}
      >
        <div className="mx-auto mb-4 h-1 w-9 rounded-full bg-border" />
        {title && <h3 className="text-lg font-bold tracking-[-.01em]">{title}</h3>}
        {children}
      </div>
    </>
  );
}
