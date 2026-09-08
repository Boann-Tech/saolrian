import { Children, cloneElement, isValidElement, useId } from 'react';
import type { InputHTMLAttributes, ReactElement, SelectHTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

const CONTROL =
  'w-full rounded-md border-[1.5px] border-border bg-raised px-3 py-2.5 text-md text-text ' +
  'outline-none transition focus:border-accent focus:ring-2 focus:ring-accent-soft';

/** Labelled form control.
 *
 *  The hint and error sit *outside* the <label> and reach the control through
 *  aria-describedby. Nesting them inside it made both part of the control's
 *  accessible name — so a select was announced as its label plus a sentence of
 *  guidance, and that name changed the moment an error appeared.
 *
 *  The label still wraps the control, so association survives call sites that
 *  wrap their input in a positioning element. */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  const id = useId();
  const messageId = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  const control =
    messageId || error
      ? describe(children, messageId, Boolean(error))
      : children;

  return (
    <div className="flex flex-col gap-1">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-semibold text-text-muted">{label}</span>
        {control}
      </label>
      {error ? (
        <span id={messageId} className="text-xs text-danger">
          {error}
        </span>
      ) : hint ? (
        <span id={messageId} className="text-xs text-text-faint">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

/** Point the control at its message, preserving any aria-describedby it
 *  already carries.
 *
 *  Some call sites wrap their input in a positioning element (Auth's password
 *  field has a reveal button beside it), so this looks through plain intrinsic
 *  wrappers to find the control rather than describing the wrapper — which
 *  would leave the description attached to a div and announced by nobody. */
function describe(children: ReactNode, messageId: string | undefined, invalid: boolean, depth = 0): ReactNode {
  if (!isValidElement(children)) return children;
  const el = children as ReactElement<Record<string, unknown>>;

  // A plain DOM wrapper: describe what's inside it instead. Bounded, so a
  // deeply nested child can't send this walking the whole tree.
  if (typeof el.type === 'string' && !CONTROL_TAGS.has(el.type) && depth < 3) {
    const inner = Children.map(el.props['children'] as ReactNode, (child, i) =>
      i === 0 ? describe(child, messageId, invalid, depth + 1) : child,
    );
    return cloneElement(el, {}, inner);
  }

  const existing = el.props['aria-describedby'];
  const describedBy = [existing, messageId].filter(Boolean).join(' ') || undefined;
  return cloneElement(el, {
    'aria-describedby': describedBy,
    ...(invalid ? { 'aria-invalid': true } : {}),
  });
}

const CONTROL_TAGS = new Set(['input', 'select', 'textarea']);

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(CONTROL, className)} {...rest} />;
}

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(CONTROL, className)} {...rest} />;
}
