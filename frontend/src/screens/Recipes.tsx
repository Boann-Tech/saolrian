import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApp } from '../state/AppContext';
import { getClient } from '../lib/pb';
import { listRecipes } from '../lib/recipes';
import type { Recipe } from '../lib/types';
import { formatInt } from '../lib/format';
import { Button, Empty, Spinner, useToast } from '../components/ui';

/** Recipes list — reached from Profile's "Recipes" link and AddFood's
 * "From recipe" stage. */
export default function Recipes() {
  const { endpoint, userId } = useApp();
  const navigate = useNavigate();
  const toast = useToast();
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!endpoint || !userId) return;
    let cancelled = false;
    (async () => {
      try {
        const recs = await listRecipes(getClient(endpoint), userId);
        if (!cancelled) setRecipes(recs);
      } catch (ex) {
        if (!cancelled) toast(ex instanceof Error ? ex.message : 'Could not load recipes', 'err');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, userId]);

  return (
    <div className="pb-6">
      <div className="flex items-center justify-between px-6 pb-3 pt-4">
        <button
          className="flex h-9 w-9 flex-none items-center justify-center rounded-md border border-border bg-raised text-text"
          onClick={() => navigate('/profile')}
          aria-label="Back"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <h2 className="text-xl font-bold tracking-[-.02em]">Recipes</h2>
        <span className="w-9" />
      </div>

      <div className="px-6">
        <Button block onClick={() => navigate('/recipes/new')}>
          + New recipe
        </Button>

        <div className="pt-4">
          {loading && (
            <div className="flex items-center gap-2 text-sm text-text-faint">
              <Spinner /> Loading…
            </div>
          )}
          {!loading && recipes.length === 0 && <Empty>No recipes yet — create one to get started.</Empty>}
          {!loading && recipes.length > 0 && (
            <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-raised shadow-card">
              {recipes.map((r) => (
                <Link key={r.id} to={`/recipes/${r.id}`} className="flex items-center justify-between p-3.5">
                  <div>
                    <div className="text-base font-semibold tracking-[-.01em]">{r.name}</div>
                    <div className="mt-0.5 text-xs text-text-faint">{r.servings} servings</div>
                  </div>
                  <div className="whitespace-nowrap text-base font-bold tracking-[-.01em]">
                    {formatInt(r.total_kcal / r.servings)}{' '}
                    <small className="text-2xs font-medium text-text-faint">kcal/serving</small>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
