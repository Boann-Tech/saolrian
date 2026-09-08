import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useApp } from '../state/AppContext';
import { getClient } from '../lib/pb';
import { Button, Card, Field, Spinner, TextInput, useToast } from '../components/ui';
import { cn } from '../lib/cn';

/** Edit a diary entry — kcal + grams (+ macros kept proportional), meal
 *  slot picker. Save updates in place and returns to Today/History.
 *
 *  Macros are stored per entry, so changing the calories has to rescale them
 *  or the diary's macro totals stop matching its calorie total.
 *
 *  Grams is the quantity for anything logged by weight — AddFood derives the
 *  calories from it via foodMath — so editing the amount rescales the calories
 *  with it. A direct calorie edit is treated as an override of the database's
 *  number and leaves the amount alone. */

/** Rescale the stored macros by an explicit factor, keeping the entry's
 *  composition. The factor comes from whichever field the user edited, so a
 *  gram edit scales by the exact gram ratio rather than by the rounded calorie
 *  figure derived from it — 3 g -> 2 g is 2/3, not 67/100.
 *
 *  A null factor means there was nothing to scale by, in which case the stored
 *  macros are left alone rather than being zeroed or blown up to Infinity. */
function scaleMacros(
  original: { protein: number; carbs: number; fat: number } | null,
  ratio: number | null,
): { protein: number; carbs: number; fat: number } | undefined {
  if (!original || ratio == null || !Number.isFinite(ratio)) return undefined;
  const round1 = (n: number) => Math.round(n * 10) / 10;
  return {
    protein: round1(original.protein * ratio),
    carbs: round1(original.carbs * ratio),
    fat: round1(original.fat * ratio),
  };
}

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
  // How far the entry has been scaled from what was loaded. 1 means untouched;
  // null means the edit gave nothing to scale by.
  const [ratio, setRatio] = useState<number | null>(1);
  // The entry as loaded — the baseline the macro rescale is measured against.
  const [original, setOriginal] = useState<
    { grams: number; kcal: number; protein: number; carbs: number; fat: number } | null
  >(null);

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
        setOriginal({
          grams: Number(rec['grams'] ?? 0),
          kcal: Number(rec['kcal'] ?? 0),
          protein: Number(rec['protein'] ?? 0),
          carbs: Number(rec['carbs'] ?? 0),
          fat: Number(rec['fat'] ?? 0),
        });
      })
      .catch(() => toast('Could not load entry', 'err'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, id]);

  /** Editing the amount rescales the calories from the entry as logged, and
   *  sets the exact factor the macros will be scaled by. An entry with no
   *  recorded weight has no ratio to scale by, so its figures stand. */
  const setGramsAndScale = (raw: string) => {
    setGrams(raw);
    if (!original || !(original.grams > 0) || !(original.kcal > 0)) return;
    const next = parseFloat(raw);
    if (!Number.isFinite(next)) return;
    const gramRatio = next / original.grams;
    setRatio(gramRatio);
    setKcal(String(Math.round(original.kcal * gramRatio)));
  };

  /** A direct calorie edit overrides the database's number rather than saying
   *  the portion changed, so the amount stays put and the macros follow the
   *  calories. */
  const setKcalAsOverride = (raw: string) => {
    setKcal(raw);
    if (!original) return;
    const next = parseInt(raw, 10);
    if (!Number.isFinite(next)) return;
    setRatio(original.kcal > 0 ? next / original.kcal : null);
  };

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
        ...scaleMacros(original, ratio),
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
          className="flex h-11 w-11 flex-none items-center justify-center rounded-md border border-border bg-raised text-text"
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
              onChange={(e) => setKcalAsOverride(e.target.value.replace(/\D/g, ''))}
            />
          </Field>

          <Field label="Grams">
            <TextInput
              type="number"
              min={0}
              inputMode="decimal"
              value={grams}
              onChange={(e) => setGramsAndScale(e.target.value.replace(/[^\d.]/g, ''))}
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
    </div>
  );
}
