import { createContext, useCallback, useContext, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export function Spinner({
  size = 'sm',
  tone = 'accent',
}: {
  size?: 'sm' | 'md';
  tone?: 'accent' | 'onAccent';
}) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn(
        'inline-block animate-spin rounded-full border-2',
        size === 'sm' ? 'h-3.5 w-3.5' : 'h-5 w-5',
        tone === 'onAccent'
          ? 'border-white/40 border-t-white'
          : 'border-border border-t-accent',
      )}
    />
  );
}

export function Empty({
  children,
  align = 'center',
}: {
  children: ReactNode;
  align?: 'center' | 'left';
}) {
  return (
    <div className={cn('py-3.5 text-sm text-text-faint', align === 'center' ? 'text-center' : 'text-left')}>
      {children}
    </div>
  );
}

interface ToastMsg {
  id: number;
  text: string;
  kind: 'ok' | 'err';
}
const ToastCtx = createContext<(text: string, kind?: 'ok' | 'err') => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastMsg[]>([]);
  const nextId = useRef(1);
  const push = useCallback((text: string, kind: 'ok' | 'err' = 'ok') => {
    const id = nextId.current++;
    setItems((t) => [...t, { id, text, kind }]);
    window.setTimeout(() => setItems((t) => t.filter((m) => m.id !== id)), 3200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div
        className="pointer-events-none fixed left-1/2 z-40 flex -translate-x-1/2 flex-col items-center gap-2"
        style={{ bottom: 'calc(104px + env(safe-area-inset-bottom))' }}
        aria-live="polite"
      >
        {items.map((m) => (
          <div
            key={m.id}
            className={cn(
              'max-w-[92vw] whitespace-nowrap rounded-full px-4 py-2 text-xs font-medium text-white shadow-sheet',
              m.kind === 'err' ? 'bg-danger' : 'bg-text',
            )}
          >
            {m.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}
