import { useState } from 'react';
import { formatInt } from '../lib/format';

/** A daily metric that can be nudged with quick-add chips *and* corrected to
 *  an exact figure. Steps in particular arrive from a phone as an absolute
 *  count for the day, so "+1,000" is the wrong verb on its own — and a
 *  mis-tapped quick-add has to be undoable somehow. */
export function EditableMetric({
  value,
  goal,
  unit,
  label,
  onCommit,
}: {
  value: number;
  goal: number;
  /** Rendered after the goal, e.g. "ml" or "steps". */
  unit: string;
  /** Lower-case noun for the accessible names, e.g. "water amount". */
  label: string;
  onCommit: (next: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const commit = () => {
    const next = Math.max(0, Math.round(Number(draft)) || 0);
    setEditing(false);
    if (next !== value) onCommit(next);
  };

  return (
    <span className="flex items-baseline gap-1 text-xl font-bold">
      {editing ? (
        <input
          type="number"
          min={0}
          autoFocus
          aria-label={label}
          className="w-24 rounded-md border-[1.5px] border-accent-line bg-raised px-1.5 py-0.5 text-xl font-bold text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <button
          className="rounded-md underline decoration-dotted decoration-text-faint underline-offset-4 hover:decoration-accent"
          onClick={() => {
            setDraft(String(value));
            setEditing(true);
          }}
          aria-label={`Edit ${label}`}
        >
          {formatInt(value)}
        </button>
      )}
      <small className="text-sm font-medium text-text-faint">
        / {formatInt(goal)} {unit}
      </small>
    </span>
  );
}
