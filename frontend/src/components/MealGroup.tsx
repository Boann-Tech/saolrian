import { useState } from 'react';
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import type { SummaryGroup } from '../lib/types';
import { formatInt } from '../lib/format';
import './meals.css';

/** Expandable meal group shared by Today and History — prototype
 *  .mealgrp structure: .gh header (name + chevron, kcal right) toggling
 *  a .meals list of .mrow entries with 36px SVG icon tiles. */

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
    <div className="meals">
      {group.entries.length === 0 ? (
        <div className="mrow" onClick={onAddFood} role={onAddFood ? 'button' : undefined}>
          <div className="ic">{ICONS.fork}</div>
          <div className="b">
            <div className="n" style={{ color: 'var(--faint)' }}>
              Nothing logged yet — tap to add
            </div>
          </div>
        </div>
      ) : (
        group.entries.map((e) => (
          <div key={e.id} className="mrow">
            <div className="ic">{pickIcon(e.name)}</div>
            <div className="b">
              <div className="n">{e.name}</div>
              <div className="d">
                {e.brand ? `${e.brand} · ` : ''}
                {formatInt(e.grams)} g
                {e.source !== 'manual' ? ` · ${e.source}` : ''}
                {timeOf(e.logged_at) ? ` · ${timeOf(e.logged_at)}` : ''}
              </div>
            </div>
            <div className="k">
              {formatInt(e.kcal)} <small>kcal</small>
            </div>
            {(onDelete || onEdit) && (
              <button
                className="entry-menu"
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
              <div className="entry-menu-pop">
                {onEdit && (
                  <button onClick={() => { setMenuEntry(null); onEdit(e.id); }}>
                    <svg viewBox="0 0 24 24" aria-hidden><path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3z" /></svg>
                    Edit
                  </button>
                )}
                {onDelete && (
                  <button
                    className="danger"
                    onClick={() => { setMenuEntry(null); onDelete(e.id); }}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden><path d="M6 7h12M9 7V5h6v2m-8 0 1 13h8l1-13" /></svg>
                    Delete
                  </button>
                )}
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );

  return (
    <div className={`mealgrp${open ? '' : ' closed'}`}>
      <button className="gh" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="n">
          {group.slot_name} <span className="chev">{open ? '▾' : '▸'}</span>
        </span>
        <span className="k">
          {group.entries.length === 0
            ? '0 kcal · nothing logged'
            : `${group.entries.length} item${group.entries.length === 1 ? '' : 's'} · ${formatInt(groupKcal)} kcal`}
        </span>
      </button>
      {body}
      {open &&
        (onAddFood ? (
          <button className="addmeal" onClick={onAddFood}>
            + {addLabel}
          </button>
        ) : (
          <Link className="addmeal" to="/add">
            + {addLabel}
          </Link>
        ))}
    </div>
  );
}
