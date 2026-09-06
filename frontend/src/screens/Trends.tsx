import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../state/AppContext';
import { getClient } from '../lib/pb';
import { fetchTrends, resolveCards, ALL_CARDS, type CardId } from '../lib/trends';
import type { TrendsPayload } from '../lib/types';
import { Button, Card, CardTitle, Segmented, Sheet, Spinner, useToast } from '../components/ui';
import { WeightCard } from './trends/cards/WeightCard';
import { TdeeCard } from './trends/cards/TdeeCard';
import { IntakeCard } from './trends/cards/IntakeCard';
import { BalanceCard } from './trends/cards/BalanceCard';
import { ConsistencyCard } from './trends/cards/ConsistencyCard';
import { MacrosCard } from './trends/cards/MacrosCard';
import { WeekdayCard } from './trends/cards/WeekdayCard';
import { MealsCard } from './trends/cards/MealsCard';
import { MetricCard } from './trends/cards/MetricCard';

type Range = '30' | '90' | '365';

/** Trends — a shell that maps over the user's enabled cards.
 *
 * Deliberately thin: every card owns its own file, so this screen never grows
 * into the 600-line problem AddFood.tsx has. */
export default function Trends() {
  const { endpoint } = useApp();
  const [range, setRange] = useState<Range>('90');
  const [data, setData] = useState<TrendsPayload | null>(null);
  const [cards, setCards] = useState<CardId[]>([]);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [customising, setCustomising] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    if (!endpoint) return;
    setLoading(true);
    const pb = getClient(endpoint);
    try {
      const [payload, profiles] = await Promise.all([
        fetchTrends(pb, Number(range)),
        pb.collection('profiles').getFullList(),
      ]);
      setData(payload);
      const profile = profiles[0] as Record<string, unknown> | undefined;
      setProfileId((profile?.id as string) ?? null);
      setCards(resolveCards(profile?.['trend_cards']));
    } catch (ex) {
      toast(ex instanceof Error ? ex.message : 'Could not load trends', 'err');
    } finally {
      setLoading(false);
    }
    // toast is stable from context; excluding it keeps this from re-running.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, range]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveCards = async (next: CardId[]) => {
    setCards(next);
    if (!endpoint || !profileId) return;
    try {
      await getClient(endpoint).collection('profiles').update(profileId, { trend_cards: next });
    } catch (ex) {
      toast(ex instanceof Error ? ex.message : 'Could not save your card choice', 'err');
    }
  };

  const toggle = (id: CardId) => {
    const next = cards.includes(id) ? cards.filter((c) => c !== id) : [...cards, id];
    void saveCards(next);
  };

  const loggedDays = data?.days.filter((d) => d.logged).length ?? 0;

  return (
    <div className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-bold tracking-[-.02em]">Trends</h2>
        <Button variant="ghost" onClick={() => setCustomising(true)}>
          Customise
        </Button>
      </div>

      <Segmented
        className="mb-4"
        aria-label="Date range"
        value={range}
        onChange={(v) => setRange(v)}
        options={[
          { value: '30', label: '30 days' },
          { value: '90', label: '90 days' },
          { value: '365', label: '1 year' },
        ]}
      />

      {loading && <Spinner />}

      {!loading && data && (
        <div className="flex flex-col gap-3">
          {cards.map((id) => {
            const meta = ALL_CARDS.find((c) => c.id === id);
            if (!meta) return null;
            return (
              <Card key={id} as="section">
                <CardTitle>{meta.title}</CardTitle>
                {loggedDays < meta.minDays ? (
                  <p className="text-sm text-text-faint">
                    Needs {meta.minDays} days of logging — you have {loggedDays}.
                  </p>
                ) : (
                  <CardBody id={id} data={data} onChanged={load} />
                )}
              </Card>
            );
          })}
        </div>
      )}

      <Sheet open={customising} onClose={() => setCustomising(false)} title="Customise trends">
        <div className="flex flex-col gap-2">
          {ALL_CARDS.map((c) => (
            <label key={c.id} className="flex items-start gap-3 rounded-md border border-border p-3">
              <input
                type="checkbox"
                className="mt-1"
                checked={cards.includes(c.id)}
                onChange={() => toggle(c.id)}
              />
              <span>
                <span className="block text-sm font-semibold">{c.title}</span>
                <span className="block text-xs text-text-faint">{c.blurb}</span>
              </span>
            </label>
          ))}
        </div>
      </Sheet>
    </div>
  );
}

function CardBody({ id, data, onChanged }: { id: CardId; data: TrendsPayload; onChanged: () => void }) {
  switch (id) {
    case 'weight':
      return <WeightCard data={data} />;
    case 'tdee':
      return <TdeeCard data={data} onAccepted={onChanged} />;
    case 'intake':
      return <IntakeCard data={data} />;
    case 'balance':
      return <BalanceCard data={data} />;
    case 'consistency':
      return <ConsistencyCard data={data} />;
    case 'macros':
      return <MacrosCard data={data} />;
    case 'weekday':
      return <WeekdayCard data={data} />;
    case 'meals':
      return <MealsCard data={data} />;
    case 'water':
      return <MetricCard data={data} metric="water" />;
    case 'steps':
      return <MetricCard data={data} metric="steps" />;
    default:
      return null;
  }
}
