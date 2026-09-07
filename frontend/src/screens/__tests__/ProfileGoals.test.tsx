/**
 * Regression test for: unsaved edits on the Profile screen (weight, formula)
 * get wiped out by background partial saves elsewhere on the same screen
 * (e.g. toggling the Goal segmented control), before the user ever presses
 * the main Save button.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import ProfileGoals from '../ProfileGoals';
import { AppProvider } from '../../state/AppContext';
import { HOSTED_ENDPOINT } from '../../lib/pb';

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
    units: 'metric',
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
let authCleared = false;
let slotEntryCount = 0;
let mealSlots: Record<string, unknown>[] = [];
const slotDeletes: string[] = [];
let weightItems: Array<Record<string, unknown>> = [];
const weightCreates: Array<Record<string, unknown>> = [];
const profileUpdates: Array<Record<string, unknown>> = [];

const fakePb = {
  baseUrl: 'http://localhost:8090',
  authStore: {
    isValid: true,
    record: authRecord,
    clear: () => {
      authCleared = true;
    },
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
    if (name === 'diary_entries') {
      return { getList: async () => ({ totalItems: slotEntryCount }) };
    }
    if (name === 'meal_slots') {
      return {
        getFullList: async () => mealSlots,
        update: async () => ({}),
        delete: async (id: string) => {
          slotDeletes.push(id);
          return {};
        },
      };
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
  authCleared = false;
  slotEntryCount = 0;
  slotDeletes.length = 0;
  mealSlots = [
    { id: 'slot-1', name: 'Breakfast', sort_order: 1, pct_allocation: 30 },
    { id: 'slot-2', name: 'Lunch', sort_order: 2, pct_allocation: 70 },
  ];
  weightItems = [];
  weightCreates.length = 0;
  profileUpdates.length = 0;
});

afterEach(() => {
  cleanup();
});

describe('ProfileGoals — one save model', () => {
  it('does not persist a goal change until Save is pressed', async () => {
    const user = userEvent.setup();
    renderProfile();

    await user.click(await screen.findByRole('radio', { name: 'Lose' }));

    // Nothing written yet — the explicit Save button owns every field.
    expect(profileUpdates).toHaveLength(0);
    expect(profileRecord.goal).toBe('maintain');
  });

  it('does not persist a macro edit until Save is pressed', async () => {
    const user = userEvent.setup();
    renderProfile();

    const protein = await screen.findByLabelText(/Protein %/i);
    await user.clear(protein);
    await user.type(protein, '35');

    expect(profileUpdates).toHaveLength(0);
  });

  it('writes every pending change in one save', async () => {
    const user = userEvent.setup();
    renderProfile();

    await user.click(await screen.findByRole('radio', { name: 'Lose' }));
    const height = screen.getByLabelText(/Height/i);
    await user.clear(height);
    await user.type(height, '176');

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(profileRecord.goal).toBe('lose'));
    expect(profileRecord.height_cm).toBe(176);
  });

  it('surfaces unsaved changes while they are pending', async () => {
    const user = userEvent.setup();
    renderProfile();

    expect(screen.queryByText(/unsaved changes/i)).not.toBeInTheDocument();

    await user.click(await screen.findByRole('radio', { name: 'Lose' }));

    expect(await screen.findByText(/unsaved changes/i)).toBeInTheDocument();
  });

  it('clears the unsaved marker once saved', async () => {
    const user = userEvent.setup();
    renderProfile();

    await user.click(await screen.findByRole('radio', { name: 'Lose' }));
    await screen.findByText(/unsaved changes/i);

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(screen.queryByText(/unsaved changes/i)).not.toBeInTheDocument());
  });

  it('keeps an unsaved edit when the profile record is refreshed underneath it', async () => {
    const user = userEvent.setup();
    renderProfile();

    const weightInput = await screen.findByLabelText(/Weight \(kg\)/i);
    await user.clear(weightInput);
    await user.type(weightInput, '82.5');

    // A save elsewhere on the screen refreshes `profile` in AppContext.
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(profileUpdates.length).toBeGreaterThan(0));

    expect(weightInput).toHaveValue(82.5);
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

  it('persists the chosen rate as a signed value when saved', async () => {
    profileRecord = makeProfile({ goal: 'lose', goal_rate: -0.5 });
    weightItems = [{ kg: 80 }];
    const user = userEvent.setup();
    renderProfile();
    await waitFor(() => expect(targetText()).toMatch(/2,163/));

    await user.click(screen.getByRole('radio', { name: '1 kg/wk' }));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

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

describe('ProfileGoals — removing a meal slot', () => {
  it('warns how much history the removal destroys', async () => {
    slotEntryCount = 12;
    const user = userEvent.setup();
    renderProfile();

    await user.click(await screen.findByRole('button', { name: /remove Lunch/i }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/12/);
    expect(dialog).toHaveTextContent(/all dates/i);
    expect(slotDeletes).toHaveLength(0);
  });

  it('deletes once confirmed', async () => {
    slotEntryCount = 12;
    const user = userEvent.setup();
    renderProfile();

    await user.click(await screen.findByRole('button', { name: /remove Lunch/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(slotDeletes).toEqual(['slot-2']));
  });

  it('skips the warning for an empty slot', async () => {
    slotEntryCount = 0;
    const user = userEvent.setup();
    renderProfile();

    await user.click(await screen.findByRole('button', { name: /remove Lunch/i }));

    await waitFor(() => expect(slotDeletes).toEqual(['slot-2']));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('ProfileGoals — units', () => {
  it('labels body metrics in the chosen system', async () => {
    profileRecord = makeProfile({ units: 'imperial' });
    weightItems = [{ kg: 80 }];
    renderProfile();

    // 80 kg is 176.4 lb; 180 cm is 5'11".
    await waitFor(() => expect(screen.getByLabelText(/Weight \(lb\)/i)).toHaveValue(176.4));
    expect(screen.getByLabelText('Height (feet)')).toHaveValue(5);
    expect(screen.getByLabelText('Height (inches)')).toHaveValue(11);
  });

  it('stores what was typed in pounds as kilograms', async () => {
    profileRecord = makeProfile({ units: 'imperial' });
    weightItems = [{ kg: 80 }];
    const user = userEvent.setup();
    renderProfile();

    const weight = await screen.findByLabelText(/Weight \(lb\)/i);
    await waitFor(() => expect(weight).toHaveValue(176.4));
    await user.clear(weight);
    await user.type(weight, '170');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    // 170 lb is 77.1 kg — the record stays metric.
    await waitFor(() => expect(weightCreates).toHaveLength(1));
    expect(Number(weightCreates[0]['kg'])).toBeCloseTo(77.1, 1);
  });

  it('stores a foot/inch height as centimetres', async () => {
    profileRecord = makeProfile({ units: 'imperial' });
    weightItems = [{ kg: 80 }];
    const user = userEvent.setup();
    renderProfile();

    const feet = await screen.findByLabelText('Height (feet)');
    await waitFor(() => expect(feet).toHaveValue(5));
    const inches = screen.getByLabelText('Height (inches)');
    await user.clear(inches);
    await user.type(inches, '9');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    // 5'9" is 175.26 cm.
    await waitFor(() => expect(Number(profileRecord.height_cm)).toBeCloseTo(175.26, 1));
  });

  it('keeps metric labels for a metric profile', async () => {
    profileRecord = makeProfile({ units: 'metric' });
    weightItems = [{ kg: 80 }];
    renderProfile();

    await waitFor(() => expect(screen.getByLabelText(/Weight \(kg\)/i)).toHaveValue(80));
    expect(screen.getByLabelText(/Height \(cm\)/i)).toHaveValue(180);
  });

  it('persists a switch of units', async () => {
    profileRecord = makeProfile({ units: 'metric' });
    weightItems = [{ kg: 80 }];
    const user = userEvent.setup();
    renderProfile();

    await user.click(await screen.findByRole('radio', { name: /imperial/i }));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(profileRecord.units).toBe('imperial'));
  });
});

describe('ProfileGoals — identity card', () => {
  it('calls a self-hosted server self-hosted', async () => {
    renderProfile();
    expect(await screen.findByText(/self-hosted/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Hosted ·/)).not.toBeInTheDocument();
  });

  it('names the host once, not twice', async () => {
    renderProfile();
    await screen.findByText(/self-hosted/i);
    expect(screen.getAllByText(/localhost:8090/)).toHaveLength(1);
  });

  it('calls the hosted tier hosted', async () => {
    localStorage.setItem('saolrian-endpoint', HOSTED_ENDPOINT);
    renderProfile();
    expect(await screen.findByText(/^Hosted$/i)).toBeInTheDocument();
  });
});

describe('ProfileGoals — signing out', () => {
  it('confirms before signing out', async () => {
    const user = userEvent.setup();
    renderProfile();

    await user.click(await screen.findByRole('button', { name: /sign out/i }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(authCleared).toBe(false);
  });

  it('signs out once confirmed', async () => {
    const user = userEvent.setup();
    renderProfile();

    await user.click(await screen.findByRole('button', { name: /sign out/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^sign out$/i }));

    await waitFor(() => expect(authCleared).toBe(true));
  });

  it('leaves the stored endpoint alone, so the next sign-in stays on this server', async () => {
    const user = userEvent.setup();
    renderProfile();

    await user.click(await screen.findByRole('button', { name: /sign out/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^sign out$/i }));

    await waitFor(() => expect(authCleared).toBe(true));
    expect(localStorage.getItem('saolrian-endpoint')).toBe('http://localhost:8090');
  });
});

describe('ProfileGoals — Recipes link', () => {
  it('links to /recipes', async () => {
    renderProfile();
    const link = await screen.findByRole('link', { name: /^recipes$/i });
    expect(link).toHaveAttribute('href', '/recipes');
  });
});
