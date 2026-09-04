import { useEffect } from 'react';
import type { ReactNode } from 'react';

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
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <>
      <div
        data-testid="sheet-scrim"
        className={`sheet-scrim${open ? ' open' : ''}`}
        onClick={onClose}
      />
      <div
        className={`sheet${open ? ' open' : ''}`}
        role="dialog"
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
