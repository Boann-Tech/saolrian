import type { ButtonHTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/cn';
import { Spinner } from './feedback';

const button = cva(
  'inline-flex items-center justify-center gap-2 font-semibold transition ' +
    'disabled:opacity-35 disabled:pointer-events-none active:scale-[.98] ' +
    'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/40',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-white hover:brightness-[1.08]',
        outline: 'bg-raised border border-border text-text hover:border-accent-line hover:text-accent-ink',
        ghost: 'bg-transparent text-accent-ink hover:bg-accent-soft',
        danger: 'bg-danger text-white hover:brightness-[1.08]',
      },
      size: {
        sm: 'text-sm rounded-md px-2.5 py-1.5',
        md: 'text-base rounded-md px-3.5 py-3',
      },
      block: { true: 'w-full', false: '' },
    },
    defaultVariants: { variant: 'primary', size: 'md', block: false },
  },
);

type Props = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof button> & { loading?: boolean };

export function Button({ variant, size, block, loading, disabled, className, children, ...rest }: Props) {
  return (
    <button
      className={cn(button({ variant, size, block }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <Spinner tone="onAccent" />}
      {children}
    </button>
  );
}
