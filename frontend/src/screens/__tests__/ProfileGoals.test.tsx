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
    goal_rate: 0,
    water_goal_ml: 0,
    steps_goal: 0,
    protein_pct: 30,
    carbs_pct: 40,
    fat_pct: 30,
    theme_accent: '#0f7a5f',
    ...overrides,
  };
}

let profileRecord = makeProfile();
let weightItems: Array<Record<string, unknown>> = [];
const weightCreates: Array<Record<string, unknown>> = [];
const profileUpdates: Array<Record<string, unknown>> = [];

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
          profileUpdates.push(data);
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
        getList: async () => ({ items: weightItems }),
        create: async (data: Record<string, unknown>) => {
          weightCreates.push(data);
          return { ...data };
        },
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
  weightItems = [];
  weightCreates.length = 0;
  profileUpdates.length = 0;
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

describe('ProfileGoals — Weight field shows current weight', () => {
  it('pre-fills the Weight field with the latest weights record on load', async () => {
    weightItems = [{ kg: 78.4, measured_at: '2026-09-01T08:00:00Z' }];
    renderProfile();

    const weightInput = await screen.findByLabelText(/Weight \(kg\)/i);
    await waitFor(() => expect(weightInput).toHaveValue(78.4));
  });

  it('does not write a new weights record when the pre-filled value is unchanged', async () => {
    weightItems = [{ kg: 78.4, measured_at: '2026-09-01T08:00:00Z' }];
    const user = userEvent.setup();
    renderProfile();

    const weightInput = await screen.findByLabelText(/Weight \(kg\)/i);
    await waitFor(() => expect(weightInput).toHaveValue(78.4));

    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(profileUpdates.length).toBeGreaterThan(0));

    expect(weightCreates).toHaveLength(0);
  });

  it('writes a new weights record when the value is changed', async () => {
    weightItems = [{ kg: 78.4, measured_at: '2026-09-01T08:00:00Z' }];
    const user = userEvent.setup();
    renderProfile();

    const weightInput = await screen.findByLabelText(/Weight \(kg\)/i);
    await waitFor(() => expect(weightInput).toHaveValue(78.4));

    await user.clear(weightInput);
    await user.type(weightInput, '77.1');
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(weightCreates).toHaveLength(1));
    expect(weightCreates[0]).toMatchObject({ kg: 77.1 });
  });
});

describe('ProfileGoals — weekly rate drives the calorie target', () => {
  // BMR 10*80 + 6.25*180 - 5*36 + 5 = 1750; moderate x1.55 => TDEE 2712.5
  const targetText = () => screen.getByTestId('calorie-target').textContent ?? '';

  it('seeds the rate picker from the profile and applies it to the target', async () => {
    profileRecord = makeProfile({ goal: 'lose', goal_rate: -0.5 });
    weightItems = [{ kg: 80 }];
    renderProfile();

    // -0.5 kg/wk = -550 kcal/day => 2712.5 - 550 = 2162.5 -> 2,163
    await waitFor(() => expect(targetText()).toMatch(/2,163/));
    expect(screen.getByRole('radio', { name: '0.5 kg/wk' })).toBeChecked();
  });

  it('recomputes the target when a different rate is chosen', async () => {
    profileRecord = makeProfile({ goal: 'lose', goal_rate: -0.5 });
    weightItems = [{ kg: 80 }];
    const user = userEvent.setup();
    renderProfile();
    await waitFor(() => expect(targetText()).toMatch(/2,163/));

    await user.click(screen.getByRole('radio', { name: '1 kg/wk' }));

    // -1 kg/wk = -1100 kcal/day => 2712.5 - 1100 = 1612.5 -> 1,613
    await waitFor(() => expect(targetText()).toMatch(/1,613/));
  });

  it('persists the chosen rate as a signed value', async () => {
    profileRecord = makeProfile({ goal: 'lose', goal_rate: -0.5 });
    weightItems = [{ kg: 80 }];
    const user = userEvent.setup();
    renderProfile();
    await waitFor(() => expect(targetText()).toMatch(/2,163/));

    await user.click(screen.getByRole('radio', { name: '1 kg/wk' }));
    await waitFor(() => expect(profileRecord.goal_rate).toBe(-1));
  });

  it('hides the rate picker when maintaining', async () => {
    profileRecord = makeProfile({ goal: 'maintain', goal_rate: 0 });
    weightItems = [{ kg: 80 }];
    renderProfile();

    await waitFor(() => expect(targetText()).toMatch(/2,713/));
    expect(screen.queryByRole('radio', { name: /kg\/wk/ })).not.toBeInTheDocument();
  });

  it('warns when the chosen rate is capped by the calorie floor', async () => {
    profileRecord = makeProfile({ goal: 'lose', goal_rate: -1, sex: 'female', height_cm: 155, activity_level: 'sedentary' });
    weightItems = [{ kg: 50 }];
    renderProfile();

    expect(await screen.findByText(/capped/i)).toBeInTheDocument();
    await waitFor(() => expect(targetText()).toMatch(/1,200/));
  });
});

describe('ProfileGoals — daily goals', () => {
  it('seeds the water and step goals from the profile', async () => {
    profileRecord = makeProfile({ water_goal_ml: 3000, steps_goal: 12000 });
    renderProfile();

    await waitFor(() => expect(screen.getByLabelText(/Water goal/i)).toHaveValue(3000));
    expect(screen.getByLabelText(/Step goal/i)).toHaveValue(12000);
  });

  it('shows the defaults when the profile has none set', async () => {
    profileRecord = makeProfile();
    renderProfile();

    await waitFor(() => expect(screen.getByLabelText(/Water goal/i)).toHaveValue(2000));
    expect(screen.getByLabelText(/Step goal/i)).toHaveValue(10000);
  });

  it('saves an edited goal', async () => {
    // Distinct from the default so the edit can wait for the profile to land
    // rather than racing the initial seed.
    profileRecord = makeProfile({ water_goal_ml: 1800, steps_goal: 10000 });
    const user = userEvent.setup();
    renderProfile();

    const water = await screen.findByLabelText(/Water goal/i);
    await waitFor(() => expect(water).toHaveValue(1800));
    await user.clear(water);
    await user.type(water, '2500');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(profileRecord.water_goal_ml).toBe(2500));
  });
});

describe('ProfileGoals — Recipes link', () => {
  it('links to /recipes', async () => {
    renderProfile();
    const link = await screen.findByRole('link', { name: /^recipes$/i });
    expect(link).toHaveAttribute('href', '/recipes');
  });
});
