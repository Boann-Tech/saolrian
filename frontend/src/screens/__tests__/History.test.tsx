import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import History from '../History';
import { AppProvider } from '../../state/AppContext';
import { ToastProvider } from '../../components/ui';
import { todayISO } from '../../lib/format';

const authRecord = { id: 'user-1' };

let metricRows: Record<string, unknown>[] = [];
let exerciseRows: Record<string, unknown>[] = [];
let exerciseQuery: { page?: number; perPage?: number; opts?: Record<string, unknown> } = {};

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
    groups: [],
    totals: { kcal: 0, protein: 0, carbs: 0, fat: 0 },
  }),
};

vi.mock('../../lib/pb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pb')>();
  return { ...actual, getClient: () => fakePb };
});

function renderHistory() {
  return render(
    <MemoryRouter>
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
