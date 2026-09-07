import type { ReactNode } from 'react';
import { useOverlay } from './useOverlay';

export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useOverlay(open, onClose);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[rgba(10,37,64,.32)] px-4 pb-4 pt-[6vh]"
      onClick={onClose}
    >
      <div
        ref={ref}
        tabIndex={-1}
        className="w-full max-w-[480px] rounded-xl border border-border bg-raised p-4 shadow-sheet outline-none"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-md font-bold">{title}</h3>
          <button
            className="rounded-md p-2 text-text-faint hover:bg-surface hover:text-text"
            onClick={onClose}
            aria-label="Close"
          >
            &#10005;
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
