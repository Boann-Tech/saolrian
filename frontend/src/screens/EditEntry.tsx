import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useApp } from '../state/AppContext';
import { getClient } from '../lib/pb';
import { Field, useToast } from '../components/ui';
import { formatInt } from '../lib/format';
import './edit-entry.css';

/** Edit a diary entry — kcal + grams (+ macros kept proportional), meal
 *  slot picker. Save updates in place and returns to Today/History. */

export default function EditEntry() {
  const { id } = useParams<{ id: string }>();
  const { endpoint, slots } = useApp();
  const navigate = useNavigate();
  const toast = useToast();

  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [kcal, setKcal] = useState('');
  const [grams, setGrams] = useState('');
  const [slotId, setSlotId] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!endpoint || !id) return;
    const pb = getClient(endpoint);
    pb.collection('diary_entries')
      .getOne(id)
      .then((rec) => {
        if (!rec) throw new Error('not found');
        setName(String(rec['name_snapshot'] ?? ''));
        setKcal(String(rec['kcal'] ?? ''));
        setGrams(String(rec['grams'] ?? ''));
        setSlotId(String(rec['meal_slot'] ?? slots[0]?.id ?? ''));
      })
      .catch(() => toast('Could not load entry', 'err'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, id]);

  const save = async () => {
    if (!endpoint || !id) return;
    const kcalNum = parseInt(kcal, 10);
    if (!Number.isFinite(kcalNum) || kcalNum <= 0 || !slotId) {
      toast('Enter a calorie amount and pick a meal slot', 'err');
      return;
    }
    setSaving(true);
    const pb = getClient(endpoint);
    try {
      await pb.collection('diary_entries').update(id, {
        kcal: kcalNum,
        grams: grams ? parseFloat(grams) : 0,
        meal_slot: slotId,
      });
      toast('Entry updated');
      navigate(-1);
    } catch (ex) {
      toast(ex instanceof Error ? ex.message : 'Could not update entry', 'err');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="edit">
        <p className="empty">Loading entry…</p>
      </div>
    );
  }

  return (
    <div className="edit">
      <div className="subhead">
        <button className="backbtn" onClick={() => navigate(-1)} aria-label="Back">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <h2>Edit entry</h2>
        <span style={{ width: 36 }} />
      </div>

      <div className="sec" style={{ paddingTop: 16 }}>
        <div className="card" style={{ padding: '16px 18px' }}>
          <div className="brand">{name}</div>

          <Field label="Calories (kcal)">
            <input
              type="number"
              min={0}
              inputMode="numeric"
              value={kcal}
              onChange={(e) => setKcal(e.target.value.replace(/\D/g, ''))}
            />
          </Field>

          <Field label="Grams">
            <input
              type="number"
              min={0}
              inputMode="decimal"
              value={grams}
              onChange={(e) => setGrams(e.target.value.replace(/[^\d.]/g, ''))}
            />
          </Field>

          <div className="cap" style={{ fontSize: 11.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--faint)', marginBottom: 8 }}>
            Meal slot
          </div>
          <div className="mealpills">
            {slots.map((s) => (
              <button
                key={s.id}
                className={s.id === slotId ? 'mp on' : 'mp'}
                onClick={() => setSlotId(s.id)}
              >
                {s.name}
              </button>
            ))}
          </div>

          <button className="btn" style={{ marginTop: 16 }} onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
      {kcal ? (
        <p className="empty" style={{ textAlign: 'center', marginTop: 8 }}>
          {formatInt(parseInt(kcal, 10) || 0)} kcal in this entry
        </p>
      ) : null}
    </div>
  );
}