import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp, saolrianSend } from '../state/AppContext';
import type { Food } from '../lib/types';
import { getClient, UnreachableError } from '../lib/pb';
import { createDiaryEntry } from '../lib/offline';
import { foodMath } from '../lib/nutrition';
import { normalizeSearch, normalizeBarcode } from '../lib/normalize';
import { formatInt } from '../lib/format';
import { Button, Empty, Field, Modal, Spinner, useToast } from '../components/ui';
import './addfood.css';

/** Add food: debounced search → detail with gram stepper + slot picker → diary create. */

type Stage = 'search' | 'detail';

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
  const [barcodeErr, setBarcodeErr] = useState('');
  const [newSlotName, setNewSlotName] = useState('');
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

  const lookupBarcode = async () => {
    const code = barcodeVal.trim();
    if (!/^\d{6,}$/.test(code)) {
      setBarcodeErr('Enter a numeric barcode (at least 6 digits).');
      return;
    }
    setBarcodeErr('');
    try {
      const pb = getClient(endpoint);
      const raw = await saolrianSend<unknown>(pb, 'GET', `/api/saolrian/food/barcode/${code}`);
      const food = normalizeBarcode(raw);
      if (!food) throw new Error('not found');
      setBarcodeOpen(false);
      setBarcodeVal('');
      openDetail(food);
    } catch (ex) {
      if (ex instanceof UnreachableError) setBarcodeErr('Server unreachable — try again when online.');
      else setBarcodeErr('No product found for that code.');
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
      <div className="addfood-searchrow">
        <input
          className="addfood-search"
          autoFocus
          placeholder="Search foods…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button variant="outline" size="md" onClick={() => setBarcodeOpen(true)} title="Barcode lookup">
          ⌗ Barcode
        </Button>
      </div>

      {stage === 'search' && (
        <div className="addfood-results">
          {searching && (
            <div className="addfood-status">
              <Spinner /> Searching…
            </div>
          )}
          {searchErr && <div className="addfood-err">{searchErr}</div>}
          {!searching && query.trim().length >= 2 && results.length === 0 && !searchErr && (
            <Empty>No foods match “{query.trim()}”.</Empty>
          )}
          {results.map((f, i) => (
            <button key={`${f.name}-${f.brand ?? ''}-${i}`} className="food-card" onClick={() => openDetail(f)}>
              <div className="food-card-main">
                <span className="food-card-name">{f.name}</span>
                <span className="food-card-sub">
                  {f.brand || 'Generic'}
                  {f.local ? ' · your food' : ''}
                </span>
              </div>
              <span className="food-card-kcal">
                {formatInt(f.kcal_per_100g)}
                <small> kcal/100g</small>
              </span>
            </button>
          ))}
          {query.trim().length < 2 && <Empty>Type at least 2 characters to search the food database.</Empty>}
        </div>
      )}

      {stage === 'detail' && selected && math && (
        <div className="addfood-detail">
          <button className="btn btn-ghost btn-sm" onClick={() => setStage('search')}>
            ← Back to search
          </button>
          <div className="detail-head">
            <h2>{selected.name}</h2>
            <p>
              {selected.brand || 'Generic'} · {formatInt(selected.kcal_per_100g)} kcal per 100 g
              {selected.barcode ? ` · ${selected.barcode}` : ''}
            </p>
          </div>

          <div className="stepper">
            <Button variant="outline" size="md" onClick={() => setGrams(Math.max(0, grams - 10))} aria-label="Less">
              −
            </Button>
            <div className="stepper-val">
              <input
                type="number"
                value={grams}
                min={0}
                step={10}
                onChange={(e) => setGrams(Math.max(0, Math.round(Number(e.target.value) || 0)))}
              />
              <span>g</span>
            </div>
            <Button variant="outline" size="md" onClick={() => setGrams(grams + 10)} aria-label="More">
              +
            </Button>
          </div>

          <div className="detail-macros">
            <div>
              <span className="dm-label">kcal</span>
              <span className="dm-val">{formatInt(math.kcal)}</span>
            </div>
            <div>
              <span className="dm-label">Protein</span>
              <span className="dm-val">{math.protein} g</span>
            </div>
            <div>
              <span className="dm-label">Carbs</span>
              <span className="dm-val">{math.carbs} g</span>
            </div>
            <div>
              <span className="dm-label">Fat</span>
              <span className="dm-val">{math.fat} g</span>
            </div>
          </div>

          <Field label="Meal slot">
            <div className="slot-pills">
              {slots.map((s) => (
                <button
                  key={s.id}
                  className={s.id === slotId ? 'slot-pill slot-pill-active' : 'slot-pill'}
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
              <Button size="sm" variant="outline" onClick={() => void createSlot()} disabled={!newSlotName.trim()}>
                New
              </Button>
            </div>
          </Field>

          <Button className="addfood-add" size="md" onClick={() => void addEntry()} disabled={adding || !slotId}>
            {adding ? 'Adding…' : `Add to diary · ${formatInt(math.kcal)} kcal`}
          </Button>
        </div>
      )}

      <Modal open={barcodeOpen} onClose={() => setBarcodeOpen(false)} title="Enter a barcode">
        <p className="barcode-hint">Type the digits printed under the barcode. Camera scanning arrives in v2.</p>
        <Field label="Barcode">
          <input
            autoFocus
            inputMode="numeric"
            pattern="[0-9]*"
            placeholder="e.g. 3017620422003"
            value={barcodeVal}
            onChange={(e) => setBarcodeVal(e.target.value.replace(/\D/g, ''))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void lookupBarcode();
            }}
          />
        </Field>
        {barcodeErr && <div className="addfood-err">{barcodeErr}</div>}
        <Button size="md" onClick={() => void lookupBarcode()}>
          Look up
        </Button>
      </Modal>
    </div>
  );
}
