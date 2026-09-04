import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../state/AppContext';
import type { ActivityLevel, Goal, Sex, TdeeFormula } from '../lib/types';
import { getClient } from '../lib/pb';
import {
  ACTIVITY_FACTORS,
  ACTIVITY_LEVEL_HINT,
  FORMULA_LABEL,
  computeCalorieTarget,
  computeTdee,
} from '../lib/nutrition';
import { formatInt } from '../lib/format';
import { Button, Card, Field, Segmented, Select, TextInput, useToast } from '../components/ui';
import { cn } from '../lib/cn';

/** Post-signup setup wizard — name, body metrics, goal/activity →  computed
 * calorie budget. Runs once: only shown while the profile is incomplete (no
 * sex / height / activity / weight yet). Saves to profiles + weights + users.name. */

const STEPS = ['You', 'Body', 'Goal'];

const LOSE_RATES = [-1, -0.75, -0.5, -0.25];
const GAIN_RATES = [0.25, 0.5,  0.75,  1];

export default function Welcome() {
  const { endpoint, userId, profile, refreshProfile } = useApp();
  const toast = useToast();
  const navigate = useNavigate();

  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [sex, setSex] = useState<Sex | ''>('');
  const [birthYear, setBirthYear] = useState('');
  const [heightCm, setHeightCm] = useState('');
  const [weightKg, setWeightKg] = useState('');
  const [activity, setActivity] = useState<ActivityLevel>('moderate');
  const [goal, setGoal] = useState<Goal>('maintain');
  const [rate, setRate] = useState(-0.5);
  const [formula, setFormula] = useState<TdeeFormula>('mifflin');

  const num = (s: string): number | null => {
    const v = parseFloat(s);
    return Number.isFinite(v) ? v : null;
  };

  const input = useMemo(
    () => ({
      height_cm: num(heightCm),
      birth_year: num(birthYear) != null ? Math.round(num(birthYear) ?? 0) : null,
      sex: (sex || null) as Sex | null,
      activity_level: activity as ActivityLevel | null,
      body_fat_pct: null,
      weight_kg: num(weightKg),
      tdee_formula: formula,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [heightCm, birthYear, sex, activity, weightKg, formula]
  );

  const tdee = computeTdee(input);
  const target = computeCalorieTarget(input, goal);
  const canNext =
    step ===  0 ? name.trim().length > 0 :
    step === 1 ? sex !== '' && (num(birthYear) ?? 0) >= 1900 && (num(heightCm) ?? 0) > 0 && (num(weightKg) ?? 0) > 0 :
    true;
  const rateShown = goal === 'maintain' ? null : goal === 'lose' ? LOSE_RATES : GAIN_RATES;

  const finish = async () => {
    if (!endpoint || !userId) return;
    setSaving(true);
    const pb = getClient(endpoint);
    try {
      if (name.trim()) {
        await pb.collection('users').update(userId, { name: name.trim() });
      }
      const payload: Record<string, unknown> = {
        name: name.trim() || undefined,
        sex: sex || null,
        height_cm: num(heightCm),
        birth_year: num(birthYear) != null ? Math.round(num(birthYear) ?? 0) : null,
        activity_level: activity,
        goal,
        goal_rate: goal === 'maintain' ? 0 : goal === 'lose' ? -Math.abs(rate) : Math.abs(rate),
        tdee_formula: formula,
      };
      if (profile) {
        await pb.collection('profiles').update(profile.id, payload);
      } else {
        await pb.collection('profiles').create({ ...payload, user: userId });
      }
      const w = num(weightKg);
      if (w != null) {
        await pb.collection('weights').create({
          user: userId,
          kg: w,
          measured_at: new Date().toISOString(),
          source: 'manual',
        });
      }
      await refreshProfile();
      toast('Welcome to Saolrian');
      navigate('/', { replace: true });
    } catch (ex) {
      toast(ex instanceof Error ? ex.message : 'Could not save your profile', 'err');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center overflow-y-auto bg-bg px-[22px] pb-[calc(env(safe-area-inset-bottom)+28px)] pt-[calc(env(safe-area-inset-top)+28px)]">
      <div className="view-wrap w-full max-w-[440px]">
        <div className="flex items-center gap-2 text-xs font-bold tracking-[.02em]">
          <span className="h-2.5 w-2.5 rounded-[3px] bg-accent" />
          SAOLRIAN
        </div>
        {step ===  0 && (
          <>
            <h1 className="mt-4 text-[30px] font-bold leading-[1.12] tracking-[-.025em]">Let’s set you up</h1>
            <p className="mb-5 mt-2 text-sm leading-normal text-text-muted">Two minutes, and we’ll dial in your calorie budget.</p>
            <Field label="What should we call you?">
              <TextInput
                autoFocus
                placeholder="e.g. Sarah"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && canNext) setStep(1); }}
              />
            </Field>
            <p className="mt-2.5 text-xs text-text-faint">Used for your greeting — “Good morning, Sarah”.</p>
          </>
        )}
        {step ===  1 && (
          <>
            <h1 className="mt-4 text-[30px] font-bold leading-[1.12] tracking-[-.025em]">Your body, your numbers</h1>
            <p className="mb-5 mt-2 text-sm leading-normal text-text-muted">Rough is fine — you can tune everything later in Profile.</p>
            <div className="grid grid-cols-2 gap-3.5 [&>label:first-child]:col-span-2 [&>label:last-child]:col-span-2">
              <Field label="Sex">
                <Select value={sex} onChange={(e) => setSex(e.target.value as Sex)}>
                  <option value="">Select…</option>
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                  <option value="other">Other</option>
                </Select>
              </Field>
              <Field label="Birth year">
                <TextInput type="number" min={1950} max={new Date().getFullYear()} placeholder="e.g. 1994" value={birthYear} onChange={(e) => setBirthYear(e.target.value)} />
              </Field>
              <Field label="Height (cm)">
                <TextInput type="number" min={100} max={230} placeholder="e.g. 168" value={heightCm} onChange={(e) => setHeightCm(e.target.value)} />
              </Field>
              <Field label="Weight (kg)">
                <TextInput type="number" min={30} max={250} step={0.1} placeholder="e.g. 72.5" value={weightKg} onChange={(e) => setWeightKg(e.target.value)} />
              </Field>
            </div>
          </>
        )}
        {step ===  2 && (
          <>
            <h1 className="mt-4 text-[30px] font-bold leading-[1.12] tracking-[-.025em]">Your goal</h1>
            <p className="mb-5 mt-2 text-sm leading-normal text-text-muted">Pick a direction — we’ll set your daily target from your TDEE.</p>
            <Segmented
              className="mb-4"
              aria-label="Goal"
              value={goal}
              onChange={(g) => setGoal(g as Goal)}
              options={[
                { value: 'lose', label: 'Lose' },
                { value: 'maintain', label: 'Maintain' },
                { value: 'gain', label: 'Gain' },
              ]}
            />
            <Field label="Activity level" hint={ACTIVITY_LEVEL_HINT[activity]}>
              <Select value={activity} onChange={(e) => setActivity(e.target.value as ActivityLevel)}>
                <option value="sedentary">Sedentary</option>
                <option value="light">Light</option>
                <option value="moderate">Moderate</option>
                <option value="very">Very active</option>
                <option value="extreme">Extreme</option>
              </Select>
            </Field>
            {rateShown && (
              <div className="mb-[18px] mt-1">
                <div className="mb-2 text-xs font-semibold text-text-muted">{goal === 'lose' ? 'Weekly loss target' : 'Weekly gain target'}</div>
                <div className="flex flex-wrap gap-2">
                  {rateShown.map((r) => (
                    <button
                      key={r}
                      type="button"
                      className={cn(
                        'rounded-full border border-border bg-raised px-3.5 py-1.5 text-sm font-semibold text-text-muted',
                        rate === r && 'border-accent-line bg-accent-soft text-accent-ink',
                      )}
                      onClick={() => setRate(r)}
                    >
                      {Math.abs(r)} kg/wk
                    </button>
                  ))}
                </div>
              </div>
            )}
            <Card className="mt-1.5 p-5">
              <div className="text-2xs font-semibold uppercase tracking-[.05em] text-text-faint">
                {FORMULA_LABEL[formula]} · {ACTIVITY_FACTORS[activity]}×
              </div>
              <div className="mt-0.5 text-[34px] font-bold tracking-[-.02em]">{tdee != null ? formatInt(tdee) : '—'}</div>
              <div className="mb-2 text-2xs text-text-faint">kcal/day TDEE</div>
              <div className="text-sm text-text-muted">
                Target: <b className="text-text">{target != null ? formatInt(target) : '—'}</b> kcal/day to {goal}
              </div>
              <div className="mt-3.5 flex gap-2">
                {(['mifflin', 'katch'] as const).map((f) => (
                  <label
                    key={f}
                    className={cn(
                      'flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-semibold text-text-muted',
                      formula === f && 'border-accent-line bg-accent-soft text-accent-ink',
                    )}
                  >
                    <input type="radio" name="formula" checked={formula === f} onChange={() => setFormula(f)} className="hidden" />
                    {FORMULA_LABEL[f].split(' ')[0]}
                  </label>
                ))}
              </div>
            </Card>
          </>
        )}
        <div className="my-6 flex justify-center gap-1.5">
          {STEPS.map((s, i) => (
            <span
              key={s}
              title={s}
              className={cn('h-[7px] w-[7px] rounded-full bg-border transition-all', i === step && 'w-5 bg-accent')}
            />
          ))}
        </div>
        <div className="flex gap-2.5">
          {step >  0 && (
            <Button variant="outline" className="flex-1" disabled={saving} onClick={() => setStep((s) => s - 1)}>
              Back
            </Button>
          )}
          {step < 2 ? (
            <Button className="flex-1" disabled={!canNext} onClick={() => setStep((s) => s + 1)}>
              Continue
            </Button>
          ) : (
            <Button className="flex-1" disabled={!canNext || saving} loading={saving} onClick={() => void finish()}>
              {saving ? 'Saving…' : 'Start tracking'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
