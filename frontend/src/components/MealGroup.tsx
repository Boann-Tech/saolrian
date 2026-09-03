import { useState } from 'react';
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import type { SummaryGroup } from '../lib/types';
import { formatInt } from '../lib/format';
import { Card } from './ui';

/** Expandable meal group shared by Today and History — prototype
 *  .mealgrp structure: .gh header (name + chevron, kcal right) toggling
 *  a list of entry rows with 36px SVG icon tiles. */

/* Icon chip — line-icon SVGs inherit stroke; sizing/stroke via [&_svg] utils
 * (mirrors AppShell's NV_GLYPH pattern). */
const IC_CHIP =
  'flex h-9 w-9 flex-none items-center justify-center rounded-md border border-accent-line bg-accent-soft ' +
  '[&_svg]:h-[18px] [&_svg]:w-[18px] [&_svg]:fill-none [&_svg]:stroke-accent-ink ' +
  '[&_svg]:[stroke-width:2] [&_svg]:[stroke-linecap:round] [&_svg]:[stroke-linejoin:round]';

/* Popover action buttons — 15px line-icon SVGs. */
const POP_BTN =
  'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2.5 text-left text-sm font-semibold ' +
  '[&_svg]:h-[15px] [&_svg]:w-[15px] [&_svg]:flex-none [&_svg]:fill-none [&_svg]:stroke-current ' +
  '[&_svg]:[stroke-width:1.8] [&_svg]:[stroke-linecap:round] [&_svg]:[stroke-linejoin:round]';

const ADDMEAL =
  'mt-3 block w-full rounded-lg border-[1.5px] border-dashed border-accent-line py-2.5 text-center ' +
  'text-sm font-semibold text-accent no-underline hover:bg-accent-soft';

/* Small inline line icons reused from the prototype's log views. */
const ICONS: Record<string, ReactElement> = {
  bowl: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M4 19h16M6 19v-2a6 6 0 0 1 12 0v2M12 7V5" />
    </svg>
  ),
  plate: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.5" />
    </svg>
  ),
  cup: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M5 9h11v6a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V9zM16 9a3 3 0 0 1 0 6" />
    </svg>
  ),
  apple: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="13" r="6" />
      <path d="M12 7c0-2 2-2 2-4" />
    </svg>
  ),
  bottle: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M12 3v18M5 8c0 2 3 2 3 0M8 8v9a4 4 0 0 0 8 0V8c0 2-3 2-3 0" />
    </svg>
  ),
  fork: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M7 3v7M4 3v4a3 3 0 0 0 6 0V3M7 13v8M15 3c-1.5 2-2 5-2 8h4c0-3-.5-6-2-8zM15 11v10" />
    </svg>
  ),
};

/** Deterministic icon per entry name so lists feel alive without data. */
function pickIcon(name: string): ReactElement {
  const n = name.toLowerCase();
  if (/(yogurt|oat|porridge|cereal|soup|stew|chili|bowl|rice|pasta|noodle)/.test(n)) return ICONS.bowl;
  if (/(coffee|latte|tea|cup|cappuccino|espresso)/.test(n)) return ICONS.cup;
  if (/(apple|banana|fruit|berry|orange|pear)/.test(n)) return ICONS.apple;
  if (/(milk|water|juice|smoothie|drink|soda|cola)/.test(n)) return ICONS.bottle;
  if (/(salad|chicken|beef|fish|sandwich|wrap|toast|bread|egg|cheese)/.test(n)) return ICONS.plate;
  return ICONS.fork;
}

function timeOf(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? ''
    : new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(d);
}

