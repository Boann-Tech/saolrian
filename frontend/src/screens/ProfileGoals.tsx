import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../state/AppContext';
import type { ActivityLevel, Goal, Profile, Sex, TdeeFormula } from '../lib/types';
import { getClient } from '../lib/pb';
import {
  ACTIVITY_FACTORS,
  DEFAULT_MACROS,
  FORMULA_LABEL,
  computeBmr,
  computeCalorieTarget,
  computeTdee,
  macroSplit,
} from '../lib/nutrition';
import { formatInt } from '../lib/format';
import { Button, Card, CardTitle, Field, Segmented, useToast } from '../components/ui';
import './profile.css';

/** Profile & goals: body metrics → TDEE card, goal + macro split, meal plan editor, theme picker. */

const THEME_PRESETS = [
  { name: 'Turf', color: '#0f7a5f' },
  { name: 'Bog gold', color: '#b8860b' },
  { name: 'Copper', color: '#b0673a' },
  { name: 'Atlantic', color: '#1f6feb' },
  { name: 'Whin', color: '#c93c64' },
  { name: 'Heather', color: '#7048b4' },
  { name: 'Slate', color: '#475569' },
  { name: 'Night', color: '#1e293b' },
];

interface ProfileForm {
  height_cm: string;
  birth_year: string;
  sex: Sex | '';
  activity_level: ActivityLevel | '';
  body_fat_pct: string;
  weight_kg: string;
  tdee_formula: TdeeFormula;
}

function fromProfile(p: Profile | null): ProfileForm {
  return {
    height_cm: p?.height_cm != null ? String(p.height_cm) : '',
    birth_year: p?.birth_year != null ? String(p.birth_year) : '',
    sex: p?.sex ?? '',
    activity_level: p?.activity_level ?? '',
    body_fat_pct: p?.body_fat_pct != null ? String(p.body_fat_pct) : '',
    weight_kg: '',
    tdee_formula: p?.tdee_formula ?? 'mifflin',
  };
}

