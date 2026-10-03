/**
 * The position page over mocked API calls (WS-13 E12 F). The page reads `useParams`, so
 * the URL is set with pushState and the page is mounted under a matching `<Route>` inside
 * the helper's own BrowserRouter — as `CustomerPage.test.tsx` does.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Routes } from 'react-router';
import { http, HttpResponse } from 'msw';
import { render } from '../../utils';
import { server } from '../../mocks/server';
import { api, ApiError } from '../../../api/client';
import type { StockItemDetail } from '../../../api/client';
import { StockItemPage } from '../../../pages/stock/StockItemPage';
import { pipeDetail } from '../../components/stock/stockFixtures';

const routes = (
  <Routes>
    <Route path="/stock/:id" element={<StockItemPage />} />
  </Routes>
);
function renderPage() {
  render(routes);
}

const notFound = () => new ApiError('Stock position not found', 404);

/** A signed-in reader: `projects:read` only (as DeliveryMethodsModal.test.tsx). */
function asReader() {
  server.use(
    http.get('/api/v1/auth/me', () =>
      HttpResponse.json({
        id: 2,
        username: 'viewer',
        role: 'user',
        is_active: true,
        is_admin: false,
        groups: [{ id: 2, name: 'Viewers' }],
        permissions: ['projects:read'],
        created_at: '2024-01-01T00:00:00Z',
      }),
    ),
  );
}

afterEach(() => {
  window.history.pushState({}, '', '/');
});

