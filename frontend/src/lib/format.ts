/** Number + date formatting via Intl, shared across screens. */

const nf = new Intl.NumberFormat('en-US');

export function formatNumber(n: number, opts?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat('en-US', opts).format(n);
}

export function formatInt(n: number): string {
  return nf.format(Math.round(n));
}

/** Local-timezone ISO date (YYYY-MM-DD), offset by whole days from today. */
export function dateFromOffset(offsetDays: number, from?: string): string {
  const d = from ? new Date(from + 'T12:00:00') : new Date();
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function todayISO(): string {
  return dateFromOffset(0);
}

/** Human greeting in the user's locale morning/afternoon/evening. */
export function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export function weekdayLabel(iso: string): string {
  const d = new Date(iso + 'T12:00:00');
  return new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(d);
}

export function prettyDate(iso: string): string {
  const d = new Date(iso + 'T12:00:00');
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(d);
}
