import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import History from '../History';
import { AppProvider } from '../../state/AppContext';
import { ToastProvider } from '../../components/ui';
import { addMonths, monthTitle, todayISO } from '../../lib/format';

const fullDayLabel = (iso: string) =>
  new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(iso + 'T12:00:00'));

const authRecord = { id: 'user-1' };

let metricRows: Record<string, unknown>[] = [];
let exerciseRows: Record<string, unknown>[] = [];
let exerciseQuery: { page?: number; perPage?: number; opts?: Record<string, unknown> } = {};
let summaryGroups: Record<string, unknown>[] = [];

const fakePb = {
  baseUrl: 'http://localhost:8090',
  authStore: { isValid: true, record: authRecord, onChange: () => () => {} },
  collection: (name: string) => {
    if (name === 'daily_metrics') return { getFullList: async () => metricRows };
    if (name === 'exercise_entries') {
      return {
        getList: async (page: number, perPage: number, opts: Record<string, unknown>) => {
          exerciseQuery = { page, perPage, opts };
          return { items: exerciseRows };
        },
      };
    }
    if (name === 'profiles') return { getFullList: async () => [] };
    if (name === 'weights') return { getList: async () => ({ items: [] }) };
    if (name === 'meal_slots') return { getFullList: async () => [] };
    throw new Error(`unexpected collection ${name}`);
  },
  send: async () => ({
    budget: 2000,
    tdee: 2200,
    goal: 'maintain',
    groups: summaryGroups,
    totals: { kcal: 0, protein: 0, carbs: 0, fat: 0 },
  }),
};

vi.mock('../../lib/pb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pb')>();
  return { ...actual, getClient: () => fakePb };
});

function renderHistory(route = '/history') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AppProvider>
        <ToastProvider>
          <History />
        </ToastProvider>
      </AppProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  localStorage.setItem('saolrian-endpoint', 'http://localhost:8090');
  metricRows = [];
  summaryGroups = [];
  exerciseRows = [];
  exerciseQuery = {};
});
afterEach(() => cleanup());

describe('History — imported exercise, sleep and body fat', () => {
  it('shows an empty state when nothing has been logged', async () => {
    renderHistory();
    expect(await screen.findByText(/No exercise logged yet/i)).toBeInTheDocument();
  });

  it('lists recent exercise entries with date, minutes and kcal', async () => {
    exerciseRows = [
      {
        id: 'x1',
        user: 'user-1',
        name: 'Cycling',
        minutes: 45,
        kcal: 412,
        logged_at: '2024-03-15 00:00:00.000Z',
        source: 'import',
      },
    ];
    renderHistory();
    expect(await screen.findByText('Cycling')).toBeInTheDocument();
    expect(screen.getByText(/Mar 15/)).toBeInTheDocument();
    expect(screen.getByText(/45 min/)).toBeInTheDocument();
    expect(screen.getByText('412')).toBeInTheDocument();
  });

  it('asks the server for the newest workouts first', async () => {
    renderHistory();
    await screen.findByText(/No exercise logged yet/i);
    expect(exerciseQuery.opts?.['sort']).toBe('-logged_at');
    expect(exerciseQuery.opts?.['filter']).toContain('user="user-1"');
  });

  it("shows the selected day's sleep hours and body fat", async () => {
    metricRows = [
      {
        id: 'm1',
        user: 'user-1',
        date: `${todayISO()} 00:00:00.000Z`,
        sleep_hours: 7.5,
        body_fat_pct: 22.4,
      },
    ];
    renderHistory();
    expect(await screen.findByText('Sleep')).toBeInTheDocument();
    expect(screen.getByText('7.5')).toBeInTheDocument();
    expect(screen.getByText('Body fat')).toBeInTheDocument();
    expect(screen.getByText('22.4')).toBeInTheDocument();
  });

  it('shows a dash when the day has no sleep or body-fat data', async () => {
    renderHistory();
    expect(await screen.findByText('Sleep')).toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(2);
  });
});

describe('History — month/year picker', () => {
  it('opens a calendar from the date button', async () => {
    renderHistory();
    const trigger = await screen.findByRole('button', {
      name: new RegExp(monthTitle(todayISO())),
    });
    await userEvent.click(trigger);
    expect(screen.getByRole('grid')).toBeInTheDocument();
  });

  it('loads the week ending on a date picked in the calendar', async () => {
    renderHistory();
    await screen.findByRole('button', { name: new RegExp(monthTitle(todayISO())) });

    await userEvent.click(
      screen.getByRole('button', { name: new RegExp(monthTitle(todayISO())) }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    await userEvent.click(screen.getByRole('button', { name: 'Previous month' }));

    const target = addMonths(todayISO(), -2).slice(0, 8) + '15';
    await userEvent.click(screen.getByRole('button', { name: fullDayLabel(target) }));

    // Calendar closes and the header now reflects the chosen month.
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
    await screen.findByRole('button', { name: new RegExp(monthTitle(target)) });
    // The selected-day summary card is scoped to the chosen day, not today.
    expect(
      within(await screen.findByTestId('day-summary')).getByText(/\b15\b/),
    ).toBeInTheDocument();
  });
});


describe('History — adding food lands on the day being viewed', () => {
  it('carries the selected day into the add link', async () => {
    // A slot with an entry renders expanded, so the add link is reachable.
    summaryGroups = [
      {
        slot_id: 'slot-7',
        slot_name: 'Lunch',
        sort_order: 1,
        entries: [
          {
            id: 'e1', name: 'Soup', brand: '', grams: 300, kcal: 210,
            protein: 8, carbs: 20, fat: 9,
            logged_at: '2026-09-01T12:00:00Z', source: 'manual',
          },
        ],
      },
    ];
    const user = userEvent.setup();
    renderHistory();

    // Pick the first day in the visible week rather than today.
    const strip = await screen.findByTestId('week-strip');
    const firstDay = within(strip).getAllByRole('button')[0];
    const iso = firstDay.getAttribute('data-date')!;
    await user.click(firstDay);

    const add = await screen.findByRole('link', { name: /add food/i });
    expect(add.getAttribute('href')).toContain(`date=${iso}`);
  });

  it('opens on the day named in the query string', async () => {
    renderHistory('/history?date=2026-08-12');

    // The day-summary card labels the selected day with the short format.
    expect(await screen.findByTestId('day-summary')).toHaveTextContent('Aug 12');
  });
});
