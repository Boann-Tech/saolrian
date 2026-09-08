/**
 * Once an endpoint is stored, every route renders Auth — so if that endpoint
 * is wrong, Auth is the only screen the user will ever see. It has to say
 * which server it is talking to, offer a way off it, and offer a password
 * reset; otherwise a typo during onboarding is unrecoverable.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Auth from '../Auth';
import { AppProvider } from '../../state/AppContext';

const resetRequests: string[] = [];
let resetShouldFail = false;

const fakePb = {
  baseUrl: 'http://localhost:8090',
  authStore: { isValid: false, record: null, onChange: () => () => {} },
  collection: (name: string) => {
    if (name === 'users') {
      return {
        authWithPassword: async () => ({}),
        create: async () => ({}),
        requestPasswordReset: async (email: string) => {
          resetRequests.push(email);
          if (resetShouldFail) throw new Error('nope');
          return true;
        },
      };
    }
    if (name === 'profiles') return { getFullList: async () => [] };
    if (name === 'weights') return { getList: async () => ({ items: [] }) };
    if (name === 'meal_slots') return { getFullList: async () => [] };
    throw new Error(`unexpected collection ${name}`);
  },
};

vi.mock('../../lib/pb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pb')>();
  return { ...actual, getClient: () => fakePb };
});

function renderAuth() {
  return render(
    <AppProvider>
      <Auth />
    </AppProvider>,
  );
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  localStorage.setItem('saolrian-endpoint', 'https://saolrian.example.com');
  resetRequests.length = 0;
  resetShouldFail = false;
});
afterEach(() => cleanup());

describe('Auth — escaping a wrong endpoint', () => {
  it('names the server it is signing in to', async () => {
    renderAuth();
    expect(await screen.findByText(/saolrian\.example\.com/)).toBeInTheDocument();
  });

  it('lets the user go back and pick a different endpoint', async () => {
    const user = userEvent.setup();
    renderAuth();

    await user.click(screen.getByRole('button', { name: /change server/i }));

    await waitFor(() => expect(localStorage.getItem('saolrian-endpoint')).toBeNull());
  });
});

describe('Auth — password reset', () => {
  it('requests a reset for the address in the email field', async () => {
    const user = userEvent.setup();
    renderAuth();

    await user.type(screen.getByLabelText(/Email/i), 'sarah@example.com');
    await user.click(screen.getByRole('button', { name: /forgot/i }));

    await waitFor(() => expect(resetRequests).toEqual(['sarah@example.com']));
  });

  it('asks for an email first when the field is empty', async () => {
    const user = userEvent.setup();
    renderAuth();

    await user.click(screen.getByRole('button', { name: /forgot/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/email/i);
    expect(resetRequests).toHaveLength(0);
  });

  it('confirms without disclosing whether the account exists', async () => {
    const user = userEvent.setup();
    resetShouldFail = true;
    renderAuth();

    await user.type(screen.getByLabelText(/Email/i), 'nobody@example.com');
    await user.click(screen.getByRole('button', { name: /forgot/i }));

    // Same wording whether or not the address is registered.
    expect(await screen.findByText(/if that address has an account/i)).toBeInTheDocument();
  });
});

describe('Auth — password field', () => {
  it('describes the password rule on the input itself, not its wrapper', async () => {
    const user = userEvent.setup();
    renderAuth();
    await user.click(screen.getByRole('button', { name: /need an account/i }));

    expect(screen.getByLabelText(/^Password/i)).toHaveAccessibleDescription(/8 characters/i);
  });

  it('can reveal and re-hide the password', async () => {
    const user = userEvent.setup();
    renderAuth();

    const password = screen.getByLabelText(/^Password/i);
    expect(password).toHaveAttribute('type', 'password');

    await user.click(screen.getByRole('button', { name: /show password/i }));
    expect(password).toHaveAttribute('type', 'text');

    await user.click(screen.getByRole('button', { name: /hide password/i }));
    expect(password).toHaveAttribute('type', 'password');
  });
});
