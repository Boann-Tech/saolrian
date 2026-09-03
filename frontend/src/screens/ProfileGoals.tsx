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
import { Button, Card, Field, Segmented, Select, Sheet, TextInput, useToast } from '../components/ui';
import { cn } from '../lib/cn';

/** Profile & goals — prototype view: avatar card, sectioned hairline
 * forms, TDEE gradient card with goal Segmented, meal plan rows, and a
 * bottom-sheet theme picker (appearance mode + 8 accent presets + custom). */

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

const HINT = 'text-sm leading-normal text-text-muted';
const ICON_BTN =
  'flex h-7 w-7 items-center justify-center rounded-md border border-border bg-raised text-xs text-text-muted ' +
  'disabled:opacity-35 disabled:cursor-default hover:border-accent-line hover:text-accent-ink';
const ICON_BTN_DANGER =
  'flex h-7 w-7 items-center justify-center rounded-md border border-border bg-raised text-xs text-text-muted ' +
  'disabled:opacity-35 disabled:cursor-default hover:border-danger hover:text-danger';

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
  const { endpoint, profile, refreshProfile, slots, refreshSlots, theme, setTheme, mode, setMode } = useApp();
  const toast = useToast();
  const [form, setForm] = useState<ProfileForm>(() => fromProfile(profile));
  const [saving, setSaving] = useState(false);
  const [goal, setGoal] = useState<Goal>(profile?.goal ?? 'maintain');
  const [macros, setMacros] = useState({
    protein_pct: profile?.protein_pct ?? DEFAULT_MACROS.protein_pct,
    carbs_pct: profile?.carbs_pct ?? DEFAULT_MACROS.carbs_pct,
    fat_pct: profile?.fat_pct ?? DEFAULT_MACROS.fat_pct,
  });
  const [sheetOpen, setSheetOpen] = useState(false);

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

  const initials = (() => {
    const n = ((profile?.['name'] as string | undefined) ?? '').trim();
    if (!n) return 'S';
    return n
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('');
  })();

  return (
    <div>
      <div className="flex items-center justify-between px-6 pb-3 pt-4">
        <h2 className="text-xl font-bold tracking-[-.02em]">Profile &amp; goals</h2>
      </div>

      {/* Identity card (prototype avatar card) */}
      <div className="px-6 pt-5">
        <Card className="flex items-center gap-3.5 p-5">
          <div className="flex h-[52px] w-[52px] flex-none items-center justify-center rounded-full bg-accent text-lg font-bold text-white">
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-md font-bold">{(profile?.['name'] as string) || 'Signed in'}</div>
            <div className="mt-0.5 text-xs text-text-faint">
              {profile ? 'Profile on ' : 'Sign-in active · '}
              {new URL(endpoint).host}
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-2xs font-semibold text-good-ink">
              <span className="inline-block h-[7px] w-[7px] rounded-full bg-good shadow-[0_0_6px_rgba(62,207,142,.8)]" />{' '}
              Hosted · {new URL(endpoint).host}
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setSheetOpen(true)}>
            Theme
          </Button>
        </Card>
      </div>

      {/* Body metrics (prototype sectioned hairline form) */}
      <div className="px-6 pt-5">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-md font-bold tracking-[-.01em]">Your numbers</h2>
        </div>
        <Card className="p-4">
          <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2">
            <Field label="Height (cm)">
              <TextInput
                type="number"
                min={0}
                value={form.height_cm}
                onChange={(e) => setForm({ ...form, height_cm: e.target.value })}
              />
            </Field>
            <Field label="Birth year">
              <TextInput
                type="number"
                min={1900}
                max={new Date().getFullYear()}
                value={form.birth_year}
                onChange={(e) => setForm({ ...form, birth_year: e.target.value })}
              />
            </Field>
            <Field label="Sex">
              <Select value={form.sex} onChange={(e) => setForm({ ...form, sex: e.target.value as Sex })}>
                <option value="">Select…</option>
                <option value="male">Male</option>
                <option value="female">Female</option>
                <option value="other">Other</option>
              </Select>
            </Field>
            <Field label="Activity level">
              <Select
                value={form.activity_level}
                onChange={(e) => setForm({ ...form, activity_level: e.target.value as ActivityLevel })}
              >
                <option value="">Select…</option>
                <option value="sedentary">Sedentary</option>
                <option value="light">Light</option>
                <option value="moderate">Moderate</option>
                <option value="very">Very active</option>
                <option value="extreme">Extreme</option>
              </Select>
            </Field>
            <Field label="Body fat % (for Katch-McArdle)" hint="Optional">
              <TextInput
                type="number"
                min={1}
                max={70}
                step={0.5}
                value={form.body_fat_pct}
                onChange={(e) => setForm({ ...form, body_fat_pct: e.target.value })}
              />
            </Field>
            <Field label="Weight (kg)" hint="Saved as a weights record">
              <TextInput
                type="number"
                min={0}
                step={0.1}
                value={form.weight_kg}
                onChange={(e) => setForm({ ...form, weight_kg: e.target.value })}
              />
            </Field>
            <Field label="Formula">
              <Select
                value={form.tdee_formula}
                onChange={(e) => setForm({ ...form, tdee_formula: e.target.value as TdeeFormula })}
              >
                <option value="mifflin">Mifflin-St Jeor</option>
                <option value="katch">Katch-McArdle</option>
              </Select>
            </Field>
          </div>
        </Card>
      </div>

      {/* TDEE card (prototype gradient card + goal Segmented) */}
      <div className="px-6 pt-5">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-md font-bold tracking-[-.01em]">TDEE estimate</h2>
        </div>
        <Card className="bg-gradient-to-br from-surface to-accent-soft p-5">
          {tdee == null ? (
            <p className={HINT}>
              Fill in height, birth year, sex and activity level (plus weight) to compute your target.
            </p>
          ) : (
            <>
              <div className="text-2xs font-semibold uppercase tracking-[.05em] text-text-faint">
                {FORMULA_LABEL[form.tdee_formula]}
                {form.activity_level ? ` · ${form.activity_level} ×${ACTIVITY_FACTORS[form.activity_level]}` : ''}
              </div>
              <div className="mt-1 text-[32px] font-bold tracking-[-.02em]">
                {formatInt(tdee)} <small className="text-base font-medium text-text-muted">kcal/day</small>
              </div>
              <div className="mt-2.5 text-sm font-medium text-text-muted">
                BMR {formatInt(computeBmr(input, form.tdee_formula) ?? 0)} · target{' '}
                {target != null ? formatInt(target) : '—'} kcal/day to {goal}
              </div>
            </>
          )}
          <Segmented
            className="mt-4"
            aria-label="Goal"
            value={goal}
            onChange={(g) => {
              setGoal(g);
              void saveGoalMacros(g, macros);
            }}
            options={[
              { value: 'lose', label: 'Lose' },
              { value: 'maintain', label: 'Maintain' },
              { value: 'gain', label: 'Gain' },
            ]}
          />
          <div className="mt-3.5 flex gap-2.5">
            {(
              [
                ['Protein', split.proteinKcal, macros.protein_pct],
                ['Carbs', split.carbsKcal, split.carbsPct],
                ['Fat', split.fatKcal, macros.fat_pct],
              ] as const
            ).map(([label, kcal, pct]) => (
              <div key={label} className="min-w-0 flex-1 rounded-lg border border-border bg-raised p-3.5">
                <div className="text-2xs font-semibold uppercase tracking-[.04em] text-text-faint">{label}</div>
                <div className="mt-1 truncate text-lg font-bold tracking-[-.01em]">
                  {formatInt(kcal)} <small className="text-2xs font-medium text-text-faint">kcal · {pct}%</small>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3.5 grid grid-cols-3 gap-2.5">
            {(
              [
                ['protein_pct', 'Protein %'],
                ['carbs_pct', 'Carbs %'],
                ['fat_pct', 'Fat %'],
              ] as const
            ).map(([key, label]) => (
              <Field key={key} label={label}>
                <TextInput
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
            <p className="mt-2.5 text-xs leading-normal text-warn">
              Macro percentages currently sum to {macros.protein_pct + macros.carbs_pct + macros.fat_pct}% — carbs are
              adjusted to fill the remainder when saved.
            </p>
          )}
        </Card>
      </div>

      {/* Meal plan editor (prototype hairline rows) */}
      <div className="px-6 pt-5">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-md font-bold tracking-[-.01em]">Meal plan</h2>
          <span className={cn('text-xs font-semibold', pctSum === 100 ? 'text-good-ink' : 'text-text-faint')}>
            {pctSum}% of 100%
          </span>
        </div>
        <Card className="px-[18px] py-1">
          {slots.length === 0 && <p className={HINT}>No meal slots yet.</p>}
          <ul className="m-0 list-none p-0">
            {slots.map((s, i) => (
              <li
                key={s.id}
                className="flex items-center gap-2.5 border-b border-border py-3.5 text-base last:border-0"
              >
                <span className="text-text-faint">⋮⋮</span>
                <span className="flex-1">{s.name}</span>
                <input
                  className="w-[54px] rounded-md border-[1.5px] border-border px-1.5 py-1 text-right text-sm font-semibold"
                  type="number"
                  min={0}
                  max={100}
                  value={s.pct_allocation ?? 0}
                  onChange={(e) => void setSlotPct(s.id, Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                />
                <span className="text-xs text-text-faint">%</span>
                <div className="flex gap-1">
                  <button
                    className={ICON_BTN}
                    onClick={() => void moveSlot(i, -1)}
                    disabled={i === 0}
                    aria-label={`Move ${s.name} up`}
                  >
                    ↑
                  </button>
                  <button
                    className={ICON_BTN}
                    onClick={() => void moveSlot(i, 1)}
                    disabled={i === slots.length - 1}
                    aria-label={`Move ${s.name} down`}
                  >
                    ↓
                  </button>
                  <button
                    className={ICON_BTN_DANGER}
                    onClick={() => void removeSlot(s.id)}
                    aria-label={`Remove ${s.name}`}
                  >
                    ✕
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {pctSum !== 100 && <p className="mt-2.5 text-xs leading-normal text-warn">Allocations must sum to 100%.</p>}
        </Card>
      </div>

      {/* Save + data */}
      <div className="px-6 pt-5">
        <Button block loading={saving} onClick={() => void saveProfile()}>
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
      </div>

      <div className="px-6 pb-6 pt-5">
        <Card className="p-4">
          <div className="text-xs font-semibold text-text-muted">Data</div>
          <p className={cn(HINT, 'mb-3 mt-2')}>Bring your history from other apps, or export your diary.</p>
          <Link
            to="/profile/import"
            className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-border bg-raised px-3.5 py-3 text-base font-semibold text-text transition hover:border-accent-line hover:text-accent-ink active:scale-[.98]"
          >
            Import / Export
          </Link>
        </Card>
      </div>

      {/* ── Theme sheet ── */}
      <Sheet open={sheetOpen} onClose={() => setSheetOpen(false)} title="Accent theme">
        <p className="mt-1 text-xs leading-normal text-text-faint">
          Saolrian ships with <b>Turf</b> green — but the accent is yours. Live preview, saved to this device and your
          profile.
        </p>

        <div className="mt-4">
          <span className="text-xs font-semibold text-text-muted">Appearance</span>
          <Segmented
            className="mt-2"
            aria-label="Appearance"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'system', label: 'System' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </div>

        <div className="mt-4 grid grid-cols-4 gap-2.5">
          {THEME_PRESETS.map((t) => {
            const on = theme.toLowerCase() === t.color.toLowerCase();
            return (
              <button
                key={t.color}
                type="button"
                className={cn(
                  'rounded-md border-[1.5px] border-border p-2 text-center transition hover:-translate-y-px',
                  on && 'border-text',
                )}
                onClick={() => void applyTheme(t.color)}
                aria-label={`Theme ${t.name}`}
              >
                <span
                  className="mx-auto mb-1.5 block h-[26px] w-[26px] rounded-full shadow-[inset_0_0_0_2px_rgba(255,255,255,.55),0_1px_4px_rgba(10,37,64,.25)]"
                  style={{ background: t.color }}
                />
                <span className={cn('text-2xs font-semibold', on ? 'text-text' : 'text-text-muted')}>{t.name}</span>
              </button>
            );
          })}
        </div>

        <div className="mt-3.5 flex items-center gap-2.5 rounded-lg border-[1.5px] border-dashed border-border px-3 py-2.5">
          <input
            type="color"
            className="h-[34px] w-[34px] flex-none cursor-pointer rounded-md border-0 bg-transparent p-0"
            value={/^#[0-9a-fA-F]{6}$/.test(theme) ? theme : '#0f7a5f'}
            onChange={(e) => void applyTheme(e.target.value)}
            aria-label="Custom accent colour"
          />
          <span className="flex-1 text-xs font-medium text-text-muted">
            Custom colour — tap the chip to pick any shade
          </span>
        </div>

        <Button className="mt-4" block onClick={() => setSheetOpen(false)}>
          Save theme
        </Button>
      </Sheet>
    </div>
  );
}
