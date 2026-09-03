import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp, saolrianSend } from '../state/AppContext';
import type { Food } from '../lib/types';
import { getClient, UnreachableError } from '../lib/pb';
import { createDiaryEntry } from '../lib/offline';
import { foodMath } from '../lib/nutrition';
import { normalizeSearch, normalizeBarcode } from '../lib/normalize';
import { formatInt } from '../lib/format';
import { Button, Card, Empty, Field, Sheet, Spinner, Stepper, TextInput, useToast } from '../components/ui';
import { cn } from '../lib/cn';
import ScanSheet from '../components/ScanSheet';

/** Add food — prototype log-food view: subhead + search with scan button,
 * hairline result rows, detail card with nutri cells, gram stepper, live
 * kcal readout and pill meal-slot picker. */

type Stage = 'search' | 'detail';

/* barcode scan glyph, from the prototype */
const scanGlyph = (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
    <path d="M3 5v14M7 8v8M11 6v12M15 8v8M19 5v14" />
  </svg>
);

/* Line-icon chip — matches MealGroup's IC_CHIP sizing pattern. */
const IC_CHIP =
  'flex h-9 w-9 flex-none items-center justify-center rounded-md border border-accent-line bg-accent-soft ' +
  '[&_svg]:h-[18px] [&_svg]:w-[18px] [&_svg]:fill-none [&_svg]:stroke-accent-ink ' +
  '[&_svg]:[stroke-width:2] [&_svg]:[stroke-linecap:round] [&_svg]:[stroke-linejoin:round]';

const NCELL = 'min-w-0 flex-1 rounded-md border px-2.5 py-2.5';
const NLABEL = 'mt-1 text-2xs font-semibold uppercase tracking-[.04em] text-text-faint';

