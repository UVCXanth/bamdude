/**
 * The position page over mocked API calls. The page reads `useParams`, so the
 * URL is set with pushState and the page is mounted under a matching `<Route>`
 * inside the helper's own BrowserRouter — as `CustomerPage.test.tsx` does.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { render } from '../../utils';
import { api } from '../../../api/client';
import { StockItemPage } from '../../../pages/stock/StockItemPage';
import { pipeDetail } from '../../components/stock/stockFixtures';

function renderPage() {
  render(
    <Routes>
      <Route path="/stock/:id" element={<StockItemPage />} />
    </Routes>,
  );
}

afterEach(() => {
  window.history.pushState({}, '', '/');
});

describe('StockItemPage', () => {
  let journal: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.pushState({}, '', '/stock/5');
    vi.spyOn(api, 'getStockItem').mockResolvedValue(pipeDetail);
    journal = vi.spyOn(api, 'getStockJournal').mockResolvedValue({ items: [], next_cursor: null });
    vi.spyOn(api, 'getProducts').mockResolvedValue([]);
    vi.spyOn(api, 'getSettings').mockResolvedValue({ date_format: 'system' } as never);
  });

  it('draws the position: header, tiles and the replenishment strip', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Pipe' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Stock' })).toHaveAttribute('href', '/stock');
    expect(screen.getByText(/SK-0005/)).toBeInTheDocument();
    expect(screen.getByTestId('item-tile-on-hand')).toHaveTextContent('5');
    expect(screen.getByTestId('item-tile-available')).toHaveTextContent('3');
    expect(screen.getByTestId('item-tile-min')).toHaveTextContent('10');
    expect(screen.getByTestId('item-strip')).toHaveTextContent('Replenishment needed — short by 7');
  });

  it('lists the reservations, the other configurations and the parts under this one', async () => {
    renderPage();
    const reservations = await screen.findByTestId('item-reservations');
    expect(within(reservations).getByText('Without an order — 2')).toBeInTheDocument();
    const sibling = within(screen.getByTestId('item-siblings')).getByRole('link', { name: /SK-0007/ });
    expect(sibling).toHaveAttribute('href', '/stock/7');
    expect(within(screen.getByTestId('item-siblings')).getByText('Tail: angled')).toBeInTheDocument();
    const parts = screen.getByTestId('item-parts');
    expect(within(parts).getByText('flask')).toBeInTheDocument();
    expect(within(parts).getByText('can assemble 1')).toBeInTheDocument();
  });

  it('shows the journal of this position only', async () => {
    renderPage();
    await screen.findByTestId('item-reservations');
    await waitFor(() => expect(journal).toHaveBeenLastCalledWith({ book: 'both', item_id: 5, cursor: null, limit: 50 }));
  });

  it('opens a movement dialog from its actions', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Receipt' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('stock-move-submit')).toBeInTheDocument();
  });

  it('says so when the position is gone', async () => {
    vi.spyOn(api, 'getStockItem').mockRejectedValue(new Error('Stock position not found'));
    renderPage();
    expect(await screen.findByText(/could not load this position/i)).toBeInTheDocument();
  });
});
