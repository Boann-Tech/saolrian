import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useApp } from '../state/AppContext';
import { getClient } from '../lib/pb';
import { Button, Card, Empty, Field, Spinner, TextInput, useToast } from '../components/ui';
import { cn } from '../lib/cn';
import { formatInt } from '../lib/format';

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
      <div className="flex items-center gap-2 px-6 py-5 text-sm text-text-muted">
        <Spinner /> Loading entry…
      </div>
    );
  }

  return (
    <div className="pb-8">
      <div className="flex items-center justify-between px-6 pb-3 pt-4">
        <button
          className="flex h-9 w-9 flex-none items-center justify-center rounded-md border border-border bg-raised text-text"
          onClick={() => navigate(-1)}
          aria-label="Back"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <h2 className="text-xl font-bold tracking-[-.02em]">Edit entry</h2>
        <span className="w-9" />
      </div>

      <div className="px-6 pt-4">
        <Card className="p-4">
          <div className="mb-3.5 text-base font-bold text-text">{name}</div>

          <Field label="Calories (kcal)">
            <TextInput
              type="number"
              min={0}
              inputMode="numeric"
              value={kcal}
              onChange={(e) => setKcal(e.target.value.replace(/\D/g, ''))}
            />
          </Field>

          <Field label="Grams">
            <TextInput
              type="number"
              min={0}
              inputMode="decimal"
              value={grams}
              onChange={(e) => setGrams(e.target.value.replace(/[^\d.]/g, ''))}
            />
          </Field>

          <div className="mb-2 text-2xs font-semibold uppercase tracking-[.05em] text-text-faint">
            Meal slot
          </div>
          <div className="flex gap-2 overflow-x-auto no-scrollbar">
            {slots.map((s) => (
              <button
                key={s.id}
                className={cn(
                  'flex-none rounded-full border px-4 py-2 text-sm font-medium text-text transition',
                  s.id === slotId
                    ? 'border-accent bg-accent font-semibold text-white'
                    : 'border-border bg-raised hover:border-accent-line',
                )}
                onClick={() => setSlotId(s.id)}
              >
                {s.name}
              </button>
            ))}
          </div>

          <Button block loading={saving} className="mt-4" onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </Card>
      </div>
      {kcal ? (
        <Empty>{formatInt(parseInt(kcal, 10) || 0)} kcal in this entry</Empty>
      ) : null}
    </div>
  );
}
