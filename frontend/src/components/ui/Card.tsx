import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

const PAD = { none: '', sm: 'p-3', md: 'p-4' } as const;

export function Card({
  as: Tag = 'div',
  padding = 'md',
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLElement> & {
  as?: 'div' | 'section';
  padding?: keyof typeof PAD;
  children: ReactNode;
}) {
  return (
    <Tag
      className={cn('rounded-lg border border-border bg-raised shadow-card', PAD[padding], className)}
      {...rest}
    >
      {children}
    </Tag>
  );
}

export function CardTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-baseline justify-between">
      <h3 className="text-md font-bold tracking-[-.01em]">{children}</h3>
      {right}
    </div>
  );
}
