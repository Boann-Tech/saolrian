import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { SummaryGroup } from '../lib/types';
import { formatInt } from '../lib/format';
import './meals.css';

/** Expandable meal group shared by Today and History. */

export function MealGroup({
  group,
  addLabel = 'Add food',
  onAddFood,
}: {
  group: SummaryGroup;
  addLabel?: string;
  onAddFood?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const groupKcal = group.entries.reduce((s, e) => s + e.kcal, 0);

  return (
    <div className="meal-group">
      <button className="meal-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="meal-chevron" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
        <span className="meal-name">{group.slot_name}</span>
        <span className="meal-meta">
          {group.entries.length === 0
            ? 'No food logged'
            : `${group.entries.length} item${group.entries.length === 1 ? '' : 's'} · ${formatInt(groupKcal)} kcal`}
        </span>
      </button>

      {open && (
        <div className="meal-body">
          {group.entries.length === 0 ? (
            <p className="meal-empty">Nothing logged yet.</p>
          ) : (
            <ul className="meal-entries">
              {group.entries.map((e) => (
                <li key={e.id} className="meal-entry">
                  <div className="meal-entry-main">
                    <span className="meal-entry-name">{e.name}</span>
                    <span className="meal-entry-sub">
                      {e.brand ? `${e.brand} · ` : ''}
                      {formatInt(e.grams)} g
                      {e.source !== 'manual' ? ` · ${e.source}` : ''}
                    </span>
                  </div>
                  <span className="meal-entry-kcal">{formatInt(e.kcal)} kcal</span>
                </li>
              ))}
            </ul>
          )}
          {onAddFood ? (
            <button className="btn btn-outline btn-sm" onClick={onAddFood}>
              {addLabel}
            </button>
          ) : (
            <Link className="btn btn-outline btn-sm" to="/add">
              {addLabel}
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
