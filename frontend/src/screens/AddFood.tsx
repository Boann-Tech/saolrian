import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp, saolrianSend } from '../state/AppContext';
import type { Food } from '../lib/types';
import { getClient, UnreachableError } from '../lib/pb';
import { createDiaryEntry } from '../lib/offline';
import { foodMath } from '../lib/nutrition';
import { normalizeSearch, normalizeBarcode } from '../lib/normalize';
import { formatInt } from '../lib/format';
import { Field, Spinner, useToast } from '../components/ui';
import ScanSheet from '../components/ScanSheet';
import './addfood.css';

/** Add food — prototype log-food view: subhead + search with scan button,
 * hairline result rows (.mrow), detail card with nutri cells, gram
 * stepper, live kcal readout and pill meal-slot picker. */

type Stage = 'search' | 'detail';

/* barcode scan glyph, from the prototype */
const scanGlyph = (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
    <path d="M3 5v14M7 8v8M11 6v12M15 8v8M19 5v14" />
  </svg>
);

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

  return (
    <div className="addfood">
      <div className="subhead">
        <button className="backbtn" onClick={() => navigate('/today')} aria-label="Back">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <h2>Add food</h2>
        <span style={{ width: 36 }} />
      </div>

      <div className="searchwrap">
        <input
          type="text"
          className="search"
          autoFocus
          placeholder="Search foods or scan barcode"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="scanbtn" aria-label="Barcode lookup" title="Barcode lookup" onClick={() => setBarcodeOpen(true)}>
          {scanGlyph}
        </button>
      </div>

      {stage === 'search' && (
        <>
        <button className="qa-tile" onClick={() => setQuickOpen(true)}>
          <span className="qa-ic">
            <svg viewBox="0 0 24 24" aria-hidden>
              <path d="M12 5v14M5 12h14" />
            </svg>
          </span>
          <span className="qa-t">
            <span className="qa-tt">Quick add</span>
            <span className="qa-td">Just calories — no food search</span>
          </span>
          <span className="qa-chev">
            <svg viewBox="0 0 24 24" aria-hidden>
              <path d="M9 6l6 6-6 6" />
            </svg>
          </span>
        </button>
        <div className="addfood-results">
          {searching && (
            <div className="addfood-status">
              <Spinner /> Searching…
            </div>
          )}
          {searchErr && <div className="addfood-err">{searchErr}</div>}
          {!searching && query.trim().length >= 2 && results.length === 0 && !searchErr && (
            <p className="empty">No foods match “{query.trim()}”.</p>
          )}
          {results.length > 0 && (
            <div className="sec" style={{ paddingTop: 16 }}>
              <div className="sec-h">
                <h2>Results</h2>
                <span className="addfood-count">{results.length} found</span>
              </div>
              <div className="meals">
                {results.map((f, i) => (
                  <div
                    key={`${f.name}-${f.brand ?? ''}-${i}`}
                    className="mrow"
                    role="button"
                    tabIndex={0}
                    onClick={() => openDetail(f)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') openDetail(f);
                    }}
                  >
                    <div className="ic">
                      <svg viewBox="0 0 24 24" aria-hidden>
                        <path d="M4 19h16M6 19v-2a6 6 0 0 1 12 0v2" />
                      </svg>
                    </div>
                    <div className="b">
                      <div className="n">{f.name}</div>
                      <div className="d">
                        {f.brand || 'Generic'}
                        {f.local ? ' · your food' : ''}
                      </div>
                    </div>
                    <div className="k">
                      {formatInt(f.kcal_per_100g)} <small>kcal/100g</small>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {query.trim().length < 2 && !searchErr && (
            <p className="empty">Type at least 2 characters to search the food database.</p>
          )}
        </div>
        </>
      )}

      {stage === 'detail' && selected && math && (
        <div className="addfood-detail">
          <div className="sec" style={{ paddingTop: 16 }}>
            <div className="card" style={{ padding: '16px 18px' }}>
              <div className="brand">{selected.brand || 'Generic'}</div>
              <div className="fname">{selected.name}</div>
              <div className="nutri">
                <div className="ncell big">
                  <div className="nv2">{formatInt(math.kcal)}</div>
                  <div className="nl">kcal</div>
                </div>
                <div className="ncell">
                  <div className="nv2">{math.protein}g</div>
                  <div className="nl">Protein</div>
                </div>
                <div className="ncell">
                  <div className="nv2">{math.carbs}g</div>
                  <div className="nl">Carbs</div>
                </div>
                <div className="ncell">
                  <div className="nv2">{math.fat}g</div>
                  <div className="nl">Fat</div>
                </div>
              </div>
              <div className="perserv">
                for {grams} g · {formatInt(selected.kcal_per_100g)} kcal per 100 g
                {selected.barcode ? ` · ${selected.barcode}` : ''}
              </div>

              <div className="steprow">
                <span style={{ fontSize: 13, fontWeight: 600 }}>Serving</span>
                <div className="stepper">
                  <button onClick={() => setGrams(Math.max(0, grams - 10))} aria-label="Less">
                    −
                  </button>
                  <span className="ste">
                    <input
                      type="number"
                      value={grams}
                      min={0}
                      step={10}
                      onChange={(e) => setGrams(Math.max(0, Math.round(Number(e.target.value) || 0)))}
                    />
                    g
                  </span>
                  <button onClick={() => setGrams(grams + 10)} aria-label="More">
                    +
                  </button>
                </div>
                <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--faint)' }}>Source: Open Food Facts ↗</span>
              </div>

              <div
                style={{
                  margin: '14px 0 6px',
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'var(--faint)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                Add to meal
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
              <div className="new-slot">
                <input
                  placeholder="＋ New slot name…"
                  value={newSlotName}
                  onChange={(e) => setNewSlotName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void createSlot();
                  }}
                />
                <button className="btn outline sm" onClick={() => void createSlot()} disabled={!newSlotName.trim()}>
                  New
                </button>
              </div>

              <button className="btn" style={{ marginTop: 16 }} onClick={() => void addEntry()} disabled={adding || !slotId}>
                {adding ? 'Adding…' : 'Add to diary'}
              </button>
            </div>
          </div>
        </div>
      )}

      {quickOpen && (
        <div className="scan-scrim" onClick={() => setQuickOpen(false)}>
          <div className="scan-sheet" role="dialog" aria-label="Quick add calories" onClick={(e) => e.stopPropagation()}>
            <div className="grab" />
            <h3>Quick add</h3>
            <div className="sub">Calories with no search — macros optional. Pick a meal, done.</div>
            <Field label="Calories (kcal)">
              <input
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
            <div className="qa-grid">
              <Field label="Protein (g)">
                <input type="number" min={0} inputMode="decimal" placeholder="0" value={qaP} onChange={(e) => setQaP(e.target.value.replace(/[^\d.]/g, ''))} />
              </Field>
              <Field label="Carbs (g)">
                <input type="number" min={0} inputMode="decimal" placeholder="0" value={qaC} onChange={(e) => setQaC(e.target.value.replace(/[^\d.]/g, ''))} />
              </Field>
              <Field label="Fat (g)">
                <input type="number" min={0} inputMode="decimal" placeholder="0" value={qaF} onChange={(e) => setQaF(e.target.value.replace(/[^\d.]/g, ''))} />
              </Field>
            </div>
            <div className="cap" style={{ fontSize: 11.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--faint)', marginBottom:  8 }}>Add to meal</div>
            <div className="mealpills">
              {slots.map((s) => (
                <button key={s.id} className={s.id === slotId ? 'mp on' : 'mp'} onClick={() => setSlotId(s.id)}>
                  {s.name}
                </button>
              ))}
            </div>
            <div className="new-slot">
              <input placeholder="＋ New slot name…" value={newSlotName} onChange={(e) => setNewSlotName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void createSlot(); }} />
              <button className="btn outline sm" onClick={() => void createSlot()} disabled={!newSlotName.trim()}>New</button>
            </div>
            {qaErr && <div className="scan-err">{qaErr}</div>}
            <div className="scan-actions">
              <button className="btn outline" onClick={() => setQuickOpen(false)}>Cancel</button>
              <button className="btn" onClick={() => void submitQuickAdd()} disabled={qaAdding}>Add</button>
            </div>
          </div>
        </div>
      )}

      <ScanSheet open={barcodeOpen} onClose={() => setBarcodeOpen(false)} onCode={(code) => { void lookupBarcode(code); } } />
    </div>
  );
}
