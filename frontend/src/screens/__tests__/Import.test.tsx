import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Import from '../Import';
import { AppProvider } from '../../state/AppContext';
import { ToastProvider } from '../../components/ui';

const authRecord = { id: 'user-1' };

type JobRecord = { id: string; status: string; counts: Record<string, { imported: number; skipped: number }>; error?: string };
let subscribeCb: ((e: { record: JobRecord }) => void) | null = null;

const fakePb = {
  baseUrl: 'http://localhost:8090',
  authStore: { isValid: true, record: authRecord, onChange: () => () => {} },
  collection: (name: string) => {
    if (name === 'import_jobs') {
      return {
        subscribe: async (_id: string, cb: (e: { record: JobRecord }) => void) => {
          subscribeCb = cb;
          return async () => {};
        },
        unsubscribe: async () => {},
      };
    }
    if (name === 'meal_slots') return { getFullList: async () => [] };
    if (name === 'profiles') return { getFullList: async () => [] };
    if (name === 'weights') return { getList: async () => ({ items: [] }) };
    throw new Error(`unexpected collection ${name}`);
  },
  send: async (path: string) => {
    if (path === '/api/saolrian/import/loseit') return { job_id: 'job-1' };
    throw new Error(`unexpected send ${path}`);
  },
};

vi.mock('../../lib/pb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pb')>();
  return { ...actual, getClient: () => fakePb };
});

vi.mock('../../lib/push', () => ({ ensurePushSubscription: async () => false }));

vi.mock('../../lib/loseitZip', () => ({
  parseLoseItZip: async () => ({
    categories: {
      diary: [{ date: '2023-05-02', name: 'Toast', quantity: 1, unit: 'serving', meal: 'Breakfast', kcal: 200, protein_g: 5, carbs_g: 30, fat_g: 4 }],
    },
    previews: [{ key: 'diary', label: 'Food logs', count: 1, defaultSelected: true }],
  }),
}));

function renderImport() {
  return render(
    <MemoryRouter>
      <AppProvider>
        <ToastProvider>
          <Import />
        </ToastProvider>
      </AppProvider>
    </MemoryRouter>,
  );
}

describe('Import screen', () => {
  it('shows found categories, starts the job, and reports the result via realtime updates', async () => {
    renderImport();
    const user = userEvent.setup();

    const input = screen.getByLabelText('Upload Lose It export zip');
    const file = new File(['zip-bytes'], 'loseit-export.zip', { type: 'application/zip' });
    await user.upload(input, file);

    expect(await screen.findByText(/Food logs/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Import 1 selected/ }));

    await waitFor(() => expect(subscribeCb).not.toBeNull());
    subscribeCb!({ record: { id: 'job-1', status: 'done', counts: { diary: { imported: 1, skipped: 0 } } } });

    expect(await screen.findByText(/Imported 1, skipped 0/)).toBeInTheDocument();
  });
});
