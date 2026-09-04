import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useApp } from '../state/AppContext';
import { getClient } from '../lib/pb';
import { saveRecipe, type IngredientDraft } from '../lib/recipes';
import { sumIngredients, perServing } from '../lib/nutrition';
import { formatInt } from '../lib/format';
import { Button, Card, Field, Sheet, Stepper, TextInput, useToast } from '../components/ui';

/** Create/edit a recipe: name, servings, an ingredient list, and live
 * total/per-serving totals. Ingredient sourcing (search vs. quick add) and
 * edit-mode loading are layered on in later commits — this file is the
 * create-only, quick-add-only scaffold. */

type DraftIngredient = IngredientDraft & { uid: string };

let uidCounter = 0;
function nextUid(): string {
  return `local-${uidCounter++}`;
}

export default function RecipeEditor() {
  const { id: routeId } = useParams();
  const isNew = !routeId || routeId === 'new';
  const { endpoint, userId } = useApp();
  const navigate = useNavigate();
  const toast = useToast();

  const [name, setName] = useState('');
  const [servings, setServings] = useState(1);
  const [ingredients, setIngredients] = useState<DraftIngredient[]>([]);
  const [originalIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const [addOpen, setAddOpen] = useState(false);
  const [addStage, setAddStage] = useState<'menu' | 'quick'>('menu');
  const [qaName, setQaName] = useState('');
  const [qaKcal, setQaKcal] = useState('');
  const [qaP, setQaP] = useState('');
  const [qaC, setQaC] = useState('');
  const [qaF, setQaF] = useState('');

  const totals = sumIngredients(ingredients);
  const perServingTotals = perServing(totals, servings || 1);

  const closeAddSheet = () => {
    setAddOpen(false);
    setAddStage('menu');
    setQaName('');
    setQaKcal('');
    setQaP('');
    setQaC('');
    setQaF('');
  };

  const addQuickIngredient = () => {
    const kcal = parseFloat(qaKcal);
    if (!qaName.trim() || !Number.isFinite(kcal)) return;
    const num = (s: string) => {
      const v = parseFloat(s);
      return Number.isFinite(v) ? v : 0;
    };
    setIngredients((prev) => [
      ...prev,
      {
        uid: nextUid(),
        food: null,
        name_snapshot: qaName.trim(),
        brand_snapshot: null,
        grams: 0,
        kcal,
        protein: num(qaP),
        carbs: num(qaC),
        fat: num(qaF),
        sort_order: prev.length,
      },
    ]);
    closeAddSheet();
  };

  const removeIngredient = (uid: string) => {
    setIngredients((prev) => prev.filter((i) => i.uid !== uid).map((i, idx) => ({ ...i, sort_order: idx })));
  };

  const save = async () => {
    if (!endpoint || !userId || !name.trim() || ingredients.length === 0) return;
    setSaving(true);
    try {
      const pb = getClient(endpoint);
      const id = await saveRecipe(
        pb,
        userId,
        isNew ? null : (routeId as string),
        { name: name.trim(), servings },
        ingredients.map(({ uid: _uid, ...rest }) => rest),
        originalIds,
      );
      toast(`Saved "${name.trim()}"`);
      navigate(`/recipes/${id}`);
    } catch (ex) {
      toast(ex instanceof Error ? ex.message : 'Could not save recipe', 'err');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pb-6">
      <div className="flex items-center justify-between px-6 pb-3 pt-4">
        <button
          className="flex h-9 w-9 flex-none items-center justify-center rounded-md border border-border bg-raised text-text"
          onClick={() => navigate('/recipes')}
          aria-label="Back"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <h2 className="text-xl font-bold tracking-[-.02em]">{isNew ? 'New recipe' : 'Edit recipe'}</h2>
        <span className="w-9" />
      </div>

      <div className="flex flex-col gap-3.5 px-6">
        <Field label="Name">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Chili" />
        </Field>

        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold">Servings</span>
          <Stepper value={servings} onChange={setServings} step={1} min={1} inputMode="numeric" aria-label="Servings" />
        </div>

        <Card>
          <div className="mb-2 flex items-baseline justify-between">
            <h3 className="text-md font-bold tracking-[-.01em]">Ingredients</h3>
            <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
              + Add ingredient
            </Button>
          </div>
          {ingredients.length === 0 ? (
            <p className="py-2 text-sm text-text-faint">No ingredients yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {ingredients.map((ing) => (
                <li key={ing.uid} className="flex items-center justify-between py-2.5">
                  <div>
                    <div className="text-sm font-semibold">{ing.name_snapshot}</div>
                    <div className="text-xs text-text-faint">{formatInt(ing.kcal)} kcal</div>
                  </div>
                  <button
                    className="flex h-8 w-8 items-center justify-center rounded-md border border-border text-danger"
                    aria-label={`Remove ${ing.name_snapshot}`}
                    onClick={() => removeIngredient(ing.uid)}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-semibold">Total</span>
            <span className="text-sm">{formatInt(totals.kcal)} kcal total</span>
          </div>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="text-sm font-semibold">Per serving</span>
            <span className="text-sm">{formatInt(perServingTotals.kcal)} kcal/serving</span>
          </div>
        </Card>

        <Button block loading={saving} disabled={!name.trim() || ingredients.length === 0} onClick={() => void save()}>
          Save recipe
        </Button>
      </div>

      <Sheet open={addOpen} onClose={closeAddSheet} title="Add ingredient">
        {addStage === 'menu' && (
          <div className="mt-2 flex flex-col gap-2.5">
            <Button variant="outline" onClick={() => setAddStage('quick')}>
              Quick add
            </Button>
          </div>
        )}
        {addStage === 'quick' && (
          <div className="mt-2 flex flex-col gap-2.5">
            <Field label="Ingredient name">
              <TextInput autoFocus value={qaName} onChange={(e) => setQaName(e.target.value)} placeholder="e.g. Homemade sauce" />
            </Field>
            <Field label="Calories (kcal)">
              <TextInput
                type="number"
                min={0}
                inputMode="numeric"
                value={qaKcal}
                onChange={(e) => setQaKcal(e.target.value.replace(/\D/g, ''))}
              />
            </Field>
            <div className="grid grid-cols-3 gap-2.5">
              <Field label="Protein (g)">
                <TextInput type="number" min={0} inputMode="decimal" value={qaP} onChange={(e) => setQaP(e.target.value.replace(/[^\d.]/g, ''))} />
              </Field>
              <Field label="Carbs (g)">
                <TextInput type="number" min={0} inputMode="decimal" value={qaC} onChange={(e) => setQaC(e.target.value.replace(/[^\d.]/g, ''))} />
              </Field>
              <Field label="Fat (g)">
                <TextInput type="number" min={0} inputMode="decimal" value={qaF} onChange={(e) => setQaF(e.target.value.replace(/[^\d.]/g, ''))} />
              </Field>
            </div>
            <div className="flex gap-2.5">
              <Button variant="outline" className="flex-1" onClick={closeAddSheet}>
                Cancel
              </Button>
              <Button className="flex-1" onClick={addQuickIngredient} disabled={!qaName.trim() || !qaKcal}>
                Add
              </Button>
            </div>
          </div>
        )}
      </Sheet>
    </div>
  );
}
