import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../state/AppContext';
import type { ActivityLevel, Goal, Sex, TdeeFormula } from '../lib/types';
import { getClient } from '../lib/pb';
import {
  ACTIVITY_FACTORS,
  FORMULA_LABEL,
  computeCalorieTarget,
  computeTdee,
} from '../lib/nutrition';
import { formatInt } from '../lib/format';
import { Field, useToast } from '../components/ui';
import './welcome.css';

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
    <div className="wiz">
      <div className="wiz-inner">
        <div className="brandline"><span className="dot" /> SAOLRIAN</div>
        {step ===  0 && (
          <>
            <h1>Let’s set you up</h1>
            <p className="tag">Two minutes, and we’ll dial in your calorie budget.</p>
            <Field label="What should we call you?">
              <input
                autoFocus
                placeholder="e.g. Sarah"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && canNext) setStep(1); }}
              />
            </Field>
            <p className="hint">Used for your greeting — “Good morning, Sarah”.</p>
          </>
        )}
        {step ===  1 && (
          <>
            <h1>Your body, your numbers</h1>
            <p className="tag">Rough is fine — you can tune everything later in Profile.</p>
            <div className="wiz-grid">
              <Field label="Sex">
                <select value={sex} onChange={(e) => setSex(e.target.value as Sex)}>
                  <option value="">Select…</option>
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                  <option value="other">Other</option>
                </select>
              </Field>
              <Field label="Birth year">
                <input type="number" min={1950} max={new Date().getFullYear()} placeholder="e.g. 1994" value={birthYear} onChange={(e) => setBirthYear(e.target.value)} />
              </Field>
              <Field label="Height (cm)">
                <input type="number" min={100} max={230} placeholder="e.g. 168" value={heightCm} onChange={(e) => setHeightCm(e.target.value)} />
              </Field>
              <Field label="Weight (kg)">
                <input type="number" min={30} max={250} step={0.1} placeholder="e.g. 72.5" value={weightKg} onChange={(e) => setWeightKg(e.target.value)} />
              </Field>
            </div>
          </>
        )}
        {step ===  2 && (
          <>
            <h1>Your goal</h1>
            <p className="tag">Pick a direction — we’ll set your daily target from your TDEE.</p>
            <div className="goalseg">
              {(
                [
                  ['lose', 'Lose'],
                  ['maintain', 'Maintain'],
                  ['gain', 'Gain'],
                ] as const
              ).map(([g, label]) => (
                <button key={g} className={goal === g ? 'on' : ''} onClick={() => setGoal(g as Goal)}>
                  {label}
                </button>
              ))}
            </div>
            <Field label="Activity level">
              <select value={activity} onChange={(e) => setActivity(e.target.value as ActivityLevel)}>
                <option value="sedentary">Sedentary</option>
                <option value="light">Light</option>
                <option value="moderate">Moderate</option>
                <option value="very">Very active</option>
                <option value="extreme">Extreme</option>
              </select>
            </Field>
            {rateShown && (
              <div className="rate-row">
                <div className="rate-cap">{goal === 'lose' ? 'Weekly loss target' : 'Weekly gain target'}</div>
                <div className="rate-pills">
                  {rateShown.map((r) => (
                    <button key={r} className={rate === r ? 'on' : ''} onClick={() => setRate(r)}>
                      {Math.abs(r)} kg/wk
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="card wiz-tdee">
              <div className="cap">{FORMULA_LABEL[formula]} · {ACTIVITY_FACTORS[activity]}×</div>
              <div className="cal">{tdee != null ? formatInt(tdee) : '—'}</div>
              <div className="cap2">kcal/day TDEE</div>
              <div className="target">
                Target: <b>{target != null ? formatInt(target) : '—'}</b> kcal/day to {goal}
              </div>
              <div className="formula-pick">
                {(['mifflin', 'katch'] as const).map((f) => (
                  <label key={f} className={formula === f ? 'on' : ''}>
                    <input type="radio" name="formula" checked={formula === f} onChange={() => setFormula(f)} />
                    {FORMULA_LABEL[f].split(' ')[0]}
                  </label>
                ))}
              </div>
            </div>
          </>
        )}
        <div className="wiz-dots">
          {STEPS.map((s, i) => (<span key={s} className={i === step ? 'on' : ''} title={s} />))}
        </div>
        <div className="wiz-actions">
          {step >  0 && (
            <button className="btn outline" onClick={() => setStep((s) => s - 1)} disabled={saving}>
              Back
            </button>
          )}
          {step < 2 ? (
            <button className="btn" disabled={!canNext} onClick={() => setStep((s) => s + 1)}>
              Continue
            </button>
          ) : (
            <button className="btn" disabled={!canNext || saving} onClick={() => void finish()}>
              {saving ? 'Saving…' : 'Start tracking'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}