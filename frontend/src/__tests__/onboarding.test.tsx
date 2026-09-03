/**
 * Onboarding flow test — runs with NO backend running.
 * Verifies: hosted choice shows connecting → friendly failure with
 * 'Change endpoint'; self-hosted URL validation; endpoint persistence on success.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach } from 'vitest';
import Onboarding from '../screens/Onboarding';
import { AppProvider } from '../state/AppContext';

vi.mock('../lib/pb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/pb')>();
  return {
    ...actual,
    probeEndpoint: vi.fn(async (url: string) => url.startsWith('http://localhost:9')),
  };
});

import { probeEndpoint } from '../lib/pb';

function renderOnboarding() {
  return render(
    <AppProvider>
      <Onboarding />
    </AppProvider>,
  );
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  vi.mocked(probeEndpoint).mockClear();
});

afterEach(() => {
  cleanup();
});

describe('Onboarding (no backend running)', () => {
  it('renders the choice screen on first run', () => {
    renderOnboarding();
    expect(screen.getByText('Saolrian')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Hosted/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Self-hosted/ })).toBeInTheDocument();
    expect(localStorage.getItem('saolrian-endpoint')).toBeNull();
  });

  it('shows connecting-then-failure for the unreachable hosted placeholder, with Change endpoint', async () => {
    const user = userEvent.setup();
    renderOnboarding();
    await user.click(screen.getByRole('button', { name: /^Hosted/ }));

    // Connecting state appears first
    expect(await screen.findByText(/Connecting to/i)).toBeInTheDocument();

    // Then the friendly failure with a recovery affordance
    await waitFor(
      () => expect(screen.getByText(/Couldn't reach/i)).toBeInTheDocument(),
      { timeout: 3000 },
    );
    expect(screen.getByRole('button', { name: /change endpoint/i })).toBeInTheDocument();
    // Endpoint must NOT have been persisted on failure
    expect(localStorage.getItem('saolrian-endpoint')).toBeNull();
  });

  it('rejects an invalid self-hosted URL without persisting', async () => {
    const user = userEvent.setup();
    renderOnboarding();
    await user.click(screen.getByRole('button', { name: /^Self-hosted/ }));
    await user.type(screen.getByRole('textbox'), 'not-a-url');
    fireEvent.submit(screen.getByRole('textbox').closest('form')!);
    expect(await screen.findByText(/valid URL/i)).toBeInTheDocument();
    expect(localStorage.getItem('saolrian-endpoint')).toBeNull();
    expect(probeEndpoint).not.toHaveBeenCalled();
  });

  it('persists a reachable self-hosted endpoint', async () => {
    const user = userEvent.setup();
    renderOnboarding();
    await user.click(screen.getByRole('button', { name: /^Self-hosted/ }));
    await user.type(screen.getByRole('textbox'), 'http://localhost:9999');
    fireEvent.submit(screen.getByRole('textbox').closest('form')!);
    await waitFor(() => expect(localStorage.getItem('saolrian-endpoint')).toBe('http://localhost:9999'));
  });

  it('Change endpoint returns to the choice screen', async () => {
    const user = userEvent.setup();
    renderOnboarding();
    await user.click(screen.getByRole('button', { name: /^Hosted/ }));
    await screen.findByText(/Couldn't reach/i);
    await user.click(screen.getByRole('button', { name: /change endpoint/i }));
    expect(await screen.findByText('Self-hosted')).toBeInTheDocument();
  });
});
