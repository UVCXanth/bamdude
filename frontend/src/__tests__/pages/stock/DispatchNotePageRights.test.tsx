/**
 * The dispatch note opens for any of three reads (WS-13 E13 O25), so its ways out are asked of
 * the reader too (O19): the stock's crumbs and «Back to the notes» only for a stock reader, the
 * order and the customer as links only for theirs — a link the section's route answers with a
 * silent bounce to «/» is a door that refuses without a word.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { render } from '../../utils';
import { ApiError, api } from '../../../api/client';
import type { DispatchNote, Permission } from '../../../api/client';
import { DispatchNotePage } from '../../../pages/stock/DispatchNotePage';

const auth = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('../../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../contexts/AuthContext')>();
  return {
    ...actual,
    useAuth: () => ({
      ...actual.useAuth(),
      hasPermission: (p: Permission) => auth.granted.has(p),
      hasAnyPermission: (...ps: Permission[]) => ps.some((p) => auth.granted.has(p)),
    }),
  };
});

const note: DispatchNote = {
  id: 42,
  code: 'DN-0042',
  created_at: '2026-09-28T09:30:00',
  project_id: 5,
  order_code: 'OR-0005',
  order_name: 'Hall lights',
  customer_id: 2,
  customer_name: 'ACME',
  units: 3,
  lines_count: 1,
  summary: [],
  recipient_name: 'Ivan',
  recipient_phone: '+380',
  delivery_method: 'Nova Poshta',
  delivery_details: 'Kyiv, branch 5',
  waybill: null,
  note: null,
  created_by_name: 'olena',
  supplier: { name: 'BamDude Workshop', address: 'Kyiv', phone: '', code: '1234', iban: '' },
  lines: [
    {
      position: 1,
      product_id: 1,
      product_name: 'Lamp',
      sku: null,
      configuration: { choices: [], changed_parts: [] },
      part_name: null,
      quantity: 3,
    },
  ],
};

function renderAt() {
  window.history.pushState({}, '', '/stock/dispatch-notes/42');
  return render(
    <Routes>
      <Route path="/stock/dispatch-notes/:id" element={<DispatchNotePage />} />
    </Routes>,
  );
}

const hrefs = () => [...document.querySelectorAll('a')].map((a) => a.getAttribute('href'));

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('DispatchNotePage — its ways out follow the reader', () => {
  it('a customers reader opens the note: no way into the stock or the order, the customer is a link', async () => {
    auth.granted = new Set(['customers:read']);
    vi.spyOn(api, 'getDispatchNote').mockResolvedValue(note);
    renderAt();
    await screen.findByTestId('dispatch-note-sheet');
    const links = hrefs();
    expect(links.some((h) => h?.startsWith('/stock'))).toBe(false);
    expect(links).not.toContain('/projects/5');
    expect(links).not.toContain('/products/1');
    expect(links).toContain('/customers/2');
    expect(screen.getByTestId('dispatch-note-subtitle')).toHaveTextContent('OR-0005');
  });

  it('a stock reader keeps the crumbs into the stock', async () => {
    auth.granted = new Set(['stock:read']);
    vi.spyOn(api, 'getDispatchNote').mockResolvedValue(note);
    renderAt();
    await screen.findByTestId('dispatch-note-sheet');
    expect(hrefs()).toEqual(expect.arrayContaining(['/stock', '/stock?tab=notes']));
  });

  it('a restricted note says why and goes back where the reader came from, not into the stock', async () => {
    auth.granted = new Set(['orders:read']);
    vi.spyOn(api, 'getDispatchNote').mockRejectedValue(
      new ApiError('Opening a dispatch note needs the customers’ read or the stock’s move right', 403, 'dispatch_note_restricted'),
    );
    window.history.pushState({}, '', '/projects/5');
    renderAt();
    expect(await screen.findByText(/needs the right to read customers or to move stock/)).toBeInTheDocument();
    expect(hrefs().some((h) => h?.startsWith('/stock'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await vi.waitFor(() => expect(window.location.pathname).toBe('/projects/5'));
  });
});