export function MealGroup({
  group,
  addLabel = 'Add food',
  onAddFood,
  onDelete,
  onEdit,
}: {
  group: SummaryGroup;
  addLabel?: string;
  onAddFood?: () => void;
  onDelete?: (entryId: string) => void;
  onEdit?: (entryId: string) => void;
}) {
  const [open, setOpen] = useState(group.entries.length > 0);
  const [menuEntry, setMenuEntry] = useState<string | null>(null);
  const groupKcal = group.entries.reduce((s, e) => s + e.kcal, 0);

  const body = (
    <Card padding="none" className="divide-y divide-border">
      {group.entries.length === 0 ? (
        <div
          className="flex items-center gap-3 p-3.5"
          onClick={onAddFood}
          role={onAddFood ? 'button' : undefined}
        >
          <div className={IC_CHIP}>{ICONS.fork}</div>
          <div className="min-w-0 flex-1">
            <div className="text-text-faint">Nothing logged yet — tap to add</div>
          </div>
        </div>
      ) : (
        group.entries.map((e) => (
          <div key={e.id} className="relative flex items-center gap-3 p-3.5">
            <div className={IC_CHIP}>{pickIcon(e.name)}</div>
            <div className="min-w-0 flex-1">
              <div className="text-base font-semibold tracking-[-.01em]">{e.name}</div>
              <div className="mt-0.5 text-xs text-text-faint">
                {e.brand ? `${e.brand} · ` : ''}
                {formatInt(e.grams)} g
                {e.source !== 'manual' ? ` · ${e.source}` : ''}
                {timeOf(e.logged_at) ? ` · ${timeOf(e.logged_at)}` : ''}
              </div>
            </div>
            <div className="whitespace-nowrap text-base font-bold tracking-[-.01em]">
              {formatInt(e.kcal)} <small className="text-2xs font-medium text-text-faint">kcal</small>
            </div>
            {(onDelete || onEdit) && (
              <button
                className="ml-1.5 flex flex-none rounded-md px-1 py-1.5 leading-none text-text-faint hover:bg-surface hover:text-text-muted [&_svg]:h-4 [&_svg]:w-4 [&_svg]:fill-current"
                aria-label={`Actions for ${e.name}`}
                onClick={() => setMenuEntry(menuEntry === e.id ? null : e.id)}
              >
                <svg viewBox="0 0 24 24" aria-hidden>
                  <circle cx="5" cy="12" r="1.6" />
                  <circle cx="12" cy="12" r="1.6" />
                  <circle cx="19" cy="12" r="1.6" />
                </svg>
              </button>
            )}
            {menuEntry === e.id && (
              <div className="absolute right-1 top-[calc(100%-8px)] z-20 flex min-w-[132px] flex-col gap-0.5 rounded-lg border border-border bg-raised p-1.5 shadow-[0_8px_24px_rgba(10,37,64,.12)]">
                {onEdit && (
                  <button
                    className={`${POP_BTN} text-text hover:bg-surface`}
                    onClick={() => {
                      setMenuEntry(null);
                      onEdit(e.id);
                    }}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden>
                      <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3z" />
                    </svg>
                    Edit
                  </button>
                )}
                {onDelete && (
                  <button
                    className={`${POP_BTN} text-danger hover:bg-[#fdf0f0]`}
                    onClick={() => {
                      setMenuEntry(null);
                      onDelete(e.id);
                    }}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden>
                      <path d="M6 7h12M9 7V5h6v2m-8 0 1 13h8l1-13" />
                    </svg>
                    Delete
                  </button>
                )}
              </div>
            )}
          </div>
        ))
      )}
    </Card>
  );

  return (
    <div className="mb-3.5">
      <button
        className="flex w-full items-baseline justify-between px-0.5 pb-2 pt-0.5 text-left"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="flex items-center gap-1.5 text-base font-bold tracking-[-.01em] text-text">
          {group.slot_name} <span className="text-[9px] text-text-faint">{open ? '▾' : '▸'}</span>
        </span>
        <span className="text-sm font-semibold text-text-muted">
          {group.entries.length === 0
            ? '0 kcal · nothing logged'
            : `${group.entries.length} item${group.entries.length === 1 ? '' : 's'} · ${formatInt(groupKcal)} kcal`}
        </span>
      </button>
      {open && body}
      {open &&
        (onAddFood ? (
          <button className={ADDMEAL} onClick={onAddFood}>
            + {addLabel}
          </button>
        ) : (
          <Link className={ADDMEAL} to="/add">
            + {addLabel}
          </Link>
        ))}
    </div>
  );
}
