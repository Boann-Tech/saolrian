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

interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  kind?: 'ok' | 'err';
  /** Offers a way back from a completed action — prefer this over a
   *  confirmation dialog for anything reversible. */
  action?: ToastAction;
  /** Override the auto-dismiss delay, in ms. */
  duration?: number;
}

interface ToastMsg extends ToastOptions {
  id: number;
  text: string;
  kind: 'ok' | 'err';
}

/** An error the user may need to read twice, or a toast they have to act on,
 *  gets longer than a plain confirmation. */
const DURATION = { ok: 3200, err: 6000, action: 8000 };

type ToastFn = (text: string, opts?: 'ok' | 'err' | ToastOptions) => void;

const ToastCtx = createContext<ToastFn>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastMsg[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setItems((t) => t.filter((m) => m.id !== id));
  }, []);

  const push = useCallback<ToastFn>(
    (text, opts) => {
      const o: ToastOptions = typeof opts === 'string' ? { kind: opts } : (opts ?? {});
      const kind = o.kind ?? 'ok';
      const id = nextId.current++;
      const ms = o.duration ?? (o.action ? DURATION.action : DURATION[kind]);
      setItems((t) => [...t, { ...o, id, text, kind }]);
      window.setTimeout(() => setItems((t) => t.filter((m) => m.id !== id)), ms);
    },
    [],
  );

  // Errors interrupt; confirmations wait their turn. Two regions, because a
  // single container can only carry one politeness setting.
  const region = (kind: 'ok' | 'err') => (
    <div
      key={kind}
      className="pointer-events-none flex flex-col items-center gap-2"
      aria-live={kind === 'err' ? 'assertive' : 'polite'}
      role={kind === 'err' ? 'alert' : undefined}
    >
      {items
        .filter((m) => m.kind === kind)
        .map((m) => (
          <div
            key={m.id}
            className={cn(
              'pointer-events-auto flex max-w-[92vw] items-center gap-3 rounded-2xl px-4 py-2 text-xs font-medium text-white shadow-sheet',
              m.kind === 'err' ? 'bg-danger' : 'bg-text',
            )}
          >
            <span className="min-w-0 flex-1 break-words">{m.text}</span>
            {m.action && (
              <button
                className="flex-none rounded-md px-1.5 py-0.5 font-bold uppercase tracking-[.04em] text-white underline underline-offset-2"
                onClick={() => {
                  m.action!.onClick();
                  dismiss(m.id);
                }}
              >
                {m.action.label}
              </button>
            )}
            <button
              className="flex-none rounded-md px-1 text-sm leading-none text-white/70 hover:text-white"
              aria-label="Dismiss"
              onClick={() => dismiss(m.id)}
            >
              &#10005;
            </button>
          </div>
        ))}
    </div>
  );

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div
        className="pointer-events-none fixed left-1/2 z-40 flex -translate-x-1/2 flex-col items-center gap-2"
        style={{ bottom: 'calc(104px + env(safe-area-inset-bottom))' }}
      >
        {region('err')}
        {region('ok')}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}
