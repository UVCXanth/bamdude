/**
 * The product's movements (WS-13 E9 F03, R04, R12): both ledgers filtered to one product,
 * in numbered pages of 24, newest first — `['stock-journal-page', params]`, a plain query
 * beside the stock page's infinite one. A failed new page or book is an alert with a
 * retry that asks for THAT page or book — never the previous key's rows under the new
 * number; a failed re-read of a key that has its own answer keeps it under a note; the
 * last page is normalised only by an answer of its own key.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { render } from '../../../utils';
import { api } from '../../../../api/client';
import type { StockJournalPage, StockJournalParams, StockJournalRow } from '../../../../api/client';
import { ProductJournal } from '../../../../components/products/detail/ProductJournal';
import { STOCK_KEYS, ORDER_VIEW_KEYS } from '../../../../utils/queryInvalidation';

const handle = vi.hoisted(() => ({ client: null as QueryClient | null }));

function Capture() {
  const qc = useQueryClient();
  useEffect(() => {
    handle.client = qc;
  }, [qc]);
  return null;
}

function finished(id: number, over: Partial<StockJournalRow> = {}): StockJournalRow {
  return {
    book: 'finished',
    id,
    created_at: '2026-09-01T10:00:00',
    product_id: 7,
    product_name: 'Flask',
    item: {
      id: 3,
      code: 'SK-0003',
      configuration: {
        choices: [{ group_id: 1, group_name: 'Lid', option_id: 11, option_name: 'Cork', is_default: false }],
        changed_parts: [],
      },
    },
    kind: 'receipt',
    delta_on_hand: 2,
    delta_reserved: 0,
    ...over,
  } as StockJournalRow;
}

function part(id: number, name: string): StockJournalRow {
  return {
    book: 'parts',
    id,
    created_at: '2026-09-01T09:00:00',
    product_id: 7,
    product_name: 'Flask',
    item: null,
    kind: 'manual',
    part_name: name,
    delta: -1,
  } as StockJournalRow;
}

function page(items: StockJournalRow[], current = 1, last = 1, total = items.length): StockJournalPage {
  return { items, next_cursor: null, meta: { total, current_page: current, per_page: 24, last_page: last } };
}

const asked = (n: number) => vi.mocked(api.getStockJournal).mock.calls[n - 1]?.[0] as StockJournalParams;

describe('ProductJournal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getSettings').mockResolvedValue({ date_format: 'iso' } as never);
  });

  it('asks one product’s both ledgers, page 1 of 24, newest first — and no product picker', async () => {
    vi.spyOn(api, 'getStockJournal').mockResolvedValue(page([finished(1), part(2, 'Lid')]));
    const catalog = vi.spyOn(api, 'getProducts');
    render(<ProductJournal productId={7} />);
    await screen.findByTestId('journal-row-finished-1');
    expect(asked(1)).toEqual({ product_id: 7, book: 'both', page: 1, per_page: 24, sort_by: 'date-desc' });
    expect(screen.queryByLabelText(/product/i)).not.toBeInTheDocument();
    expect(catalog).not.toHaveBeenCalled();
  });

  it('the key joins the stock and order-view refreshes', () => {
    expect(STOCK_KEYS.some((k) => k[0] === 'stock-journal-page')).toBe(true);
    expect((ORDER_VIEW_KEYS as readonly string[]).includes('stock-journal-page')).toBe(true);
  });

  it('«What» tells finished units from parts — and there is no «Product» column', async () => {
    vi.spyOn(api, 'getStockJournal').mockResolvedValue(page([finished(1), part(2, 'Lid')]));
    render(<ProductJournal productId={7} />);
    const row = await screen.findByTestId('journal-row-finished-1');
    expect(row).toHaveTextContent('Finished · Lid: Cork');
    expect(within(row).getByRole('link', { name: 'SK-0003' })).toHaveAttribute('href', '/stock/3');
    expect(screen.getByTestId('journal-row-parts-2')).toHaveTextContent('Lid');
    expect(screen.queryByRole('columnheader', { name: 'Product' })).not.toBeInTheDocument();
  });

  it('a book is a segment, and choosing one goes back to page 1', async () => {
    vi.spyOn(api, 'getStockJournal').mockImplementation(async (p) => page([finished(p?.page ?? 1)], p?.page ?? 1, 3, 60));
    render(<ProductJournal productId={7} />);
    await screen.findByTestId('journal-row-finished-1');
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByTestId('journal-row-finished-2');
    fireEvent.click(screen.getByRole('button', { name: 'Parts' }));
    await waitFor(() => expect(api.getStockJournal).toHaveBeenLastCalledWith(expect.objectContaining({ book: 'parts', page: 1 })));
    expect(screen.getByRole('button', { name: 'Parts' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('R12 a failed next page shows no rows of the previous one, and the retry asks for that page', async () => {
    const get = vi
      .spyOn(api, 'getStockJournal')
      .mockResolvedValueOnce(page([finished(1)], 1, 2, 30))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(page([finished(2)], 2, 2, 30));
    render(<ProductJournal productId={7} />);
    await screen.findByTestId('journal-row-finished-1');
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the movements');
    expect(screen.queryByTestId('journal-row-finished-1')).not.toBeInTheDocument();
    expect(screen.queryByText(/page 1 of 2/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByTestId('journal-row-finished-2');
    expect(get.mock.calls[2][0]).toEqual(expect.objectContaining({ page: 2 }));
  });

  it('R12 a failed other book shows none of the first book’s rows', async () => {
    vi.spyOn(api, 'getStockJournal').mockResolvedValueOnce(page([finished(1)])).mockRejectedValueOnce(new Error('boom'));
    render(<ProductJournal productId={7} />);
    await screen.findByTestId('journal-row-finished-1');
    fireEvent.click(screen.getByRole('button', { name: 'Parts' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByTestId('journal-row-finished-1')).not.toBeInTheDocument();
  });

  it('R12 a failed re-read of the same page keeps its rows under a note', async () => {
    vi.spyOn(api, 'getStockJournal').mockResolvedValueOnce(page([finished(1)])).mockRejectedValue(new Error('boom'));
    render(
      <>
        <Capture />
        <ProductJournal productId={7} />
      </>,
    );
    await screen.findByTestId('journal-row-finished-1');
    await act(async () => {
      await handle.client!.invalidateQueries({ queryKey: ['stock-journal-page'] });
    });
    expect(await screen.findByText(/could not refresh/i)).toBeInTheDocument();
    expect(screen.getByTestId('journal-row-finished-1')).toBeInTheDocument();
  });

  it('R12 a failed re-read of an empty page keeps its empty text under a note', async () => {
    vi.spyOn(api, 'getStockJournal').mockResolvedValueOnce(page([])).mockRejectedValue(new Error('boom'));
    render(
      <>
        <Capture />
        <ProductJournal productId={7} />
      </>,
    );
    expect(await screen.findByText('No movements yet')).toBeInTheDocument();
    await act(async () => {
      await handle.client!.invalidateQueries({ queryKey: ['stock-journal-page'] });
    });
    expect(await screen.findByText(/could not refresh/i)).toBeInTheDocument();
    expect(screen.getByText('No movements yet')).toBeInTheDocument();
  });

  it('the last page is normalised by an answer of its own key', async () => {
    // Page 3 asked; the server says there are 2 now — the journal moves to page 2.
    const get = vi
      .spyOn(api, 'getStockJournal')
      .mockResolvedValueOnce(page([finished(1)], 1, 3, 60))
      .mockResolvedValueOnce(page([], 3, 2, 30))
      .mockResolvedValue(page([finished(2)], 2, 2, 30));
    render(<ProductJournal productId={7} />);
    await screen.findByTestId('journal-row-finished-1');
    fireEvent.click(screen.getByRole('button', { name: 'Last page' }));
    await screen.findByTestId('journal-row-finished-2');
    expect(get.mock.calls.map((c) => (c[0] as StockJournalParams).page)).toEqual([1, 3, 2]);
  });

  it('first read: skeleton rows', () => {
    vi.spyOn(api, 'getStockJournal').mockReturnValue(new Promise(() => {}));
    render(<ProductJournal productId={7} />);
    expect(screen.getByTestId('journal-skeleton')).toBeInTheDocument();
  });
});
