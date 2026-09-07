/**
 * The per-meal "add food" affordance has to carry the day and slot it belongs
 * to. Without them, adding from a past day in History silently logged to today,
 * into whichever slot happened to be first.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { MealGroup } from '../MealGroup';
import type { SummaryGroup } from '../../lib/types';
import { todayISO } from '../../lib/format';

const group: SummaryGroup = {
  slot_id: 'slot-7',
  slot_name: 'Lunch',
  sort_order: 1,
  entries: [
    {
      id: 'e1',
      name: 'Soup',
      brand: '',
      grams: 300,
      kcal: 210,
      protein: 8,
      carbs: 20,
      fat: 9,
      logged_at: '2026-09-01T12:00:00Z',
      source: 'manual',
    },
  ],
};

function renderGroup(props: Partial<Parameters<typeof MealGroup>[0]> = {}) {
  return render(
    <MemoryRouter>
      <MealGroup group={group} {...props} />
    </MemoryRouter>,
  );
}

afterEach(() => cleanup());

describe('MealGroup — the add link carries its day and slot', () => {
  it('points at the given date and its own slot', () => {
    renderGroup({ date: '2026-09-01' });

    expect(screen.getByRole('link', { name: /add food/i })).toHaveAttribute(
      'href',
      '/add?date=2026-09-01&slot=slot-7',
    );
  });

  it('defaults to today when no date is given', () => {
    renderGroup();

    expect(screen.getByRole('link', { name: /add food/i })).toHaveAttribute(
      'href',
      `/add?date=${todayISO()}&slot=slot-7`,
    );
  });

  it('offers the same destination from an empty slot', async () => {
    const user = userEvent.setup();
    renderGroup({ group: { ...group, entries: [] }, date: '2026-09-01' });

    // An empty slot starts collapsed, so expand it to reach the add row.
    await user.click(screen.getByRole('button', { name: /Lunch/ }));

    const links = screen.getAllByRole('link');
    expect(links.some((l) => l.getAttribute('href') === '/add?date=2026-09-01&slot=slot-7')).toBe(true);
  });
});


describe('MealGroup — the entry actions menu', () => {
  it('is announced as a menu', async () => {
    const user = userEvent.setup();
    renderGroup({ onEdit: () => {}, onDelete: () => {} });

    const trigger = screen.getByRole('button', { name: /actions for soup/i });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await user.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem')).toHaveLength(2);
  });

  it('closes when the user clicks elsewhere', async () => {
    const user = userEvent.setup();
    renderGroup({ onEdit: () => {}, onDelete: () => {} });

    await user.click(screen.getByRole('button', { name: /actions for soup/i }));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await user.click(document.body);

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('closes on Escape and hands focus back to the trigger', async () => {
    const user = userEvent.setup();
    renderGroup({ onEdit: () => {}, onDelete: () => {} });

    const trigger = screen.getByRole('button', { name: /actions for soup/i });
    await user.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(trigger);
  });
});
