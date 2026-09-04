/**
 * Regression test for: unsaved edits on the Profile screen (weight, formula)
 * get wiped out by background partial saves elsewhere on the same screen
 * (e.g. toggling the Goal segmented control), before the user ever presses
 * the main Save button.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import ProfileGoals from '../ProfileGoals';
import { AppProvider } from '../../state/AppContext';

const authRecord = { id: 'user-1' };

function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'profile-1',
    user: authRecord.id,
    height_cm: 180,
    birth_year: 1990,
    sex: 'male',
    activity_level: 'moderate',
    body_fat_pct: null,
    tdee_formula: 'mifflin',
    goal: 'maintain',
    protein_pct: 30,
    carbs_pct: 40,
    fat_pct: 30,
    theme_accent: '#0f7a5f',
    ...overrides,
  };
}

let profileRecord = makeProfile();

const fakePb = {
  baseUrl: 'http://localhost:8090',
  authStore: {
    isValid: true,
    record: authRecord,
    onChange: () => () => {},
  },
  collection: (name: string) => {
    if (name === 'profiles') {
      return {
        getFullList: async () => [{ ...profileRecord }],
        update: async (_id: string, data: Record<string, unknown>) => {
          profileRecord = { ...profileRecord, ...data };
          return { ...profileRecord };
        },
        create: async (data: Record<string, unknown>) => {
          profileRecord = makeProfile(data);
          return { ...profileRecord };
        },
      };
    }
    if (name === 'weights') {
      return {
        getList: async () => ({ items: [] }),
        create: async () => ({}),
      };
    }
    if (name === 'meal_slots') {
      return { getFullList: async () => [] };
    }
    throw new Error(`unexpected collection ${name}`);
  },
};

vi.mock('../../lib/pb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pb')>();
  return {
    ...actual,
    getClient: () => fakePb,
  };
});

function renderProfile() {
  return render(
    <MemoryRouter>
      <AppProvider>
        <ProfileGoals />
      </AppProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  localStorage.setItem('saolrian-endpoint', 'http://localhost:8090');
  profileRecord = makeProfile();
});

afterEach(() => {
  cleanup();
});

describe('ProfileGoals — unsaved edits survive background profile refreshes', () => {
  it('keeps an unsaved weight entry after toggling the goal (which autosaves + refreshes profile)', async () => {
    const user = userEvent.setup();
    renderProfile();

    const weightInput = await screen.findByLabelText(/Weight \(kg\)/i);
    await user.clear(weightInput);
    await user.type(weightInput, '82.5');
    expect(weightInput).toHaveValue(82.5);

    // Toggling Goal triggers saveGoalMacros() -> profiles.update() -> refreshProfile(),
    // which replaces the `profile` object reference in AppContext.
    await user.click(screen.getByRole('tab', { name: 'Lose' }));
    await waitFor(() => expect(profileRecord.goal).toBe('lose'));

    // The weight the user just typed (not yet saved via the main Save button)
    // must not be wiped out by that unrelated background refresh.
    expect(weightInput).toHaveValue(82.5);
  });

  it('keeps an unsaved formula change after toggling the goal', async () => {
    const user = userEvent.setup();
    renderProfile();

    const formulaSelect = await screen.findByLabelText('Formula');
    expect(formulaSelect).toHaveValue('mifflin');
    await user.selectOptions(formulaSelect, 'katch');
    expect(formulaSelect).toHaveValue('katch');

    await user.click(screen.getByRole('tab', { name: 'Lose' }));
    await waitFor(() => expect(profileRecord.goal).toBe('lose'));

    expect(formulaSelect).toHaveValue('katch');
  });
});
