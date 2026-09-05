import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Trends from '../Trends';
import { AppProvider } from '../../state/AppContext';
import type { TrendsPayload } from '../../lib/types';

const authRecord = { id: 'user-1' };

function makePayload(nDays: number): TrendsPayload {
  const days = Array.from({ length: nDays }, (_, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    kcal: 2000, protein: 150, carbs: 200, fat: 60,
    entries: 3, logged: true, water_ml: 1500, steps: 8000, by_slot: {},
  }));
  return {
    range: { from: days[0].date, to: days.at(-1)!.date, days: nDays },
    days, weights: [], ema: [], budget: 2000, formula_tdee: 2200,
    goal: 'lose', goal_rate: -0.5, target_source: '', target_set_at: '',
    targets: { protein_g: 150, carbs_g: 200, fat_g: 60, water_ml: 2000, steps: 10000 },
    slots: [],
    estimate: {
      sufficient: false, reason: 'few_weigh_ins', window_days: 28, observed_tdee: 0,
      margin: 0, slope_kg_per_week: 0, mean_intake: 0, qualifying_days: nDays,
      weigh_ins: 0, span_days: 0, suggested_target: 0,
    },
  };
}

function freshProfileRecord(): Record<string, unknown> {
  return { id: 'p1', trend_cards: null };
}

// Reassigned (not mutated in place) so that a fresh object backs every test —
// later tasks write calorie_target / calorie_target_source /
// calorie_target_set_at into this same shared record, and resetting only
// trend_cards would leak those fields across tests.
let profileRecord: Record<string, unknown> = freshProfileRecord();

const fakePb = {
  baseUrl: 'http://localhost:8090',
  authStore: { isValid: true, record: authRecord, onChange: () => () => {} },
  collection: (name: string) => {
    if (name === 'profiles') {
      return {
        getFullList: async () => [profileRecord],
        update: async (_id: string, data: Record<string, unknown>) => {
          Object.assign(profileRecord, data);
          return profileRecord;
        },
      };
    }
    if (name === 'weights') return { getList: async () => ({ items: [] }) };
    if (name === 'meal_slots') return { getFullList: async () => [] };
    throw new Error(`unexpected collection ${name}`);
  },
};

vi.mock('../../lib/pb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pb')>();
  return { ...actual, getClient: () => fakePb };
});

const fetchTrendsMock = vi.fn();
vi.mock('../../lib/trends', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/trends')>();
  return { ...actual, fetchTrends: (...args: unknown[]) => fetchTrendsMock(...args) };
});

function renderTrends() {
  return render(
    <MemoryRouter>
      <AppProvider>
        <Trends />
      </AppProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  localStorage.setItem('saolrian-endpoint', 'http://localhost:8090');
});

afterEach(() => {
  cleanup();
  fetchTrendsMock.mockReset();
  // Reset the whole record, not just trend_cards — see comment above.
  profileRecord = freshProfileRecord();
});

describe('Trends', () => {
  // The always-in-DOM (aria-hidden when closed) Customise sheet lists every
  // card's title too, so title assertions target the accessible <h3> heading
  // each enabled Card renders, not raw text — role queries exclude the
  // aria-hidden sheet content by default, plain text queries would not.
  it('renders the five default cards when the profile has none stored', async () => {
    fetchTrendsMock.mockResolvedValue(makePayload(90));
    renderTrends();

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Weight trend' })).toBeTruthy());
    for (const title of ['Weight trend', 'Observed TDEE', 'Intake vs budget', 'Energy balance', 'Logging consistency']) {
      expect(screen.getByRole('heading', { name: title })).toBeTruthy();
    }
    // An off-by-default card must not appear.
    expect(screen.queryByRole('heading', { name: 'Weekday pattern' })).toBeNull();
  });

  it('honours the stored card selection and its order', async () => {
    profileRecord.trend_cards = ['intake', 'weight'];
    fetchTrendsMock.mockResolvedValue(makePayload(90));
    renderTrends();

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Intake vs budget' })).toBeTruthy());
    expect(screen.queryByRole('heading', { name: 'Energy balance' })).toBeNull();
  });

  it('shows a stub instead of a chart below the card minimum', async () => {
    // 10 days: below the 14-day floor for Observed TDEE (and also for Energy
    // balance, which shares that floor — scope to the TDEE card's own
    // section so the assertion targets that card specifically).
    fetchTrendsMock.mockResolvedValue(makePayload(10));
    renderTrends();

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Observed TDEE' })).toBeTruthy());
    const heading = screen.getByRole('heading', { name: 'Observed TDEE' });
    const section = heading.closest('section')!;
    expect(within(section).getByText(/needs 14 days/i)).toBeTruthy();
  });

  it('requests a different range when the selector changes', async () => {
    fetchTrendsMock.mockResolvedValue(makePayload(90));
    renderTrends();
    await waitFor(() => expect(fetchTrendsMock).toHaveBeenCalled());
    expect(fetchTrendsMock.mock.calls[0][1]).toBe(90);

    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: '30 days' }));

    await waitFor(() => expect(fetchTrendsMock.mock.calls.at(-1)?.[1]).toBe(30));
  });

  it('persists a toggled card to the profile', async () => {
    fetchTrendsMock.mockResolvedValue(makePayload(90));
    renderTrends();
    // Wait for the loaded cards list specifically (not just the always-in-DOM
    // Customise sheet, which lists every title regardless of load state).
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Weight trend' })).toBeTruthy());

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Customise' }));
    await user.click(screen.getByRole('checkbox', { name: /Macros/i }));

    await waitFor(() => expect(profileRecord.trend_cards).toContain('macros'));
  });
});
