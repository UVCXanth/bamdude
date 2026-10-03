/**
 * The stock journal (WS-13 E12 E): numbered pages of both ledgers, seven columns, the
 * filters in the URL on the tab — dependent ones in one write, a chosen product kept
 * until the current book's product list says it is not there — and, on a position page,
 * the ledger and the operation in memory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { render } from '../../utils';
import { api, STOCK_ITEM_KINDS, STOCK_REASONS } from '../../../api/client';
import en from '../../../i18n/locales/en';
import uk from '../../../i18n/locales/uk';
import type { StockJournalPage, StockJournalProduct, StockJournalRow } from '../../../api/client';
import { StockJournal } from '../../../components/stock/StockJournal';

const issue: StockJournalRow = {
  book: 'finished', id: 4, created_at: '2026-09-27T10:05:00', product_id: 1, product_name: 'Pipe',
  item: { id: 5, code: 'SK-0005', configuration: { choices: [], changed_parts: [] } },
  part_name: null, kind: 'issue', delta: 0, delta_on_hand: -2, delta_reserved: -2, note: null,
  customer: { id: 9, name: 'ACME' }, project: null, user: { id: 3, username: 'olena' },
};
const shelf: StockJournalRow = {
  book: 'parts', id: 8, created_at: '2026-09-27T09:00:00', product_id: 1, product_name: 'Pipe',
  item: { id: 5, code: 'SK-0005', configuration: { choices: [], changed_parts: [] } },
  part_name: 'flask', kind: 'manual', delta: 3, delta_on_hand: 0, delta_reserved: 0,
  note: 'counted_by_operator', customer: null, project: { id: 42, code: 'OR-0042', name: 'Order for Ivan' }, user: null,
};
const answer = (items: StockJournalRow[], total = items.length, current = 1): StockJournalPage => ({
  items,
  next_cursor: null,
  meta: { total, current_page: current, per_page: 24, last_page: Math.max(1, Math.ceil(total / 24)) },
});
const pipe: StockJournalProduct = { id: 1, code: 'PR-0001', name: 'Pipe' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const productSelect = () => screen.getByLabelText('Product') as HTMLSelectElement;

describe('StockJournal', () => {
  let get: ReturnType<typeof vi.spyOn>;
  let products: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    window.history.pushState({}, '', '/stock?tab=journal');
    get = vi.spyOn(api, 'getStockJournal').mockResolvedValue(answer([issue, shelf]));
    products = vi.spyOn(api, 'getStockJournalProducts').mockResolvedValue([pipe]);
    vi.spyOn(api, 'getSettings').mockResolvedValue({ date_format: 'system', time_format: '24h' } as never);
  });

  afterEach(() => {
    window.history.pushState({}, '', '/');
  });

  describe('the tab', () => {
    it('reads one numbered page of both ledgers, newest first — no «Show older»', async () => {
      render(<StockJournal />);
      await screen.findByTestId('journal-row-finished-4');
      expect(get).toHaveBeenLastCalledWith({ book: 'both', page: 1, per_page: 24, sort_by: 'date-desc' });
      expect(screen.getByText('Showing 1-2 of 2 movements')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /show older/i })).toBeNull();
      expect(screen.queryByText(/whole ledger/i)).toBeNull();
    });

    it("seven columns in the mockup's order, in the panel's own scroll; the date carries its time", async () => {
      render(<StockJournal />);
      const row = await screen.findByTestId('journal-row-finished-4');
      expect(screen.getByRole('region', { name: 'Movements' })).toContainElement(row);
      expect(
        screen.getAllByRole('columnheader').map((th) => (th.textContent ?? '').replace(/[▲▼]/g, '').trim()),
      ).toEqual(['Date', 'Product', 'What', 'Operation', 'Change', 'Order / dispatch note / note', 'Who']);
      expect(row.querySelector('td')?.textContent).toMatch(/\d{1,2}:\d{2}/);
    });

    it('the date header sorts on the server, and the sort lives in the URL', async () => {
      render(<StockJournal />);
      await screen.findByTestId('journal-row-finished-4');
      fireEvent.click(screen.getByRole('button', { name: /^Date/ }));
      await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ sort_by: 'date-asc', page: 1 })));
      expect(window.location.search).toContain('sort=date-asc');
    });

    it('a finished row names its position, a part row its product — linked only by the ids the answer carries', async () => {
      get.mockResolvedValue(answer([issue, shelf, { ...shelf, id: 9, product_id: null, item: null, project: null }]));
      render(<StockJournal />);
      const finished = await screen.findByTestId('journal-row-finished-4');
      const cells = finished.querySelectorAll('td');
      expect(within(cells[1] as HTMLElement).getByRole('link', { name: 'Pipe' })).toHaveAttribute('href', '/stock/5');
      expect(within(cells[2] as HTMLElement).getByRole('link', { name: 'SK-0005' })).toHaveAttribute('href', '/stock/5');
      const part = screen.getByTestId('journal-row-parts-8');
      expect(within(part.querySelectorAll('td')[1] as HTMLElement).getByRole('link', { name: 'Pipe' })).toHaveAttribute('href', '/products/1');
      expect(within(part).getByText('flask')).toBeInTheDocument();
      expect(within(part).getByText(/→/)).toHaveTextContent('→ SK-0005');
      // No ids in the answer, no links: the names as the server sent them.
      const bare = screen.getByTestId('journal-row-parts-9');
      expect(within(bare).queryAllByRole('link')).toHaveLength(0);
      expect(within(bare).getByText('Pipe')).toBeInTheDocument();
    });

    it('the change is signed and toned; a finished row says what its reservation did', async () => {
      render(<StockJournal />);
      const finished = await screen.findByTestId('journal-row-finished-4');
      expect(within(finished).getByText('−2')).toHaveClass('text-status-warning');
      expect(within(finished).getByText('reserve −2')).toBeInTheDocument();
      expect(within(screen.getByTestId('journal-row-parts-8')).getByText('+3')).toHaveClass('text-bambu-green');
    });

    it('the order, the dispatch note, the customer and the note — a server token translated', async () => {
      get.mockResolvedValue(answer([{ ...issue, issue: { id: 7, code: 'DN-0007' } }, shelf]));
      render(<StockJournal />);
      const finished = await screen.findByTestId('journal-row-finished-4');
      expect(within(finished).getByRole('link', { name: 'DN-0007' })).toHaveAttribute('href', '/stock/dispatch-notes/7');
      expect(within(finished).getByText('ACME')).toBeInTheDocument();
      const part = screen.getByTestId('journal-row-parts-8');
      expect(within(part).getByRole('link', { name: 'OR-0042' })).toHaveAttribute('href', '/projects/42');
      expect(within(part).getByText(/counted by the operator/)).toBeInTheDocument();
    });

    // Final review (declined, ruled a finding): E03 names the customer only without an order.
    it('the customer is named only without an order — the order already says whose it is', async () => {
      get.mockResolvedValue(answer([{ ...issue, project: { id: 42, code: 'OR-0042', name: 'Order for Ivan' } }]));
      render(<StockJournal />);
      const row = await screen.findByTestId('journal-row-finished-4');
      expect(within(row).getByRole('link', { name: 'OR-0042' })).toBeInTheDocument();
      expect(within(row).queryByText('ACME')).toBeNull();
    });

    it('a finished-goods note is shown as typed, even when it spells a server token', async () => {
      get.mockResolvedValue(answer([{ ...issue, note: 'assembled' }]));
      render(<StockJournal />);
      const row = await screen.findByTestId('journal-row-finished-4');
      expect(within(row).getByText('assembled')).toBeInTheDocument();
      expect(within(row).queryByText('assembled into a stock position')).not.toBeInTheDocument();
    });

    it('a new book is one write: the operation goes with it, the page goes back to 1', async () => {
      window.history.pushState({}, '', '/stock?tab=journal&kind=issue&page=3');
      render(<StockJournal />);
      await screen.findByTestId('journal-row-finished-4');
      fireEvent.change(screen.getByLabelText('Ledger'), { target: { value: 'finished' } });
      await waitFor(() =>
        expect(get).toHaveBeenLastCalledWith({ book: 'finished', page: 1, per_page: 24, sort_by: 'date-desc' }),
      );
      const search = new URLSearchParams(window.location.search);
      expect(search.get('tab')).toBe('journal');
      expect(search.get('book')).toBe('finished');
      expect(search.has('kind')).toBe(false);
      expect(search.has('page')).toBe(false);
    });

    it('the product list is the books’ own (ST2); a product is a URL filter that starts page 1', async () => {
      render(<StockJournal />);
      await screen.findByTestId('journal-row-finished-4');
      await waitFor(() => expect(products).toHaveBeenCalledWith('both'));
      await waitFor(() => expect(Array.from(productSelect().options).map((o) => o.textContent)).toEqual(['All products', 'Pipe']));
      fireEvent.change(productSelect(), { target: { value: '1' } });
      await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ product_id: 1, page: 1 })));
      expect(window.location.search).toContain('product=1');
    });

    it('a chosen product stays while the new book’s list is read, and goes only when that list says it is not there (R05)', async () => {
      window.history.pushState({}, '', '/stock?tab=journal&product=1');
      const parts = deferred<StockJournalProduct[]>();
      products.mockImplementation(async (book: string) => (book === 'parts' ? parts.promise : [pipe]));
      render(<StockJournal />);
      await screen.findByTestId('journal-row-finished-4');
      await waitFor(() => expect(productSelect().value).toBe('1'));
      fireEvent.change(screen.getByLabelText('Ledger'), { target: { value: 'parts' } });
      await waitFor(() => expect(products).toHaveBeenCalledWith('parts'));
      expect(productSelect().value).toBe('1');
      expect(productSelect().selectedOptions[0]).toHaveTextContent('Pipe');
      expect(window.location.search).toContain('product=1');
      expect(screen.getByText('Reading the products…')).toBeInTheDocument();
      parts.resolve([]);
      await waitFor(() => expect(window.location.search).not.toContain('product='));
      await waitFor(() => expect(productSelect().value).toBe(''));
    });

    it('a product list that failed keeps the chosen product, names it from the rows and offers a retry (R05)', async () => {
      window.history.pushState({}, '', '/stock?tab=journal&product=1');
      products.mockRejectedValueOnce(new Error('HTTP 500')).mockResolvedValue([pipe]);
      render(<StockJournal />);
      expect(await screen.findByText('Could not load the products')).toBeInTheDocument();
      expect(productSelect().value).toBe('1');
      expect(productSelect().selectedOptions[0]).toHaveTextContent('Pipe');
      expect(window.location.search).toContain('product=1');
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(screen.queryByText('Could not load the products')).toBeNull());
      expect(window.location.search).toContain('product=1');
    });

    it("A → B → A quickly: B's late answer never writes the address (R05)", async () => {
      window.history.pushState({}, '', '/stock?tab=journal&product=1');
      const parts = deferred<StockJournalProduct[]>();
      products.mockImplementation(async (book: string) => (book === 'parts' ? parts.promise : [pipe]));
      render(<StockJournal />);
      await waitFor(() => expect(productSelect().value).toBe('1'));
      fireEvent.change(screen.getByLabelText('Ledger'), { target: { value: 'parts' } });
      await waitFor(() => expect(products).toHaveBeenCalledWith('parts'));
      fireEvent.change(screen.getByLabelText('Ledger'), { target: { value: 'both' } });
      await waitFor(() => expect(window.location.search).not.toContain('book='));
      await act(async () => parts.resolve([]));
      expect(window.location.search).toContain('product=1');
      expect(productSelect().value).toBe('1');
    });

    it('a product nobody has named yet reads «product #id» until the list answers', async () => {
      window.history.pushState({}, '', '/stock?tab=journal&product=99');
      products.mockReturnValue(new Promise(() => {}) as never);
      get.mockResolvedValue(answer([]));
      render(<StockJournal />);
      await waitFor(() => expect(productSelect().selectedOptions[0]).toHaveTextContent('product #99'));
      expect(window.location.search).toContain('product=99');
    });

    it('a page past the end is normalised only by an answer of its own key', async () => {
      window.history.pushState({}, '', '/stock?tab=journal&page=5');
      get.mockResolvedValueOnce(answer([issue], 30, 5));
      render(<StockJournal />);
      await waitFor(() => expect(new URLSearchParams(window.location.search).get('page')).toBe('2'));
    });

    it('a page that failed stays where it is', async () => {
      window.history.pushState({}, '', '/stock?tab=journal&page=5');
      get.mockRejectedValue(new Error('HTTP 500'));
      render(<StockJournal />);
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Could not load the movements');
      expect(new URLSearchParams(window.location.search).get('page')).toBe('5');
    });

    it('the first read is a skeleton of the table', async () => {
      get.mockReturnValue(new Promise(() => {}) as never);
      render(<StockJournal />);
      expect(await screen.findByTestId('stock-skeleton')).toHaveAttribute('data-tab', 'journal');
    });

    it('nothing at all says «No movements yet»; nothing under a filter offers the reset', async () => {
      get.mockResolvedValue(answer([]));
      const { unmount } = render(<StockJournal />);
      expect(await screen.findByText('No movements yet')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Reset filters' })).toBeNull();
      unmount();
      window.history.pushState({}, '', '/stock?tab=journal&book=parts&kind=manual');
      render(<StockJournal />);
      expect(await screen.findByText('No movement matches these filters.')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
      await waitFor(() => expect(window.location.search).toBe('?tab=journal'));
    });
  });

  describe('a position page', () => {
    beforeEach(() => window.history.pushState({}, '', '/stock/5'));

    it('asks for that position only, in pages, with the ledger and the operation — no product, no URL', async () => {
      render(<StockJournal itemId={5} />);
      await screen.findByTestId('journal-row-finished-4');
      expect(get).toHaveBeenLastCalledWith({ book: 'both', item_id: 5, page: 1, per_page: 24, sort_by: 'date-desc' });
      expect(screen.queryByLabelText('Product')).toBeNull();
      expect(products).not.toHaveBeenCalled();
      fireEvent.change(screen.getByLabelText('Ledger'), { target: { value: 'finished' } });
      await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ book: 'finished', item_id: 5 })));
      fireEvent.change(screen.getByLabelText('Operation'), { target: { value: 'issue' } });
      await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ book: 'finished', kind: 'issue', item_id: 5 })));
      expect(window.location.search).toBe('');
    });

    it('another position starts on its first page and never shows the previous one’s rows', async () => {
      const next = deferred<StockJournalPage>();
      get.mockImplementation(async (params: { item_id?: number }) => (params.item_id === 7 ? next.promise : answer([issue])));
      const { rerender } = render(<StockJournal itemId={5} />);
      await screen.findByTestId('journal-row-finished-4');
      rerender(<StockJournal itemId={7} />);
      await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ item_id: 7, page: 1 })));
      expect(screen.queryByTestId('journal-row-finished-4')).toBeNull();
      next.resolve(answer([{ ...issue, id: 40 }]));
      expect(await screen.findByTestId('journal-row-finished-40')).toBeInTheDocument();
    });
  });
});

describe('the stock journal · every kind and reason has a label', () => {
  it('names each movement of both books in both languages', () => {
    // The backend's closed lists — models/finished_stock.py::MOVEMENT_KINDS and
    // services/part_stock.py::REASONS (spec workshop-order-issue, rules 5–6).
    expect([...STOCK_ITEM_KINDS]).toEqual([
      'receipt',
      'stocktake',
      'assembled',
      'produced',
      'reserve',
      'release',
      'issue',
      'written_off',
    ]);
    for (const bundle of [en, uk]) {
      for (const kind of STOCK_ITEM_KINDS) expect(bundle.stock.journal.kind[kind]).toBeTruthy();
      for (const reason of STOCK_REASONS) expect(bundle.stock.reason[reason]).toBeTruthy();
    }
  });
});
