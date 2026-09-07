/**
 * The setup wizard's calorie preview must reflect the weekly rate the user
 * picks, and must agree with the budget the backend derives from goal_rate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Welcome from '../Welcome';
import { AppProvider } from '../../state/AppContext';

const authRecord = { id: 'user-1' };
const profileCreates: Record<string, unknown>[] = [];

const fakePb = {
  baseUrl: 'http://localhost:8090',
  authStore: { isValid: true, record: authRecord, onChange: () => () => {} },
  collection: (name: string) => {
    if (name === 'profiles') {
      return {
        getFullList: async () => [],
        create: async (data: Record<string, unknown>) => {
          profileCreates.push(data);
          return { id: 'profile-1', ...data };
        },
        update: async (_id: string, data: Record<string, unknown>) => {
          profileCreates.push(data);
          return data;
        },
      };
    }
    if (name === 'weights') return { getList: async () => ({ items: [] }), create: async () => ({}) };
    if (name === 'meal_slots') return { getFullList: async () => [] };
    if (name === 'users') return { update: async () => ({}) };
    throw new Error(`unexpected collection ${name}`);
  },
};

vi.mock('../../lib/pb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pb')>();
  return { ...actual, getClient: () => fakePb };
});

function renderWelcome() {
  return render(
    <MemoryRouter>
      <AppProvider>
        <Welcome />
      </AppProvider>
    </MemoryRouter>,
  );
}

/** Walk the wizard to the Goal step with a known body: BMR 1750, TDEE 2712.5. */
async function toGoalStep(user: ReturnType<typeof userEvent.setup>) {
  renderWelcome();
  await user.type(screen.getByLabelText(/What should we call you/i), 'Sarah');
  await user.click(screen.getByRole('button', { name: /continue/i }));

  await user.selectOptions(screen.getByLabelText('Sex'), 'male');
  await user.type(screen.getByLabelText(/Birth year/i), '1990');
  await user.type(screen.getByLabelText(/Height/i), '180');
  await user.type(screen.getByLabelText(/Weight/i), '80');
  await user.click(screen.getByRole('button', { name: /continue/i }));
}

const targetText = () => screen.getByTestId('calorie-target').textContent ?? '';

beforeEach(() => {
  cleanup();
  localStorage.clear();
  localStorage.setItem('saolrian-endpoint', 'http://localhost:8090');
  profileCreates.length = 0;
});
afterEach(() => cleanup());

describe('Welcome — the goal rate drives the previewed target', () => {
  it('applies the selected weekly rate to the previewed target', async () => {
    const user = userEvent.setup();
    await toGoalStep(user);

    await user.click(screen.getByRole('radio', { name: 'Lose' }));
    await user.click(await screen.findByRole('radio', { name: '1 kg/wk' }));

    // TDEE 2712.5 - (1 kg/wk => 1100/day) = 1612.5 -> 1,613
    await waitFor(() => expect(targetText()).toMatch(/1,613/));
  });

  it('shows the maintenance target with no rate applied', async () => {
    const user = userEvent.setup();
    await toGoalStep(user);

    await user.click(screen.getByRole('radio', { name: 'Maintain' }));
    await waitFor(() => expect(targetText()).toMatch(/2,713/));
  });

  it('saves the rate that was previewed', async () => {
    const user = userEvent.setup();
    await toGoalStep(user);

    await user.click(screen.getByRole('radio', { name: 'Lose' }));
    await user.click(await screen.findByRole('radio', { name: '0.25 kg/wk' }));
    await user.click(screen.getByRole('button', { name: /start tracking/i }));

    await waitFor(() => expect(profileCreates.length).toBeGreaterThan(0));
    expect(profileCreates.some((p) => p['goal_rate'] === -0.25)).toBe(true);
  });
});