describe('StockItemPage', () => {
  let journal: ReturnType<typeof vi.spyOn>;
  let getItem: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    window.history.pushState({}, '', '/stock/5');
    getItem = vi.spyOn(api, 'getStockItem').mockResolvedValue(pipeDetail);
    journal = vi
      .spyOn(api, 'getStockJournal')
      .mockResolvedValue({ items: [], next_cursor: null, meta: { total: 0, current_page: 1, per_page: 24, last_page: 1 } });
    vi.spyOn(api, 'getSettings').mockResolvedValue({ date_format: 'system' } as never);
  });

  describe('the header (F01)', () => {
    it('crumbs, the focusable name, the facts with the configuration in its accent, and «Open the product»', async () => {
      renderPage();
      const heading = await screen.findByRole('heading', { level: 1, name: 'Pipe' });
      expect(heading).toHaveAttribute('tabindex', '-1');
      expect(screen.getByRole('link', { name: 'Stock' })).toHaveAttribute('href', '/stock');
      const facts = screen.getByTestId('item-facts');
      expect(within(facts).getByText('PP-1')).toHaveClass('font-mono');
      expect(facts).toHaveTextContent('SK-0005');
      expect(within(facts).getByText('standard')).toHaveAttribute('data-config-accent');
      expect(facts).toHaveTextContent('location A-1');
      expect(screen.getByRole('link', { name: 'Open the product' })).toHaveAttribute('href', '/products/1');
    });

    it('«+ Receipt» is the primary; the menu holds «Stocktake» and «Open the product»', async () => {
      renderPage();
      await screen.findByRole('heading', { level: 1, name: 'Pipe' });
      fireEvent.click(screen.getByRole('button', { name: 'Receipt' }));
      expect(await screen.findByRole('dialog')).toBeInTheDocument();
      expect(screen.getByTestId('stock-move-submit')).toBeInTheDocument();
    });

    it('the menu: «Stocktake» opens its dialog, «Open the product» goes there', async () => {
      renderPage();
      await screen.findByRole('heading', { level: 1, name: 'Pipe' });
      fireEvent.click(screen.getByTestId('item-menu'));
      const panel = screen.getByTestId('item-menu-panel');
      expect(within(panel).getAllByRole('menuitem').map((m) => m.textContent?.trim())).toEqual(['Stocktake', 'Open the product']);
      fireEvent.click(within(panel).getByRole('menuitem', { name: 'Stocktake' }));
      expect(await screen.findByRole('dialog')).toBeInTheDocument();
    });

    it('a reader gets the menu with «Open the product» only — no receipt, no actions', async () => {
      asReader();
      renderPage();
      await screen.findByRole('heading', { level: 1, name: 'Pipe' });
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Receipt' })).toBeNull());
      expect(screen.queryByRole('button', { name: 'Issue' })).toBeNull();
      fireEvent.click(screen.getByTestId('item-menu'));
      expect(within(screen.getByTestId('item-menu-panel')).getAllByRole('menuitem').map((m) => m.textContent?.trim())).toEqual([
        'Open the product',
      ]);
    });
  });

  describe('the tiles (F02)', () => {
    it("in the mockup's words, the server's figures; «available» warns below the minimum", async () => {
      renderPage();
      const onHand = await screen.findByTestId('item-tile-on-hand');
      expect(onHand).toHaveTextContent('Actual stock');
      expect(onHand).toHaveTextContent('5');
      expect(onHand).toHaveTextContent('finished units of this configuration');
      expect(screen.getByTestId('item-tile-reserved')).toHaveTextContent('not available for a free issue');
      const available = screen.getByTestId('item-tile-available');
      expect(available).toHaveTextContent('on hand minus reserved');
      expect(within(available).getByText('3')).toHaveClass('text-status-warning');
      const min = screen.getByTestId('item-tile-min');
      expect(min).toHaveTextContent('Minimum stock');
      expect(min).toHaveTextContent('10');
      expect(min).toHaveTextContent('short by 7');
    });

    it('within the minimum says so; no minimum says «not set»', async () => {
      getItem.mockResolvedValue({ ...pipeDetail, below_min: false, short_by: 0, min_qty: 2 });
      renderPage();
      expect(await screen.findByTestId('item-tile-min')).toHaveTextContent('within the minimum');
    });

    it('a minimum of 0 is «not set»', async () => {
      getItem.mockResolvedValue({ ...pipeDetail, below_min: false, short_by: 0, min_qty: 0 });
      renderPage();
      const min = await screen.findByTestId('item-tile-min');
      expect(min).toHaveTextContent('—');
      expect(min).toHaveTextContent('not set');
    });
  });

  describe('the actions panel (F03)', () => {
    it('below the minimum: the heading and the text with the server’s numbers, and the five actions', async () => {
      renderPage();
      const panel = await screen.findByTestId('item-actions');
      expect(within(panel).getByRole('heading', { level: 3, name: 'Replenishment needed' })).toBeInTheDocument();
      expect(panel).toHaveTextContent('7 short of the minimum. 1 can be assembled from parts, the rest goes to print.');
      expect(within(panel).getAllByRole('button').map((b) => b.textContent?.trim())).toEqual([
        'Assemble from parts',
        'Reserve',
        'Release reservation',
        'Issue',
        'Location and minimum',
      ]);
    });

    it('within the minimum, and without one', async () => {
      getItem.mockResolvedValue({ ...pipeDetail, below_min: false, short_by: 0, min_qty: 2 });
      renderPage();
      const panel = await screen.findByTestId('item-actions');
      expect(within(panel).getByRole('heading', { level: 3, name: 'Stock within the minimum' })).toBeInTheDocument();
      expect(panel).toHaveTextContent('Free units can be issued or reserved.');
    });

    it('no minimum set', async () => {
      getItem.mockResolvedValue({ ...pipeDetail, below_min: false, short_by: 0, min_qty: 0 });
      renderPage();
      const panel = await screen.findByTestId('item-actions');
      expect(within(panel).getByRole('heading', { level: 3, name: 'No minimum set' })).toBeInTheDocument();
    });

    it('a greyed action says why, on screen and to a screen reader', async () => {
      getItem.mockResolvedValue({ ...pipeDetail, on_hand: 0, reserved: 0, available: 0, can_assemble: 0 });
      renderPage();
      const panel = await screen.findByTestId('item-actions');
      const reasons: Record<string, string> = {
        'Assemble from parts': 'Nothing can be assembled from the free parts of this configuration now',
        Reserve: 'Nothing is available to reserve',
        'Release reservation': 'Nothing is reserved',
        Issue: 'Nothing is on hand',
      };
      for (const [name, reason] of Object.entries(reasons)) {
        const button = within(panel).getByRole('button', { name });
        expect(button).toBeDisabled();
        expect(button).toHaveAccessibleDescription(reason);
        expect(within(panel).getByText(reason)).toBeVisible();
      }
      expect(within(panel).getByRole('button', { name: 'Location and minimum' })).toBeEnabled();
    });

    it('«Assemble from parts» opens the assembly of this position', async () => {
      vi.spyOn(api, 'getProduct').mockResolvedValue({ id: 1, name: 'Pipe', variant_groups: [] } as never);
      renderPage();
      const panel = await screen.findByTestId('item-actions');
      fireEvent.click(within(panel).getByRole('button', { name: 'Assemble from parts' }));
      expect(await screen.findByRole('dialog', { name: 'Assemble from parts' })).toBeInTheDocument();
    });
  });

  describe('the two cards (F04)', () => {
    it('in the mockup’s grid: two columns, one at 1100 and below', async () => {
      renderPage();
      const cards = await screen.findByTestId('item-cards');
      expect(cards.className).toContain('minmax(420px,1fr)');
      expect(cards.className).toContain('max-[1101px]:grid-cols-1');
    });

    it('reservations: an order’s code linked, or «without an order», each with its quantity', async () => {
      const withOrder: StockItemDetail = {
        ...pipeDetail,
        reservations: [
          { project_line_id: 3, project_id: 42, project_code: 'OR-0042', qty: 1 },
          { project_line_id: null, project_id: null, project_code: null, qty: 2 },
        ],
      };
      getItem.mockResolvedValue(withOrder);
      renderPage();
      const card = await screen.findByTestId('item-reservations');
      expect(within(card).getByRole('link', { name: 'OR-0042' })).toHaveAttribute('href', '/projects/42');
      expect(card).toHaveTextContent('OR-0042 — 1 pcs');
      expect(card).toHaveTextContent('Without an order — 2 pcs');
    });

    it('no reservations says so; the other configurations follow, linked, with what is available of what is on hand', async () => {
      getItem.mockResolvedValue({ ...pipeDetail, reservations: [] });
      renderPage();
      const card = await screen.findByTestId('item-reservations');
      expect(card).toHaveTextContent('No reservations.');
      expect(within(card).getByRole('heading', { level: 3, name: 'Other configurations of this product' })).toBeInTheDocument();
      expect(within(card).getByRole('link', { name: 'SK-0007 · Tail: angled' })).toHaveAttribute('href', '/stock/7');
      expect(card).toHaveTextContent('available 0 of 2');
    });

    it('no other configuration — no heading for one', async () => {
      getItem.mockResolvedValue({ ...pipeDetail, siblings: [] });
      renderPage();
      const card = await screen.findByTestId('item-reservations');
      expect(within(card).queryByText('Other configurations of this product')).toBeNull();
    });

    it('the free parts under this configuration: «part (× per)» → the shelf, amber when short; what can be assembled and the product card', async () => {
      getItem.mockResolvedValue({
        ...pipeDetail,
        parts: [
          { part_id: 11, name: 'flask', per: 1, on_shelf: 4 },
          { part_id: 12, name: 'tail', per: 2, on_shelf: 1 },
        ],
        can_assemble: 0,
      });
      renderPage();
      const card = await screen.findByTestId('item-parts');
      expect(within(card).getByRole('heading', { level: 3, name: 'Free parts for this configuration' })).toBeInTheDocument();
      expect(within(card).getByText('flask (× 1)')).toBeInTheDocument();
      expect(within(card).getByTestId('item-shelf-11')).toHaveTextContent('4');
      expect(within(card).getByTestId('item-shelf-11')).not.toHaveClass('text-status-warning');
      expect(within(card).getByTestId('item-shelf-12')).toHaveClass('text-status-warning');
      expect(card).toHaveTextContent('Can assemble: 0');
      expect(within(card).getByRole('link', { name: /product card/ })).toHaveAttribute('href', '/products/1');
    });
  });

  it('the journal of this position, under its own heading (F05)', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 2, name: 'Movement journal' })).toBeInTheDocument();
    await waitFor(() =>
      expect(journal).toHaveBeenLastCalledWith({ book: 'both', item_id: 5, page: 1, per_page: 24, sort_by: 'date-desc' }),
    );
  });

  describe('the states (F06)', () => {
    it('the first read is a skeleton', async () => {
      getItem.mockReturnValue(new Promise(() => {}) as never);
      renderPage();
      expect(await screen.findByTestId('item-skeleton')).toHaveAttribute('role', 'status');
    });

    it('a read that failed is said with a retry', async () => {
      getItem.mockRejectedValueOnce(new ApiError('HTTP 500', 500)).mockResolvedValue(pipeDetail);
      renderPage();
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Could not load this position');
      fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
      expect(await screen.findByRole('heading', { level: 1, name: 'Pipe' })).toBeInTheDocument();
    });

    it('a position that is gone says so, with the way back to the stock', async () => {
      getItem.mockRejectedValue(notFound());
      renderPage();
      expect(await screen.findByText('Position not found')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Back to stock' })).toHaveAttribute('href', '/stock');
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('a failed re-read keeps the position and says so once — no toast', async () => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      getItem.mockResolvedValueOnce(pipeDetail).mockRejectedValue(new ApiError('HTTP 500', 500));
      render(<QueryClientProvider client={client}>{routes}</QueryClientProvider>);
      await screen.findByRole('heading', { level: 1, name: 'Pipe' });
      await act(async () => {
        await client.refetchQueries({ queryKey: ['stock-item'] });
      });
      expect(await screen.findByText('Could not refresh')).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 1, name: 'Pipe' })).toBeInTheDocument();
      const meta = client.getQueryCache().findAll({ queryKey: ['stock-item'] }).map((q) => q.meta?.refreshToast);
      expect(meta.length).toBeGreaterThan(0);
      expect(meta.every((value) => !value)).toBe(true);
    });
  });
});
