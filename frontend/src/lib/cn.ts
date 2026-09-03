import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Join conditional class names and de-conflict Tailwind utilities. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