export default function AddFood() {
  const { endpoint, slots, refreshSlots, userId } = useApp();
  const navigate = useNavigate();
  const toast = useToast();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Food[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState('');
  const [stage, setStage] = useState<Stage>('search');
  const [selected, setSelected] = useState<Food | null>(null);
  const [grams, setGrams] = useState(100);
  const [slotId, setSlotId] = useState<string>('');
  const [adding, setAdding] = useState(false);
  const [barcodeOpen, setBarcodeOpen] = useState(false);
  const [barcodeVal, setBarcodeVal] = useState('');
  const [newSlotName, setNewSlotName] = useState('');
  const [quickOpen, setQuickOpen] = useState(false);
  const [qaKcal, setQaKcal] = useState('');
  const [qaP, setQaP] = useState('');
  const [qaC, setQaC] = useState('');
  const [qaF, setQaF] = useState('');
  const [qaAdding, setQaAdding] = useState(false);
  const [qaErr, setQaErr] = useState('');
  const debounce = useRef<number | undefined>(undefined);

  useEffect(() => {
    window.clearTimeout(debounce.current);
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setSearchErr('');
      return;
    }
    setSearching(true);
    debounce.current = window.setTimeout(async () => {
      try {
        const pb = getClient(endpoint);
        const raw = await saolrianSend<{ results?: Food[]; local?: Food[]; remote?: Food[] }>(
          pb,
          'GET',
          `/api/saolrian/food/search?q=${encodeURIComponent(q)}`,
        );
        setResults(normalizeSearch(raw));
        setSearchErr('');
      } catch (ex) {
        setSearchErr(
          ex instanceof UnreachableError
            ? 'Server unreachable — check your connection.'
            : ex instanceof Error
              ? ex.message
              : 'Search failed',
        );
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => window.clearTimeout(debounce.current);
  }, [query, endpoint]);

  useEffect(() => {
    if (!slotId && slots.length > 0) setSlotId(slots[0].id);
  }, [slots, slotId]);

  const openDetail = (food: Food) => {
    setSelected(food);
    setGrams(Math.round(food.default_serving_g || 100) || 100);
    setStage('detail');
  };

  const lookupBarcode = async (codeArg?: string) => {
    const code = (codeArg ?? barcodeVal).trim();
    if (!/^\d{6,}$/.test(code)) {
      toast('Enter a numeric barcode (at least 6 digits.', 'err');
      return;
    }
    try {
      const pb = getClient(endpoint);
      const raw = await saolrianSend<unknown>(pb, 'GET', `/api/saolrian/food/barcode/${code}`);
      const food = normalizeBarcode(raw);
      if (!food) throw new Error('not found');
      setBarcodeOpen(false);
      setBarcodeVal('');
      openDetail(food);
    } catch (ex) {
      if (ex instanceof UnreachableError) toast('Server unreachable — try again when online.', 'err');
      else toast('No product found for that code.', 'err');
    }
  };

  const createSlot = async () => {
    const name = newSlotName.trim();
    if (!name) return;
    const pb = getClient(endpoint);
    try {
      const rec = await pb.collection('meal_slots').create({
        user: pb.authStore.record?.id,
        name,
        sort_order: slots.length + 1,
      });
      await refreshSlots();
      setSlotId(rec.id);
      setNewSlotName('');
      toast(`Added “${name}” slot`);
    } catch (ex) {
      toast(ex instanceof Error ? ex.message : 'Could not create slot', 'err');
    }
  };

  const submitQuickAdd = async () => {
    const kcal = parseInt(qaKcal, 10);
    if (!Number.isFinite(kcal) || kcal <=  0) {
      setQaErr('Enter a calorie amount first.');
      return;
    }
    if (!slotId) {
      setQaErr('Pick a meal slot first.');
      return;
    }
    setQaAdding(true);
    setQaErr('');
    const num = (s: string) => { const v = parseFloat(s); return Number.isFinite(v) ? v :  0; };
    const result = await createDiaryEntry(endpoint, userId ?? '', {
      meal_slot: slotId,
      name_snapshot: 'Quick add',
      brand_snapshot: '',
      kcal,
      protein: num(qaP),
      carbs: num(qaC),
      fat: num(qaF),
      logged_at: new Date().toISOString(),
    });
    setQaAdding(false);
    if (result.queued) {
      toast('Saved offline — will sync when you reconnect');
    } else if (!result.ok) {
      toast(result.error ?? 'Could not add entry', 'err');
      return;
    } else {
      toast(`Quick add · ${formatInt(kcal)} kcal`);
    }
    setQuickOpen(false);
    setQaKcal('');
    setQaP('');
    setQaC('');
    setQaF('');
    navigate('/today');
  };

  const addEntry = async () => {
    if (!selected || !slotId) return;
    setAdding(true);
    const m = foodMath(
      selected.kcal_per_100g,
      selected.protein_per_100g,
      selected.carbs_per_100g,
      selected.fat_per_100g,
      grams,
    );
    const result = await createDiaryEntry(endpoint, userId ?? '', {
      meal_slot: slotId,
      name_snapshot: selected.name,
      brand_snapshot: selected.brand ?? '',
      grams,
      kcal: m.kcal,
      protein: m.protein,
      carbs: m.carbs,
      fat: m.fat,
      logged_at: new Date().toISOString(),
    });
    setAdding(false);
    if (result.queued) {
      toast('Saved offline — will sync when you reconnect');
    } else if (!result.ok) {
      toast(result.error ?? 'Could not add entry', 'err');
      return;
    } else {
      toast(`Added ${selected.name} · ${formatInt(m.kcal)} kcal`);
    }
    navigate('/today');
  };

  const math = selected
    ? foodMath(
        selected.kcal_per_100g,
        selected.protein_per_100g,
        selected.carbs_per_100g,
        selected.fat_per_100g,
        grams,
      )
    : null;

  /* Meal-slot pill row + inline "new slot" control — identical in the detail
   * card and the Quick add sheet, so built once and rendered in both. */
  const slotControls = (
    <>
      <div className="no-scrollbar flex gap-2 overflow-x-auto pb-1">
        {slots.map((s) => (
          <button
            key={s.id}
            type="button"
            className={cn(
              'flex-none rounded-full border px-4 py-2 text-sm transition',
              s.id === slotId
                ? 'border-accent bg-accent font-semibold text-white'
                : 'border-border bg-raised font-medium text-text hover:border-accent-line',
            )}
            onClick={() => setSlotId(s.id)}
          >
            {s.name}
          </button>
        ))}
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <TextInput
          className="min-w-0 flex-1 border-dashed"
          placeholder="＋ New slot name…"
          value={newSlotName}
          onChange={(e) => setNewSlotName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void createSlot(); }}
        />
        <Button variant="outline" size="sm" onClick={() => void createSlot()} disabled={!newSlotName.trim()}>
          New
        </Button>
      </div>
    </>
  );

  return (
    <div className="pb-6">
      <div className="flex items-center justify-between px-6 pb-3 pt-4">
        <button
          className="flex h-9 w-9 flex-none items-center justify-center rounded-md border border-border bg-raised text-text"
          onClick={() => navigate('/today')}
          aria-label="Back"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <h2 className="text-xl font-bold tracking-[-.02em]">Add food</h2>
        <span className="w-9" />
      </div>

      <div className="relative mt-0.5 px-6">
        <TextInput
          type="text"
          autoFocus
          className="pr-12"
          placeholder="Search foods or scan barcode"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          className="absolute right-8 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md bg-accent-soft text-accent-ink"
          aria-label="Barcode lookup"
          title="Barcode lookup"
          onClick={() => setBarcodeOpen(true)}
        >
          {scanGlyph}
        </button>
      </div>

      {stage === 'search' && (
        <div className="px-6">
          <button
            className="mt-3.5 flex w-full items-center gap-3 rounded-lg border border-border bg-raised px-4 py-3.5 text-left shadow-card transition hover:border-accent-line active:scale-[.99]"
            onClick={() => setQuickOpen(true)}
          >
            <span className={IC_CHIP}>
              <svg viewBox="0 0 24 24" aria-hidden>
                <path d="M12 5v14M5 12h14" />
              </svg>
            </span>
            <span className="flex flex-col gap-0.5">
              <span className="text-base font-bold text-text">Quick add</span>
              <span className="text-xs text-text-faint">Just calories — no food search</span>
            </span>
            <span className="ml-auto flex text-text-faint [&_svg]:h-4 [&_svg]:w-4 [&_svg]:fill-none [&_svg]:stroke-current [&_svg]:[stroke-width:2] [&_svg]:[stroke-linecap:round] [&_svg]:[stroke-linejoin:round]">
              <svg viewBox="0 0 24 24" aria-hidden>
                <path d="M9 6l6 6-6 6" />
              </svg>
            </span>
          </button>

          <div className="pb-4">
            {searching && (
              <div className="flex items-center gap-2 pt-4 text-sm text-text-faint">
                <Spinner /> Searching…
              </div>
            )}
            {searchErr && (
              <div className="mt-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                {searchErr}
              </div>
            )}
            {!searching && query.trim().length >= 2 && results.length === 0 && !searchErr && (
              <Empty>No foods match “{query.trim()}”.</Empty>
            )}
            {results.length > 0 && (
              <div className="pt-4">
                <div className="mb-3 flex items-baseline justify-between">
                  <h2 className="text-md font-bold tracking-[-.01em]">Results</h2>
                  <span className="text-xs font-semibold text-text-faint">{results.length} found</span>
                </div>
                <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-raised shadow-card">
                  {results.map((f, i) => (
                    <div
                      key={`${f.name}-${f.brand ?? ''}-${i}`}
                      className="flex items-center gap-3 p-3.5"
                      role="button"
                      tabIndex={0}
                      onClick={() => openDetail(f)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') openDetail(f);
                      }}
                    >
                      <div className={IC_CHIP}>
                        <svg viewBox="0 0 24 24" aria-hidden>
                          <path d="M4 19h16M6 19v-2a6 6 0 0 1 12 0v2" />
                        </svg>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-base font-semibold tracking-[-.01em]">{f.name}</div>
                        <div className="mt-0.5 text-xs text-text-faint">
                          {f.brand || 'Generic'}
                          {f.local ? ' · your food' : ''}
                        </div>
                      </div>
                      <div className="whitespace-nowrap text-base font-bold tracking-[-.01em]">
                        {formatInt(f.kcal_per_100g)} <small className="text-2xs font-medium text-text-faint">kcal/100g</small>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {query.trim().length < 2 && !searchErr && (
              <Empty>Type at least 2 characters to search the food database.</Empty>
            )}
          </div>
        </div>
      )}

      {stage === 'detail' && selected && math && (
        <div className="px-6 pt-4">
          <Card className="px-[18px] py-4">
            <div className="text-2xs font-semibold uppercase tracking-[.06em] text-text-faint">
              {selected.brand || 'Generic'}
            </div>
            <div className="mt-1 text-lg font-bold tracking-[-.01em]">{selected.name}</div>

            <div className="mt-3.5 flex gap-2.5">
              <div className={cn(NCELL, 'border-accent-line bg-accent-soft')}>
                <div className="whitespace-nowrap text-lg font-bold tracking-[-.01em] text-accent-ink">
                  {formatInt(math.kcal)}
                </div>
                <div className={NLABEL}>kcal</div>
              </div>
              {(
                [
                  ['Protein', `${math.protein}g`],
                  ['Carbs', `${math.carbs}g`],
                  ['Fat', `${math.fat}g`],
                ] as const
              ).map(([label, val]) => (
                <div key={label} className={cn(NCELL, 'border-border bg-surface')}>
                  <div className="whitespace-nowrap text-lg font-bold tracking-[-.01em]">{val}</div>
                  <div className={NLABEL}>{label}</div>
                </div>
              ))}
            </div>

            <div className="mt-2 text-2xs text-text-faint">
              for {grams} g · {formatInt(selected.kcal_per_100g)} kcal per 100 g
              {selected.barcode ? ` · ${selected.barcode}` : ''}
            </div>

            <div className="mt-3.5 flex items-center gap-3">
              <span className="text-sm font-semibold">Serving</span>
              <Stepper
                value={grams}
                onChange={setGrams}
                step={10}
                min={0}
                suffix="g"
                inputMode="numeric"
                aria-label="Serving size in grams"
              />
              <span className="ml-auto text-2xs text-text-faint">Source: Open Food Facts ↗</span>
            </div>

            <div className="mb-1.5 mt-3.5 text-xs font-semibold uppercase tracking-[.05em] text-text-faint">
              Add to meal
            </div>
            {slotControls}

            <Button className="mt-4" block onClick={() => void addEntry()} disabled={adding || !slotId}>
              {adding ? 'Adding…' : 'Add to diary'}
            </Button>
          </Card>
        </div>
      )}

      {quickOpen && (
        <Sheet open onClose={() => setQuickOpen(false)} title="Quick add">
          <div className="mb-3.5 mt-2 text-sm leading-normal text-text-muted">
            Calories with no search — macros optional. Pick a meal, done.
          </div>
          <Field label="Calories (kcal)">
            <TextInput
              type="number"
              min={0}
              inputMode="numeric"
              autoFocus
              placeholder="e.g. 250"
              value={qaKcal}
              onChange={(e) => setQaKcal(e.target.value.replace(/\D/g, ''))}
              onKeyDown={(e) => { if (e.key === 'Enter') void submitQuickAdd(); }}
            />
          </Field>
          <div className="mb-3.5 mt-2.5 grid grid-cols-3 gap-2.5">
            <Field label="Protein (g)">
              <TextInput type="number" min={0} inputMode="decimal" placeholder="0" value={qaP} onChange={(e) => setQaP(e.target.value.replace(/[^\d.]/g, ''))} />
            </Field>
            <Field label="Carbs (g)">
              <TextInput type="number" min={0} inputMode="decimal" placeholder="0" value={qaC} onChange={(e) => setQaC(e.target.value.replace(/[^\d.]/g, ''))} />
            </Field>
            <Field label="Fat (g)">
              <TextInput type="number" min={0} inputMode="decimal" placeholder="0" value={qaF} onChange={(e) => setQaF(e.target.value.replace(/[^\d.]/g, ''))} />
            </Field>
          </div>
          <div className="mb-2 text-2xs font-semibold uppercase tracking-[.05em] text-text-faint">Add to meal</div>
          {slotControls}
          {qaErr && <div className="mt-2 text-xs text-danger">{qaErr}</div>}
          <div className="mt-3.5 flex gap-2.5">
            <Button variant="outline" className="flex-1" onClick={() => setQuickOpen(false)}>Cancel</Button>
            <Button className="flex-1" loading={qaAdding} onClick={() => void submitQuickAdd()}>Add</Button>
          </div>
        </Sheet>
      )}

      <ScanSheet open={barcodeOpen} onClose={() => setBarcodeOpen(false)} onCode={(code) => { void lookupBarcode(code); }} />
    </div>
  );
}