export default function ProfileGoals() {
  const { endpoint, profile, refreshProfile, slots, refreshSlots, theme, setTheme } = useApp();
  const toast = useToast();
  const [form, setForm] = useState<ProfileForm>(() => fromProfile(profile));
  const [saving, setSaving] = useState(false);
  const [goal, setGoal] = useState<Goal>(profile?.goal ?? 'maintain');
  const [macros, setMacros] = useState({
    protein_pct: profile?.protein_pct ?? DEFAULT_MACROS.protein_pct,
    carbs_pct: profile?.carbs_pct ?? DEFAULT_MACROS.carbs_pct,
    fat_pct: profile?.fat_pct ?? DEFAULT_MACROS.fat_pct,
  });
  const [customTheme, setCustomTheme] = useState('');

  useEffect(() => {
    setForm(fromProfile(profile));
    if (profile?.goal) setGoal(profile.goal);
  }, [profile]);

  const num = (s: string): number | null => {
    const v = parseFloat(s);
    return Number.isFinite(v) ? v : null;
  };

  const input: Parameters<typeof computeTdee>[0] = {
    height_cm: num(form.height_cm),
    birth_year: num(form.birth_year) != null ? Math.round(num(form.birth_year)!) : null,
    sex: form.sex || null,
    activity_level: form.activity_level || null,
    body_fat_pct: num(form.body_fat_pct),
    weight_kg: num(form.weight_kg),
    tdee_formula: form.tdee_formula,
  };

  const tdee = computeTdee(input);
  const target = computeCalorieTarget(input, goal);
  const split = macroSplit(target ?? 0, macros.protein_pct, macros.fat_pct);

  const saveProfile = async () => {
    setSaving(true);
    const pb = getClient(endpoint);
    try {
      const payload = {
        user: pb.authStore.record?.id,
        height_cm: num(form.height_cm),
        birth_year: num(form.birth_year) != null ? Math.round(num(form.birth_year)!) : null,
        sex: form.sex || null,
        activity_level: form.activity_level || null,
        body_fat_pct: num(form.body_fat_pct),
        tdee_formula: form.tdee_formula,
        goal,
        protein_pct: macros.protein_pct,
        carbs_pct: split.carbsPct,
        fat_pct: macros.fat_pct,
        theme_accent: theme,
      };
      if (profile) {
        await pb.collection('profiles').update(profile.id, payload);
      } else {
        await pb.collection('profiles').create(payload);
      }
      // Weight goes to its own collection, never onto the profile.
      const weight = num(form.weight_kg);
      if (weight != null) {
        await pb.collection('weights').create({
          user: pb.authStore.record?.id,
          kg: weight,
          measured_at: new Date().toISOString(),
          source: 'manual',
        });
      }
      await refreshProfile();
      toast('Profile saved');
    } catch (ex) {
      toast(ex instanceof Error ? ex.message : 'Could not save profile', 'err');
    } finally {
      setSaving(false);
    }
  };

  const saveGoalMacros = async (g: Goal, m: typeof macros) => {
    if (!profile) return;
    const pb = getClient(endpoint);
    const s = macroSplit(target ?? 0, m.protein_pct, m.fat_pct);
    try {
      await pb.collection('profiles').update(profile.id, {
        goal: g,
        protein_pct: m.protein_pct,
        carbs_pct: s.carbsPct,
        fat_pct: m.fat_pct,
      });
      await refreshProfile();
    } catch {
      /* silent — the main Save button also persists these */
    }
  };

  /* ----- Meal plan editor ----- */
  const pctSum = slots.reduce((s, x) => s + (x.pct_allocation ?? 0), 0);

  const moveSlot = async (idx: number, dir: -1 | 1) => {
    const a = slots[idx];
    const b = slots[idx + dir];
    if (!a || !b) return;
    const pb = getClient(endpoint);
    try {
      await pb.collection('meal_slots').update(a.id, { sort_order: b.sort_order || idx + 1 });
      await pb.collection('meal_slots').update(b.id, { sort_order: a.sort_order });
      await refreshSlots();
    } catch {
      toast('Could not reorder slots', 'err');
    }
  };

  const setSlotPct = async (id: string, pct: number) => {
    const pb = getClient(endpoint);
    try {
      await pb.collection('meal_slots').update(id, { pct_allocation: pct });
      await refreshSlots();
    } catch {
      toast('Could not update allocation', 'err');
    }
  };

  const removeSlot = async (id: string) => {
    const pb = getClient(endpoint);
    try {
      await pb.collection('meal_slots').delete(id);
      await refreshSlots();
    } catch {
      toast('Could not remove slot', 'err');
    }
  };

  /* ----- Theme ----- */
  const applyTheme = async (color: string) => {
    setTheme(color);
    if (profile) {
      const pb = getClient(endpoint);
      try {
        await pb.collection('profiles').update(profile.id, { theme_accent: color });
      } catch {
        /* local persistence already applied */
      }
    }
  };

  return (
    <div className="profile">
      <h1 className="page-title">Profile &amp; goals</h1>

      {/* Body metrics */}
      <Card>
        <CardTitle>Your body</CardTitle>
        <div className="form-grid">
          <Field label="Height (cm)">
            <input
              type="number"
              min={0}
              value={form.height_cm}
              onChange={(e) => setForm({ ...form, height_cm: e.target.value })}
            />
          </Field>
          <Field label="Birth year">
            <input
              type="number"
              min={1900}
              max={new Date().getFullYear()}
              value={form.birth_year}
              onChange={(e) => setForm({ ...form, birth_year: e.target.value })}
            />
          </Field>
          <Field label="Sex">
            <select value={form.sex} onChange={(e) => setForm({ ...form, sex: e.target.value as Sex })}>
              <option value="">Select…</option>
              <option value="male">Male</option>
              <option value="female">Female</option>
              <option value="other">Other</option>
            </select>
          </Field>
          <Field label="Activity level">
            <select
              value={form.activity_level}
              onChange={(e) => setForm({ ...form, activity_level: e.target.value as ActivityLevel })}
            >
              <option value="">Select…</option>
              <option value="sedentary">Sedentary</option>
              <option value="light">Light</option>
              <option value="moderate">Moderate</option>
              <option value="very">Very active</option>
              <option value="extreme">Extreme</option>
            </select>
          </Field>
          <Field label="Body fat % (for Katch-McArdle)" hint="Optional">
            <input
              type="number"
              min={1}
              max={70}
              step={0.5}
              value={form.body_fat_pct}
              onChange={(e) => setForm({ ...form, body_fat_pct: e.target.value })}
            />
          </Field>
          <Field label="Weight (kg)" hint="Saved as a weights record">
            <input
              type="number"
              min={0}
              step={0.1}
              value={form.weight_kg}
              onChange={(e) => setForm({ ...form, weight_kg: e.target.value })}
            />
          </Field>
          <Field label="Formula">
            <select
              value={form.tdee_formula}
              onChange={(e) => setForm({ ...form, tdee_formula: e.target.value as TdeeFormula })}
            >
              <option value="mifflin">Mifflin-St Jeor</option>
              <option value="katch">Katch-McArdle</option>
            </select>
          </Field>
        </div>
        <Button onClick={() => void saveProfile()} disabled={saving}>
          {saving ? 'Saving…' : 'Save profile'}
        </Button>
      </Card>

      {/* TDEE card */}
      <Card className="tdee-card">
        <CardTitle>Daily energy</CardTitle>
        {tdee == null ? (
          <p className="tdee-hint">
            Fill in height, birth year, sex and activity level (plus weight) to compute your target.
          </p>
        ) : (
          <>
            <div className="tdee-row">
              <div>
                <div className="tdee-label">TDEE · {FORMULA_LABEL[form.tdee_formula]}</div>
                <div className="tdee-big">{formatInt(tdee)} kcal</div>
                <div className="tdee-sub">
                  BMR {formatInt(computeBmr(input, form.tdee_formula) ?? 0)} ×{' '}
                  {form.activity_level ? ACTIVITY_FACTORS[form.activity_level] : '—'}
                </div>
              </div>
              <div className="tdee-target">
                <div className="tdee-label">Target · {goal}</div>
                <div className="tdee-big tdee-accent">{target != null ? formatInt(target) : '—'}</div>
                <div className="tdee-sub">
                  {goal === 'lose' ? '−500' : goal === 'gain' ? '+350' : '±0'} kcal
                </div>
              </div>
            </div>
            <div className="macro-preview">
              <div>
                <span className="mp-label">Protein {macros.protein_pct}%</span>
                <span className="mp-val">{formatInt(split.proteinKcal)} kcal</span>
              </div>
              <div>
                <span className="mp-label">Carbs {split.carbsPct}%</span>
                <span className="mp-val">{formatInt(split.carbsKcal)} kcal</span>
              </div>
              <div>
                <span className="mp-label">Fat {macros.fat_pct}%</span>
                <span className="mp-val">{formatInt(split.fatKcal)} kcal</span>
              </div>
            </div>
          </>
        )}
      </Card>

      {/* Goal + macro split */}
      <Card>
        <CardTitle>Goal</CardTitle>
        <Segmented
          value={goal}
          options={[
            { value: 'lose', label: 'Lose' },
            { value: 'maintain', label: 'Maintain' },
            { value: 'gain', label: 'Gain' },
          ]}
          onChange={(g) => {
            setGoal(g);
            void saveGoalMacros(g, macros);
          }}
        />
        <div className="macro-inputs">
          {(
            [
              ['protein_pct', 'Protein %'],
              ['carbs_pct', 'Carbs %'],
              ['fat_pct', 'Fat %'],
            ] as const
          ).map(([key, label]) => (
            <Field key={key} label={label}>
              <input
                type="number"
                min={0}
                max={100}
                value={macros[key]}
                onChange={(e) => {
                  const next = { ...macros, [key]: Math.max(0, Math.min(100, Number(e.target.value) || 0)) };
                  setMacros(next);
                  void saveGoalMacros(goal, next);
                }}
              />
            </Field>
          ))}
        </div>
        {macros.protein_pct + macros.carbs_pct + macros.fat_pct !== 100 && (
          <p className="macro-warn">Macro percentages currently sum to {macros.protein_pct + macros.carbs_pct + macros.fat_pct}% — carbs are adjusted to fill the remainder when saved.</p>
        )}
      </Card>

      {/* Meal plan editor */}
      <Card>
        <CardTitle right={<span className={'pct-sum' + (pctSum === 100 ? ' pct-ok' : '')}>{pctSum}% of 100%</span>}>
          Meal plan
        </CardTitle>
        {slots.length === 0 && <p className="tdee-hint">No meal slots yet.</p>}
        <ul className="slot-list">
          {slots.map((s, i) => (
            <li key={s.id} className="slot-row">
              <span className="slot-order">{i + 1}</span>
              <span className="slot-name">{s.name}</span>
              <input
                className="slot-pct"
                type="number"
                min={0}
                max={100}
                value={s.pct_allocation ?? 0}
                onChange={(e) => void setSlotPct(s.id, Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
              />
              <span className="slot-pct-sign">%</span>
              <div className="slot-actions">
                <button className="icon-btn" onClick={() => void moveSlot(i, -1)} disabled={i === 0} aria-label={`Move ${s.name} up`}>
                  ↑
                </button>
                <button
                  className="icon-btn"
                  onClick={() => void moveSlot(i, 1)}
                  disabled={i === slots.length - 1}
                  aria-label={`Move ${s.name} down`}
                >
                  ↓
                </button>
                <button className="icon-btn icon-btn-danger" onClick={() => void removeSlot(s.id)} aria-label={`Remove ${s.name}`}>
                  ✕
                </button>
              </div>
            </li>
          ))}
        </ul>
        {pctSum !== 100 && <p className="macro-warn">Allocations must sum to 100%.</p>}
      </Card>

      {/* Theme picker */}
      <Card>
        <CardTitle>Accent theme</CardTitle>
        <div className="swatches">
          {THEME_PRESETS.map((t) => (
            <button
              key={t.color}
              className={'swatch' + (theme.toLowerCase() === t.color.toLowerCase() ? ' swatch-active' : '')}
              style={{ background: t.color }}
              onClick={() => void applyTheme(t.color)}
              title={t.name}
              aria-label={`Theme ${t.name}`}
            />
          ))}
        </div>
        <div className="custom-theme">
          <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(theme) ? theme : '#0f7a5f'} onChange={(e) => void applyTheme(e.target.value)} />
          <input
            type="text"
            placeholder="#0f7a5f"
            value={customTheme}
            onChange={(e) => setCustomTheme(e.target.value)}
            onBlur={() => {
              if (/^#[0-9a-fA-F]{6}$/.test(customTheme)) void applyTheme(customTheme);
              setCustomTheme('');
            }}
          />
        </div>
      </Card>

      <Card>
        <CardTitle>Data</CardTitle>
        <p className="tdee-hint">Bring your history from other apps, or export your diary.</p>
        <Link to="/profile/import" className="btn btn-outline btn-md import-link">
          Import / Export
        </Link>
      </Card>
    </div>
  );
}
